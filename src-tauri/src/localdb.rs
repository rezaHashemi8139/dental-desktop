//! The encrypted local database (SQLCipher). Patient data, the users of this
//! installation with their roles, and their working hours live here.

use std::io::Read as _;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

pub const DATABASE_FILE: &str = "clinic.db";

/// The first bytes of an unencrypted SQLite file. An encrypted file starts with random bytes.
const PLAIN_SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\0";
/// Every SQLite page size is a multiple of this, and the file is made of whole pages.
const MIN_PAGE_SIZE: u64 = 512;

/// Checks, without the key, that the database file looks usable: present,
/// readable, made of whole pages, and encrypted. Only opening it with the key
/// (at login) proves it fully.
pub fn check_file(path: &Path) -> Result<(), String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    if len == 0 || len % MIN_PAGE_SIZE != 0 {
        return Err(format!("{} has an invalid size ({len} bytes)", path.display()));
    }
    let mut header = [0u8; 16];
    file.read_exact(&mut header).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    if &header == PLAIN_SQLITE_HEADER {
        return Err(format!("{} is not encrypted", path.display()));
    }
    Ok(())
}

/// Roles stored locally. Permissions per role come later; the owner starts as manager.
pub const ROLE_MANAGER: &str = "manager";
pub const ROLE_STAFF: &str = "staff";

fn key_pragma(key: &[u8; 32]) -> String {
    // A raw 256-bit key in hex: SQLCipher skips its own key derivation.
    format!("x'{}'", hex::encode(key))
}

pub fn apply_key(conn: &Connection, key: &[u8; 32]) -> rusqlite::Result<()> {
    conn.pragma_update(None, "key", key_pragma(key))?;
    // SQLCipher only notices a wrong key when the database is first read.
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |row| row.get::<_, i64>(0))?;
    Ok(())
}

/// Opens an existing database. Fails if `key` is wrong.
pub fn open(path: &Path, key: &[u8; 32]) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    apply_key(&conn, key)?;
    migrate(&conn)?;
    Ok(conn)
}

/// Creates a new database encrypted with `key`.
pub fn create(path: &Path, key: &[u8; 32]) -> rusqlite::Result<Connection> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let conn = Connection::open(path)?;
    apply_key(&conn, key)?;
    migrate(&conn)?;
    Ok(conn)
}

/// Re-encrypts the whole database with `new_key`.
pub fn rekey(conn: &Connection, new_key: &[u8; 32]) -> rusqlite::Result<()> {
    conn.pragma_update(None, "rekey", key_pragma(new_key))
}

/// Runs `work` with the database at `path` attached as `name`, encrypted with
/// `key` (created if missing), and always detaches it afterwards.
fn with_attached<T>(
    conn: &Connection,
    path: &Path,
    name: &str,
    key: &[u8; 32],
    work: impl FnOnce() -> rusqlite::Result<T>,
) -> rusqlite::Result<T> {
    conn.execute(&format!("ATTACH DATABASE ?1 AS {name} KEY ?2"), params![path.to_string_lossy(), key_pragma(key)])?;
    let result = work();
    let detached = conn.execute(&format!("DETACH DATABASE {name}"), []);
    let value = result?;
    detached?;
    Ok(value)
}

/// Writes a copy of the open database to a new file at `path`, encrypted with `key`.
pub fn export_copy(conn: &Connection, path: &Path, key: &[u8; 32]) -> rusqlite::Result<()> {
    with_attached(conn, path, "copy", key, || {
        conn.query_row("SELECT sqlcipher_export('copy')", [], |_| Ok(()))?;
        // sqlcipher_export copies tables and data, not the schema version.
        let version = schema_version(conn, "main")?;
        conn.pragma_update(Some("copy"), "user_version", version)
    })
}

