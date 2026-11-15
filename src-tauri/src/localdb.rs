//! The encrypted local database (SQLCipher). Patient data and the users of this
//! installation with their roles live here.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

pub const DATABASE_FILE: &str = "clinic.db";

/// Roles stored locally. Permissions per role come later; the owner starts as manager.
pub const ROLE_MANAGER: &str = "manager";
pub const ROLE_STAFF: &str = "staff";

fn key_pragma(key: &[u8; 32]) -> String {
    // A raw 256-bit key in hex: SQLCipher skips its own key derivation.
    format!("x'{}'", hex::encode(key))
}

fn apply_key(conn: &Connection, key: &[u8; 32]) -> rusqlite::Result<()> {
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

/// Schema changes, applied in order. PRAGMA user_version holds how many have run.
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
];

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let applied: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
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
}
