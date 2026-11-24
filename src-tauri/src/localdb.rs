//! The encrypted local database (SQLCipher). Patient data and the users of this
//! installation with their roles live here.

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

/// Schema changes, applied in order. PRAGMA user_version holds how many have run.
/// Every primary key must be globally unique (random ids, never local counters),
/// so a backup can be merged into another clinic database (`merge_contents`).
const MIGRATIONS: &[&str] = &[
    // 1: users of this installation. Roles are kept only here, never on the server.
    "CREATE TABLE users (
        id            BLOB PRIMARY KEY,   -- server user id (16 bytes)
        username      TEXT NOT NULL,
        full_name     TEXT NOT NULL DEFAULT '',
        role          TEXT NOT NULL,
        created_at    INTEGER NOT NULL,   -- unix seconds
        last_login_at INTEGER
    );",
    // 2: patients and treatments, synced with the server (sync.rs), and where pulling stopped.
    // `sync_state` is one of the SYNC_* values below.
    "CREATE TABLE patients (
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
    );",
];

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
/// sync bookkeeping, and **every financial table** (fees, payments, balances,
/// debts...). Financial data must never reach the server, so a financial table
/// always goes here, never in SYNCED_TABLES.
///
/// Every table must be in exactly one of the two lists; a test checks it, so a
/// new table cannot be added without deciding whether it is synced.
#[allow(dead_code)] // Read by the test that checks every table is classified.
pub const LOCAL_ONLY_TABLES: &[&str] = &["users", "sync_cursors"];

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
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(applied as usize) {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
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