/// Replaces everything in the open database with the contents of the database
/// at `path` (encrypted with `key`, already migrated). Runs in one transaction:
/// if anything fails, the open database is left as it was.
pub fn replace_contents(conn: &Connection, path: &Path, key: &[u8; 32]) -> rusqlite::Result<()> {
    with_attached(conn, path, "source", key, || {
        let tx = conn.unchecked_transaction()?;
        let objects: Vec<(String, String)> = {
            let mut statement = tx.prepare(
                "SELECT type, name FROM main.sqlite_master
                 WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'",
            )?;
            let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        // Indexes and triggers go with their tables.
        for (kind, name) in &objects {
            tx.execute_batch(&format!("DROP {kind} main.\"{}\"", name.replace('"', "\"\"")))?;
        }
        tx.query_row("SELECT sqlcipher_export('main', 'source')", [], |_| Ok(()))?;
        let version = schema_version(&tx, "source")?;
        tx.pragma_update(Some("main"), "user_version", version)?;
        tx.commit()
    })
}

/// Adds the rows of the database at `path` (encrypted with `key`, already
/// migrated) to the open database. A row whose primary key (or another unique
/// value) is already here is skipped: what this database has wins. Runs in one
/// transaction: if anything fails, the open database is left as it was.
///
/// Rows are matched by primary key, so every table must use globally unique ids
/// (like the server's random user ids), never local counters.
pub fn merge_contents(conn: &Connection, path: &Path, key: &[u8; 32]) -> rusqlite::Result<()> {
    with_attached(conn, path, "source", key, || {
        let tx = conn.unchecked_transaction()?;
        // Rows that refer to each other may arrive in any order.
        tx.pragma_update(None, "defer_foreign_keys", true)?;
        for table in table_names(&tx, "source")? {
            // Only the columns both sides have (both are at the latest schema version anyway).
            let here = column_names(&tx, "main", &table)?;
            let columns: Vec<String> =
                column_names(&tx, "source", &table)?.into_iter().filter(|c| here.contains(c)).map(|c| quote(&c)).collect();
            if columns.is_empty() {
                continue;
            }
            let columns = columns.join(", ");
            let table = quote(&table);
            tx.execute(&format!("INSERT OR IGNORE INTO main.{table} ({columns}) SELECT {columns} FROM source.{table}"), [])?;
        }
        tx.commit()
    })
}

/// An SQL identifier in double quotes.
fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// The tables of `schema` ("main" or an attached database), without SQLite's own.
fn table_names(conn: &Connection, schema: &str) -> rusqlite::Result<Vec<String>> {
    let mut statement = conn.prepare(&format!(
        "SELECT name FROM {schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ))?;
    let rows = statement.query_map([], |row| row.get(0))?;
    rows.collect()
}

/// The columns of `table` in `schema`; empty if there is no such table.
fn column_names(conn: &Connection, schema: &str, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut statement = conn.prepare("SELECT name FROM pragma_table_info(?1, ?2)")?;
    let rows = statement.query_map([table, schema], |row| row.get(0))?;
    rows.collect()
}

/// Deletes every row of every table, keeping the schema and its version. Runs in
/// one transaction: if anything fails, nothing is deleted.
pub fn clear_contents(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    // Tables that refer to each other may be emptied in any order.
    tx.pragma_update(None, "defer_foreign_keys", true)?;
    for table in table_names(&tx, "main")? {
        tx.execute(&format!("DELETE FROM main.{}", quote(&table)), [])?;
    }
    tx.commit()
}

/// Rebuilds the database file without its free pages, so deleted data no longer
/// takes up space in it.
pub fn compact(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("VACUUM")
}

/// One schema change: SQL, or Rust code for what SQL cannot do alone.
enum Migration {
    Sql(&'static str),
    Code(fn(&Connection) -> rusqlite::Result<()>),
}

/// Schema changes, applied in order. PRAGMA user_version holds how many have run.
/// Every primary key must be globally unique (random ids, never local counters),
/// so a backup can be merged into another clinic database (`merge_contents`).
const MIGRATIONS: &[Migration] = &[
    // 1: users of this installation. Roles are kept only here, never on the server.
    Migration::Sql("CREATE TABLE users (
        id            BLOB PRIMARY KEY,   -- server user id (16 bytes)
        username      TEXT NOT NULL,
        full_name     TEXT NOT NULL DEFAULT '',
        role          TEXT NOT NULL,
        created_at    INTEGER NOT NULL,   -- unix seconds
        last_login_at INTEGER
    );"),
    // 2: patients and treatments, synced with the server (sync.rs), and where pulling stopped.
    // `sync_state` is one of the SYNC_* values below.
    Migration::Sql("CREATE TABLE patients (
        id            BLOB PRIMARY KEY,   -- derived from the identity (patients::patient_id), 16 bytes
        identity_type TEXT NOT NULL,      -- 'national' or 'foreign'
        identity      TEXT NOT NULL,      -- national ID, or a foreign national's FIDA code
        nationality   TEXT NOT NULL,      -- ISO 3166-1 alpha-2, 'IR' for national IDs
        first_name    TEXT NOT NULL,
        last_name     TEXT NOT NULL,
        birth_date    TEXT NOT NULL DEFAULT '',  -- Gregorian YYYY-MM-DD, or ''
        gender        TEXT NOT NULL DEFAULT '',  -- '', 'male' or 'female'
        phone         TEXT NOT NULL DEFAULT '',
        address       TEXT NOT NULL DEFAULT '',
        medical_notes TEXT NOT NULL DEFAULT '',
        created_at    INTEGER NOT NULL,   -- unix milliseconds
        updated_at    INTEGER NOT NULL,   -- unix milliseconds; the latest change wins when syncing
        sync_state    TEXT NOT NULL DEFAULT 'new'
    );
    CREATE UNIQUE INDEX patients_identity ON patients (identity_type, identity);
    CREATE TABLE treatments (
        id           BLOB PRIMARY KEY,    -- random, 16 bytes
        -- Not a foreign key: a pull may bring a treatment a page before its patient.
        patient_id   BLOB NOT NULL,
        performed_by BLOB,                -- server user id of who performed it, if given
        performed_at INTEGER NOT NULL,    -- unix milliseconds
        tooth        TEXT NOT NULL DEFAULT '',
        procedure    TEXT NOT NULL,
        notes        TEXT NOT NULL DEFAULT '',
        created_at   INTEGER NOT NULL,    -- unix milliseconds
        updated_at   INTEGER NOT NULL,    -- unix milliseconds; the latest change wins when syncing
        deleted_at   INTEGER,             -- kept as a tombstone until synced, so the deletion syncs too
        sync_state   TEXT NOT NULL DEFAULT 'new'
    );
    CREATE INDEX treatments_patient ON treatments (patient_id, performed_at);
    CREATE TABLE sync_cursors (
        scope    TEXT PRIMARY KEY,        -- what was pulled, e.g. 'clinic'
        revision INTEGER NOT NULL         -- PullResponse.revision of the last pull
    );"),
    // 3: people are identified by one code (person.rs); identity_type and nationality go.
    Migration::Code(identity_code),
    // 4: when the clinic's users came and left (work_hours.rs). Local only: never sent to the server.
    Migration::Sql("CREATE TABLE work_hours (
        id         BLOB PRIMARY KEY,      -- random, 16 bytes
        user_id    BLOB NOT NULL,         -- server user id (users.id) of who worked
        started_at INTEGER NOT NULL,      -- unix milliseconds: came in
        ended_at   INTEGER,               -- unix milliseconds: left; NULL while still at work
        created_at INTEGER NOT NULL,      -- unix milliseconds
        updated_at INTEGER NOT NULL       -- unix milliseconds
    );
    CREATE INDEX work_hours_user ON work_hours (user_id, started_at);"),
    // 5: a patient's optional email, synced like their phone ('' for none).
    Migration::Sql("ALTER TABLE patients ADD COLUMN email TEXT NOT NULL DEFAULT '';"),
    // 6: notes per day of working hours (work_hours.rs). Local only.
    Migration::Code(work_day_notes),
    // 7: payments received from patients and refunds paid back (payments.rs). Financial: local only.
    Migration::Sql("CREATE TABLE patient_payments (
        id          BLOB PRIMARY KEY,     -- random, 16 bytes
        patient_id  BLOB NOT NULL,        -- patients.id
        kind        TEXT NOT NULL,        -- 'payment' (received) or 'refund' (paid back)
        amount      REAL NOT NULL,        -- stored amount (src/i18n/currency.ts), always positive
        method      TEXT NOT NULL,        -- one of payments::METHODS
        paid_at     INTEGER NOT NULL,     -- unix milliseconds: when it was received or paid back
        reference   TEXT NOT NULL DEFAULT '',  -- tracking code, cheque number...; '' for none
        notes       TEXT NOT NULL DEFAULT '',
        recorded_by BLOB NOT NULL,        -- server user id (users.id) of who recorded it
        created_at  INTEGER NOT NULL,     -- unix milliseconds
        updated_at  INTEGER NOT NULL      -- unix milliseconds
    );
    CREATE INDEX patient_payments_patient ON patient_payments (patient_id, paid_at);"),
    // 8: users' birth dates, for birthdays on the home calendar: a copy of their accounts'
    // on the server, refreshed at every online login (auth.rs). Gregorian YYYY-MM-DD, or ''.
    Migration::Sql("ALTER TABLE users ADD COLUMN birth_date TEXT NOT NULL DEFAULT '';"),
    // 9: users' reminders on days of the home calendar, any number a day (reminders.rs). Local only.
    Migration::Sql("CREATE TABLE reminders (
        id         BLOB PRIMARY KEY,      -- random, 16 bytes
        user_id    BLOB NOT NULL,         -- server user id (users.id) of whose reminder it is
        day        TEXT NOT NULL,         -- local day, Gregorian YYYY-MM-DD
        text       TEXT NOT NULL,
        created_at INTEGER NOT NULL,      -- unix milliseconds
        updated_at INTEGER NOT NULL       -- unix milliseconds
    );
    CREATE INDEX reminders_user_day ON reminders (user_id, day);"),
];

/// Migration 6: the users' notes per day of working hours. An early build's
/// migration 4 gave each entry its own notes instead; that column goes, and the
/// table may already be here from another early build.
fn work_day_notes(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS work_day_notes (
            user_id    BLOB NOT NULL,         -- server user id (users.id)
            day        TEXT NOT NULL,         -- local day, Gregorian YYYY-MM-DD
            notes      TEXT NOT NULL,
            updated_at INTEGER NOT NULL,      -- unix milliseconds
            PRIMARY KEY (user_id, day)        -- the same anywhere: safe to merge (merge_contents)
        );",
    )?;
    if column_names(db, "main", "work_hours")?.iter().any(|c| c == "notes") {
        db.execute_batch("ALTER TABLE work_hours DROP COLUMN notes;")?;
    }
    Ok(())
}

/// Migration 3. Patient ids are now derived from the code alone (patients::patient_id),
/// so every patient gets its new id, and their treatments follow, the same as the
/// server's migration 00015_identity_code.sql. The server sends every patient and
/// treatment again under the new ids, which then meet the local ones. Codes are kept
/// as they were (a national ID stays its 10 digits).
fn identity_code(db: &Connection) -> rusqlite::Result<()> {
    let patients: Vec<(Vec<u8>, String)> = {
        let mut statement = db.prepare("SELECT id, identity FROM patients ORDER BY updated_at DESC")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let mut seen = std::collections::HashSet::new();
    for (old, code) in patients {
        let new = crate::patients::patient_id(&code);
        db.execute("UPDATE treatments SET patient_id = ?2 WHERE patient_id = ?1", params![old, new])?;
        if seen.insert(new) {
            db.execute("UPDATE patients SET id = ?2 WHERE id = ?1", params![old, new])?;
        } else {
            // The same code under both old types: one person now, the latest change kept.
            db.execute("DELETE FROM patients WHERE id = ?1", [old])?;
        }
    }
    db.execute_batch(
        // Refused patients were never stored by the server; the old rules (e.g. the
        // national ID check digit) may be why, so they are sent again.
        "UPDATE patients SET sync_state = 'new' WHERE sync_state = 'rejected';
         DROP INDEX patients_identity;
         ALTER TABLE patients DROP COLUMN identity_type;
         ALTER TABLE patients DROP COLUMN nationality;
         CREATE UNIQUE INDEX patients_identity ON patients (identity);",
    )
}

/// `sync_state` of a synced record that the server has never stored: new here, or
/// refused so far. A patient's identity may still change (see patients::save_patient).
pub const SYNC_NEW: &str = "new";
/// Changed here since the server last stored it: waits to be sent.
pub const SYNC_CHANGED: &str = "changed";
/// The same as on the server, as far as this computer knows.
pub const SYNC_SYNCED: &str = "synced";
/// The server refused it (PushResponse.rejected): not sent again until it is changed.
pub const SYNC_REJECTED: &str = "rejected";

/// Tables whose rows are sent to the server (sync.rs). Each has `updated_at` and `sync_state`.
pub const SYNCED_TABLES: &[&str] = &["patients", "treatments"];

/// Tables that never leave this computer: who may log in here and their roles,
/// sync bookkeeping, working hours, reminders, and **every financial table** (fees,
/// payments, balances, debts...). Financial data must never reach the server, so
/// a financial table always goes here, never in SYNCED_TABLES.
///
/// Every table must be in exactly one of the two lists; a test checks it, so a
/// new table cannot be added without deciding whether it is synced.
#[allow(dead_code)] // Read by the test that checks every table is classified.
pub const LOCAL_ONLY_TABLES: &[&str] =
    &["users", "sync_cursors", "work_hours", "work_day_notes", "patient_payments", "reminders"];

/// The schema version this app writes: how many migrations it has.
pub fn latest_schema_version() -> i64 {
    MIGRATIONS.len() as i64
}

/// How many migrations `schema` ("main" or an attached database) has had.
pub fn schema_version(conn: &Connection, schema: &str) -> rusqlite::Result<i64> {
    conn.pragma_query_value(Some(schema), "user_version", |row| row.get(0))
}

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let applied = schema_version(conn, "main")?;
    for (index, migration) in MIGRATIONS.iter().enumerate().skip(applied as usize) {
        let tx = conn.unchecked_transaction()?;
        match migration {
            Migration::Sql(sql) => tx.execute_batch(sql)?,
            Migration::Code(run) => run(&tx)?,
        }
        tx.pragma_update(None, "user_version", index as i64 + 1)?;
        tx.commit()?;
    }
    Ok(())
}

/// Records a login and returns the user's local role. New users get `default_role`.
pub fn record_login(
    conn: &Connection,
    user_id: &[u8],
    username: &str,
    full_name: &str,
    default_role: &str,
    now: i64,
) -> rusqlite::Result<String> {
    conn.execute(
        "INSERT INTO users (id, username, full_name, role, created_at, last_login_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT (id) DO UPDATE SET username = ?2, full_name = ?3, last_login_at = ?5",
        params![user_id, username, full_name, default_role, now],
    )?;
    conn.query_row("SELECT role FROM users WHERE id = ?1", [user_id], |row| row.get(0))
        .optional()
        .map(|role| role.unwrap_or_else(|| default_role.to_owned()))
}

/// A user who has logged in on this installation, sent to the frontend.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalUser {
    /// Server user id, 32 hex digits.
    pub id: String,
    pub username: String,
    pub full_name: String,
    /// Gregorian "YYYY-MM-DD", or empty if unknown.
    pub birth_date: String,
}

/// Adds a user created from this computer (members.rs) before they ever log in
/// here, so they can be picked at once (e.g. for working hours). A user already
/// here keeps their role; only their names are refreshed.
pub fn add_user(conn: &Connection, user_id: &[u8], username: &str, full_name: &str, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO users (id, username, full_name, role, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (id) DO UPDATE SET username = ?2, full_name = ?3",
        params![user_id, username, full_name, ROLE_STAFF, now],
    )?;
    Ok(())
}

/// Everyone who has logged in here (or was added from here), by name: who can
/// be picked as having performed a treatment, and whose names treatments show.
pub fn list_users(conn: &Connection) -> rusqlite::Result<Vec<LocalUser>> {
    let mut statement =
        conn.prepare("SELECT id, username, full_name, birth_date FROM users ORDER BY full_name, username")?;
    let rows = statement.query_map([], |row| {
        Ok(LocalUser {
            id: hex::encode(row.get::<_, Vec<u8>>(0)?),
            username: row.get(1)?,
            full_name: row.get(2)?,
            birth_date: row.get(3)?,
        })
    })?;
    rows.collect()
}

/// Copies birth dates from the server (server user id, Gregorian "YYYY-MM-DD" or
/// "") to the users already here; others are not added.
pub fn set_birth_dates(conn: &Connection, birth_dates: &[(Vec<u8>, String)]) -> rusqlite::Result<()> {
    let mut statement = conn.prepare("UPDATE users SET birth_date = ?2 WHERE id = ?1")?;
    for (user_id, birth_date) in birth_dates {
        statement.execute(params![user_id, birth_date])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_open_rekey() {
        let dir = std::env::temp_dir().join(format!("dental-localdb-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join(DATABASE_FILE);
        let (key1, key2) = ([1u8; 32], [2u8; 32]);

        let conn = create(&path, &key1).unwrap();
        assert_eq!(record_login(&conn, &[7; 16], "doctor", "Dr. A", ROLE_MANAGER, 100).unwrap(), ROLE_MANAGER);
        drop(conn);

        let raw = std::fs::read(&path).unwrap();
        assert!(!raw.starts_with(b"SQLite format 3"), "database file is not encrypted");
        assert!(open(&path, &key2).is_err(), "opened with the wrong key");

        let conn = open(&path, &key1).unwrap();
        rekey(&conn, &key2).unwrap();
        drop(conn);
        assert!(open(&path, &key1).is_err(), "old key still works after rekey");

        let conn = open(&path, &key2).unwrap();
        // The role stays as stored, even if a different default is passed later.
        assert_eq!(record_login(&conn, &[7; 16], "doctor", "Dr. A", ROLE_STAFF, 200).unwrap(), ROLE_MANAGER);
        let users = list_users(&conn).unwrap();
        let doctor = LocalUser {
            id: hex::encode([7; 16]),
            username: "doctor".into(),
            full_name: "Dr. A".into(),
            birth_date: String::new(),
        };
        assert_eq!(users, [doctor.clone()]);

        // Birth dates are copied only to users already here.
        set_birth_dates(&conn, &[(vec![7; 16], "1985-07-31".into()), (vec![8; 16], "1990-01-01".into())]).unwrap();
        assert_eq!(list_users(&conn).unwrap(), [LocalUser { birth_date: "1985-07-31".into(), ..doctor }]);
    }

    /// Reconnecting an offline session (auth::switch_online) rekeys the connection it keeps open.
    #[test]
    fn open_connection_keeps_working_after_rekey() {
        let dir = std::env::temp_dir().join(format!("dental-localdb-rekey-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join(DATABASE_FILE);
        let (key1, key2) = ([3u8; 32], [4u8; 32]);

        let conn = create(&path, &key1).unwrap();
        record_login(&conn, &[1; 16], "doctor", "Dr. A", ROLE_MANAGER, 100).unwrap();
        rekey(&conn, &key2).unwrap();
        // The same connection reads and writes on.
        record_login(&conn, &[2; 16], "nurse", "N. B", ROLE_STAFF, 200).unwrap();
        let count: i64 = conn.query_row("SELECT count(*) FROM users", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 2);

        // Meanwhile only the new key opens the file.
        assert!(open(&path, &key1).is_err());
        drop(open(&path, &key2).unwrap());
        drop(conn);
        let conn = open(&path, &key2).unwrap();
        let count: i64 = conn.query_row("SELECT count(*) FROM users", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 2);
    }

    fn user_names(conn: &Connection) -> Vec<String> {
        let mut statement = conn.prepare("SELECT username FROM users ORDER BY username").unwrap();
        statement.query_map([], |row| row.get(0)).unwrap().map(Result::unwrap).collect()
    }

    /// A backup copy (other key) replaces the contents of another open database in place.
    #[test]
    fn export_copy_and_replace_contents() {
        let dir = std::env::temp_dir().join(format!("dental-localdb-copy-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (key, copy_key, other_key) = ([6u8; 32], [7u8; 32], [8u8; 32]);

        let source = create(&dir.join("source.db"), &key).unwrap();
        record_login(&source, &[1; 16], "doctor", "Dr. A", ROLE_MANAGER, 100).unwrap();
        record_login(&source, &[2; 16], "nurse", "N. B", ROLE_STAFF, 100).unwrap();
        let copy_path = dir.join("copy.db");
        export_copy(&source, &copy_path, &copy_key).unwrap();
        assert!(open(&copy_path, &key).is_err(), "copy readable with the database key");
        let copy = open(&copy_path, &copy_key).unwrap();
        assert_eq!(schema_version(&copy, "main").unwrap(), latest_schema_version());
        assert_eq!(user_names(&copy), ["doctor", "nurse"]);
        drop(copy);

        // Another database, with other data and its own key, open as in a session.
        let target_path = dir.join("target.db");
        let target = create(&target_path, &other_key).unwrap();
        record_login(&target, &[3; 16], "someone", "S. C", ROLE_MANAGER, 100).unwrap();
        replace_contents(&target, &copy_path, &copy_key).unwrap();
        assert_eq!(user_names(&target), ["doctor", "nurse"]);
        assert_eq!(schema_version(&target, "main").unwrap(), latest_schema_version());
        drop(target);
        // Still encrypted with its own key only.
        assert_eq!(user_names(&open(&target_path, &other_key).unwrap()), ["doctor", "nurse"]);
        assert!(open(&target_path, &copy_key).is_err());

        // A failure (wrong key for the copy) leaves the open database untouched.
        let target = open(&target_path, &other_key).unwrap();
        assert!(replace_contents(&target, &copy_path, &key).is_err());
        assert_eq!(user_names(&target), ["doctor", "nurse"]);
    }

    /// Every table is either synced or local-only, and nothing that looks financial is synced.
    #[test]
    fn every_table_is_classified_for_sync() {
        let dir = std::env::temp_dir().join(format!("dental-localdb-classify-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let conn = create(&dir.join(DATABASE_FILE), &[9u8; 32]).unwrap();

        let mut tables = table_names(&conn, "main").unwrap();
        tables.sort();
        let mut classified: Vec<String> =
            SYNCED_TABLES.iter().chain(LOCAL_ONLY_TABLES).map(|t| t.to_string()).collect();
        classified.sort();
        assert_eq!(tables, classified, "add each new table to SYNCED_TABLES or LOCAL_ONLY_TABLES (financial: local only)");

        const FINANCIAL_WORDS: &[&str] =
            &["fee", "price", "cost", "amount", "payment", "paid", "balance", "debt", "invoice", "discount", "insurance", "money"];
        for table in SYNCED_TABLES {
            for column in column_names(&conn, "main", table).unwrap() {
                assert!(
                    !FINANCIAL_WORDS.iter().any(|word| column.contains(word)),
                    "{table}.{column} looks financial: financial data must stay in local-only tables"
                );
            }
            let columns = column_names(&conn, "main", table).unwrap();
            assert!(columns.contains(&"updated_at".to_string()) && columns.contains(&"sync_state".to_string()));
        }
    }

    /// Migration 3: patients get the ids the server gives them now, and their treatments follow.
    #[test]
    fn identity_code_migration_recomputes_patient_ids() {
        let dir = std::env::temp_dir().join(format!("dental-localdb-identity-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(dir.join(DATABASE_FILE)).unwrap();
        apply_key(&conn, &[10u8; 32]).unwrap();
        for migration in &MIGRATIONS[..2] {
            let Migration::Sql(sql) = migration else { unreachable!() };
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", 2).unwrap();

        // Under the old schema: a national ID, a FIDA code refused by the server, and
        // the same number once more under the other type (an older change).
        let patient = |id: u8, kind: &str, code: &str, nationality: &str, updated_at: i64, state: &str| {
            conn.execute(
                "INSERT INTO patients (id, identity_type, identity, nationality, first_name, last_name,
                    created_at, updated_at, sync_state)
                 VALUES (?1, ?2, ?3, ?4, 'A', 'B', 1, ?5, ?6)",
                params![[id; 16], kind, code, nationality, updated_at, state],
            )
            .unwrap();
        };
        patient(1, "national", "0012345679", "IR", 20, SYNC_SYNCED);
        patient(2, "foreign", "AB12345", "AF", 10, SYNC_REJECTED);
        patient(3, "foreign", "0012345679", "AF", 5, SYNC_NEW);
        for (treatment, patient) in [(7u8, 1u8), (8, 3)] {
            conn.execute(
                "INSERT INTO treatments (id, patient_id, performed_at, procedure, created_at, updated_at, sync_state)
                 VALUES (?1, ?2, 1, 'Filling', 1, 1, 'synced')",
                params![[treatment; 16], [patient; 16]],
            )
            .unwrap();
        }

        migrate(&conn).unwrap();
        assert_eq!(schema_version(&conn, "main").unwrap(), latest_schema_version());
        let national = crate::patients::patient_id("0012345679").to_vec();
        let foreign = crate::patients::patient_id("AB12345").to_vec();
        let mut statement = conn.prepare("SELECT id, sync_state FROM patients ORDER BY identity").unwrap();
        let rows: Vec<(Vec<u8>, String)> =
            statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).unwrap().map(Result::unwrap).collect();
        assert_eq!(rows, [(national.clone(), SYNC_SYNCED.to_owned()), (foreign, SYNC_NEW.to_owned())]);
        let treatment_patients: Vec<Vec<u8>> = conn
            .prepare("SELECT patient_id FROM treatments")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(treatment_patients, [national.clone(), national]);
        let columns = column_names(&conn, "main", "patients").unwrap();
        assert!(!columns.iter().any(|c| c == "identity_type" || c == "nationality"));
    }

    /// Migration 6 repairs a database that ran an early build's migration 4
    /// (notes per entry, no notes per day), and is harmless on a fresh one.
    #[test]
    fn work_day_notes_migration_repairs_early_builds() {
        let dir = std::env::temp_dir().join(format!("dental-localdb-day-notes-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(dir.join(DATABASE_FILE)).unwrap();
        apply_key(&conn, &[12u8; 32]).unwrap();
        for migration in &MIGRATIONS[..3] {
            match migration {
                Migration::Sql(sql) => conn.execute_batch(sql).unwrap(),
                Migration::Code(run) => run(&conn).unwrap(),
            }
        }
        // The early migration 4.
        conn.execute_batch(
            "CREATE TABLE work_hours (id BLOB PRIMARY KEY, user_id BLOB NOT NULL, started_at INTEGER NOT NULL,
                ended_at INTEGER, notes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             CREATE INDEX work_hours_user ON work_hours (user_id, started_at);
             INSERT INTO work_hours (id, user_id, started_at, ended_at, created_at, updated_at)
                VALUES (x'01', x'02', 10, 20, 1, 1);",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 4).unwrap();

        migrate(&conn).unwrap();
        assert_eq!(schema_version(&conn, "main").unwrap(), latest_schema_version());
        assert!(table_names(&conn, "main").unwrap().contains(&"work_day_notes".to_string()));
        assert!(!column_names(&conn, "main", "work_hours").unwrap().contains(&"notes".to_string()));
        let kept: i64 = conn.query_row("SELECT count(*) FROM work_hours", [], |row| row.get(0)).unwrap();
        assert_eq!(kept, 1, "entries are kept");

        // Running it again (e.g. a table already made by another early build) changes nothing.
        work_day_notes(&conn).unwrap();
    }

    #[test]
    fn check_file_without_key() {
        let dir = std::env::temp_dir().join(format!("dental-localdb-check-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join(DATABASE_FILE);

        assert!(check_file(&path).is_err(), "missing");
        drop(create(&path, &[5u8; 32]).unwrap());
        assert_eq!(check_file(&path), Ok(()));

        let mut truncated = std::fs::read(&path).unwrap();
        truncated.truncate(100);
        std::fs::write(&path, &truncated).unwrap();
        assert!(check_file(&path).is_err(), "truncated");

        std::fs::write(&path, [PLAIN_SQLITE_HEADER.as_slice(), &[0u8; 4096 - 16]].concat()).unwrap();
        assert!(check_file(&path).is_err(), "not encrypted");

        std::fs::write(&path, []).unwrap();
        assert!(check_file(&path).is_err(), "empty");
    }
}
