//! Encrypted backups of the clinic database (export to a file, restore from one),
//! and clearing it.
//!
//! A backup is locked with two secrets, and neither is stored anywhere (not in
//! the app, not on the server):
//! - a password the user chooses when exporting;
//! - a recovery key the app generates for each export and shows once.
//!
//! Both are needed to restore; without either, the backup cannot be opened.
//!
//! File layout: header || SQLCipher database. The header is MAGIC, the Argon2id
//! settings (3 × u32 little-endian) and a random salt. The database part is
//! encrypted with the raw key
//!   HKDF-SHA256(ikm = Argon2id(password, salt) || recovery key, salt = header, info = KEY_INFO).
//! The header is bound into the key, so a changed header only makes the key wrong.
//!
//! Only managers may export, restore or clear (`manager_session`).

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use hkdf::Hkdf;
use rusqlite::Connection;
use serde::Deserialize;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::auth::{Session, SessionInfo};
use crate::message::Message;
use crate::secure::{self, KdfParams, KDF_PARAMS, KEY_LEN, SALT_LEN};
use crate::{clock, localdb};

/// "Dental backup", format 1.
const MAGIC: &[u8; 8] = b"DNTLBK01";
const HEADER_LEN: usize = MAGIC.len() + 3 * 4 + SALT_LEN;
const KEY_INFO: &[u8] = b"dental/backup/v1";

/// 128 random bits, shown with a checksum so a mistyped key is told apart from a wrong one.
const RECOVERY_KEY_LEN: usize = 16;
const CHECKSUM_LEN: usize = 2;
/// Hex digits per group in the displayed recovery key.
const GROUP_LEN: usize = 4;

/// Work files in the app data folder, encrypted with the backup key, deleted when done.
const EXPORT_WORK_FILE: &str = "backup-export.tmp";
const RESTORE_WORK_FILE: &str = "backup-restore.tmp";

/// Same rules as a new account password (src/auth/schemas.ts).
const MIN_PASSWORD_CHARS: usize = 8;

fn err(key: &str) -> Message {
    Message::new(key)
}

fn internal(details: impl std::fmt::Display) -> Message {
    Message::error("errors.unknown", details)
}

fn file_error(details: impl std::fmt::Display) -> Message {
    Message::error("errors.fileSystem", details)
}

/// The open session, if its user may export, restore or clear the database (managers only).
pub fn manager_session(session: Option<&Session>) -> Result<&Session, Message> {
    session.filter(|s| s.info.role == localdb::ROLE_MANAGER).ok_or_else(|| err("database.errors.notAllowed"))
}

// ---------------------------------------------------------------------------
// Recovery key

/// The key as shown to the user: key || checksum in uppercase hex, in groups of 4
/// joined by dashes (9 groups).
fn format_recovery_key(key: &[u8; RECOVERY_KEY_LEN]) -> String {
    let checksum = &secure::sha256(key)[..CHECKSUM_LEN];
    let digits = hex::encode_upper([key.as_slice(), checksum].concat());
    digits.as_bytes().chunks(GROUP_LEN).map(|group| std::str::from_utf8(group).unwrap()).collect::<Vec<_>>().join("-")
}

/// Reads a recovery key as typed: case, spaces and dashes don't matter. None if
/// it is malformed or its checksum doesn't match (a typo).
fn parse_recovery_key(text: &str) -> Option<Zeroizing<[u8; RECOVERY_KEY_LEN]>> {
    let digits: Zeroizing<String> =
        Zeroizing::new(text.chars().filter(|c| !c.is_whitespace() && *c != '-').collect());
    let bytes = Zeroizing::new(hex::decode(digits.as_str()).ok()?);
    if bytes.len() != RECOVERY_KEY_LEN + CHECKSUM_LEN {
        return None;
    }
    let (key, checksum) = bytes.split_at(RECOVERY_KEY_LEN);
    if secure::sha256(key)[..CHECKSUM_LEN] != *checksum {
        return None;
    }
    let mut out = Zeroizing::new([0u8; RECOVERY_KEY_LEN]);
    out.copy_from_slice(key);
    Some(out)
}

// ---------------------------------------------------------------------------
// Header and key

struct Header {
    kdf: KdfParams,
    salt: [u8; SALT_LEN],
}

impl Header {
    fn new() -> Self {
        Self { kdf: KDF_PARAMS, salt: *secure::random_bytes::<SALT_LEN>() }
    }

    fn to_bytes(&self) -> [u8; HEADER_LEN] {
        let mut bytes = [0u8; HEADER_LEN];
        let kdf = [self.kdf.memory_kib, self.kdf.time, self.kdf.threads];
        let fields = kdf.iter().flat_map(|value| value.to_le_bytes());
        for (slot, byte) in bytes.iter_mut().zip(MAGIC.iter().copied().chain(fields).chain(self.salt)) {
            *slot = byte;
        }
        bytes
    }

    /// None if this is not a backup file (of a format this app knows).
    fn parse(bytes: &[u8; HEADER_LEN]) -> Option<Self> {
        let rest = bytes.strip_prefix(MAGIC.as_slice())?;
        let number = |i: usize| u32::from_le_bytes(rest[i * 4..i * 4 + 4].try_into().unwrap());
        let kdf = KdfParams { memory_kib: number(0), time: number(1), threads: number(2) };
        Some(Self { kdf, salt: rest[12..].try_into().ok()? })
    }

    /// The key the database part is encrypted with. Fails only for Argon2id
    /// settings out of range (a damaged or forged header).
    fn file_key(&self, password: &str, recovery_key: &[u8; RECOVERY_KEY_LEN]) -> Result<Zeroizing<[u8; KEY_LEN]>, secure::CryptoError> {
        let from_password = secure::password_key(password, &self.salt, &self.kdf)?;
        let mut ikm = Zeroizing::new([0u8; KEY_LEN + RECOVERY_KEY_LEN]);
        ikm[..KEY_LEN].copy_from_slice(from_password.as_ref());
        ikm[KEY_LEN..].copy_from_slice(recovery_key);
        let mut key = Zeroizing::new([0u8; KEY_LEN]);
        Hkdf::<Sha256>::new(Some(&self.to_bytes()), ikm.as_ref())
            .expand(KEY_INFO, key.as_mut())
            .expect("32 bytes is a valid HKDF output length");
        Ok(key)
    }
}

/// A work file deleted when dropped (and before use, in case an earlier run left it behind).
struct WorkFile(PathBuf);

impl WorkFile {
    fn new(path: PathBuf) -> Self {
        let _ = fs::remove_file(&path);
        Self(path)
    }
}

impl Drop for WorkFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn check_new_password(password: &str) -> Result<(), Message> {
    let long_enough = password.chars().count() >= MIN_PASSWORD_CHARS;
    let mixed = [char::is_ascii_digit, char::is_ascii_lowercase, char::is_ascii_uppercase]
        .iter()
        .all(|class| password.chars().any(|c| class(&c)));
    if long_enough && mixed {
        Ok(())
    } else {
        Err(err("auth.errors.weakPassword"))
    }
}

// ---------------------------------------------------------------------------
// Export and restore

/// Saves an encrypted copy of the open database `db` to `target`, locked with
/// `password` and a new recovery key. Returns the recovery key for the user to
/// keep; it is not stored anywhere.
pub fn export(db: &Connection, data_dir: &Path, target: &Path, password: &str) -> Result<String, Message> {
    check_new_password(password)?;
    let recovery_key = secure::random_bytes::<RECOVERY_KEY_LEN>();
    let header = Header::new();
    let key = header.file_key(password, &recovery_key).map_err(internal)?;

    let work = WorkFile::new(data_dir.join(EXPORT_WORK_FILE));
    localdb::export_copy(db, &work.0, &key).map_err(internal)?;
    write_backup(target, &header.to_bytes(), &work.0).map_err(file_error)?;
    Ok(format_recovery_key(&recovery_key))
}

/// Writes header || database copy through a temporary file next to `target`, so
/// a failure never leaves a half-written backup behind.
fn write_backup(target: &Path, header: &[u8], copy: &Path) -> io::Result<()> {
    let mut partial = target.as_os_str().to_owned();
    partial.push(".part");
    let partial = PathBuf::from(partial);
    let result = (|| {
        let mut out = File::create(&partial)?;
        out.write_all(header)?;
        io::copy(&mut File::open(copy)?, &mut out)?;
        out.sync_all()?;
        drop(out);
        rename_when_free(&partial, target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result
}

/// Tries to rename a file that was just written this many times before giving up.
const RENAME_ATTEMPTS: u32 = 10;

/// Renames `from` to `to`. On Windows another program (usually the antivirus,
/// scanning the new file) may still hold `from` for a moment after it was
/// closed; the rename is then retried a few times, waiting a little longer each time.
fn rename_when_free(from: &Path, to: &Path) -> io::Result<()> {
    let mut attempt = 1;
    loop {
        match fs::rename(from, to) {
            Err(e) if attempt < RENAME_ATTEMPTS && is_in_use(&e) => {
                std::thread::sleep(std::time::Duration::from_millis(50 * u64::from(attempt)));
                attempt += 1;
            }
            result => return result,
        }
    }
}

/// Whether the file is open in another process: ERROR_SHARING_VIOLATION, or
/// access denied (what Windows reports while a file is about to be released).
fn is_in_use(error: &io::Error) -> bool {
    const ERROR_SHARING_VIOLATION: i32 = 32;
    cfg!(windows)
        && (error.raw_os_error() == Some(ERROR_SHARING_VIOLATION) || error.kind() == io::ErrorKind::PermissionDenied)
}

/// What a restore does with the data already on this computer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RestoreMode {
    /// Everything is replaced with the backup.
    Replace,
    /// The backup's rows are added; where both have the same row, this computer's is kept.
    Merge,
}

/// Restores the backup at `source` into the open database `db`, replacing or
/// merging (`mode`); `user` (who restores it) keeps access.
/// On any failure the database is left as it was.
pub fn restore(
    db: &Connection,
    user: &SessionInfo,
    data_dir: &Path,
    source: &Path,
    password: &str,
    recovery_key: &str,
    mode: RestoreMode,
) -> Result<(), Message> {
    let recovery_key = parse_recovery_key(recovery_key).ok_or_else(|| err("backup.errors.invalidRecoveryKey"))?;
    if password.is_empty() {
        return Err(err("backup.errors.wrongSecrets"));
    }

    let mut file = File::open(source).map_err(file_error)?;
    let mut header_bytes = [0u8; HEADER_LEN];
    match file.read_exact(&mut header_bytes) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Err(err("backup.errors.notABackup")),
        Err(e) => return Err(file_error(e)),
    }
    let header = Header::parse(&header_bytes).ok_or_else(|| err("backup.errors.notABackup"))?;
    let key = header.file_key(password, &recovery_key).map_err(|_| err("backup.errors.notABackup"))?;

    let work = WorkFile::new(data_dir.join(RESTORE_WORK_FILE));
    io::copy(&mut file, &mut File::create(&work.0).map_err(file_error)?).map_err(file_error)?;
    drop(file);
    prepare_copy(&work.0, &key)?;
    match mode {
        RestoreMode::Replace => localdb::replace_contents(db, &work.0, &key),
        RestoreMode::Merge => localdb::merge_contents(db, &work.0, &key),
    }
    .map_err(internal)?;
    // The restored data may not know the person who restored it.
    keep_access(db, user, "restored");
    Ok(())
}

/// Deletes all clinic data in the open database `db`, keeping its schema; `user`
/// (who clears it) keeps access. On failure nothing is deleted.
pub fn clear(db: &Connection, user: &SessionInfo) -> Result<(), Message> {
    localdb::clear_contents(db).map_err(internal)?;
    // Not fatal: the data is already gone; this only gives the space back.
    if let Err(e) = localdb::compact(db) {
        eprintln!("Cleared, but the database file was not compacted: {e}");
    }
    keep_access(db, user, "cleared");
    Ok(())
}

/// Records `user` in data that was just replaced (`done` says how), so they keep
/// their role. Not fatal: the work is done, and their next login records them anyway.
fn keep_access(db: &Connection, user: &SessionInfo, done: &str) {
    let recorded = hex::decode(&user.user_id).map_err(|e| e.to_string()).and_then(|user_id| {
        localdb::record_login(db, &user_id, &user.username, &user.full_name, &user.role, clock::now_unix())
            .map_err(|e| e.to_string())
    });
    if let Err(e) = recorded {
        eprintln!("Database {done}, but {} not recorded in it: {e}", user.username);
    }
}

/// Opens the restored copy with the backup key and brings its schema up to date.
fn prepare_copy(path: &Path, key: &[u8; KEY_LEN]) -> Result<(), Message> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(internal)?;
    // A wrong password or recovery key, or a damaged file, all look the same here.
    localdb::apply_key(&conn, key).map_err(|_| err("backup.errors.wrongSecrets"))?;
    let version = localdb::schema_version(&conn, "main").map_err(internal)?;
    if version < 1 {
        return Err(err("backup.errors.notABackup"));
    }
    if version > localdb::latest_schema_version() {
        return Err(err("backup.errors.newerVersion"));
    }
    localdb::migrate(&conn).map_err(internal)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_key_round_trip() {
        let key = [0xAB; RECOVERY_KEY_LEN];
        let text = format_recovery_key(&key);
        assert_eq!(text.len(), 9 * GROUP_LEN + 8);
        assert_eq!(text.split('-').count(), 9);
        assert_eq!(*parse_recovery_key(&text).unwrap(), key);
        // Typed loosely: lowercase, spaces instead of dashes.
        assert_eq!(*parse_recovery_key(&text.to_lowercase().replace('-', " ")).unwrap(), key);
        // One digit changed: the checksum catches it.
        let typo = text.replacen('A', "B", 1);
        assert!(parse_recovery_key(&typo).is_none());
        assert!(parse_recovery_key("ABCD").is_none());
        assert!(parse_recovery_key("not a key").is_none());
    }

    #[test]
    fn header_round_trip_and_key() {
        let header = Header::new();
        let bytes = header.to_bytes();
        assert!(bytes.starts_with(MAGIC));
        let parsed = Header::parse(&bytes).unwrap();
        assert_eq!((parsed.kdf, parsed.salt), (header.kdf, header.salt));

        let recovery = [1u8; RECOVERY_KEY_LEN];
        let key = header.file_key("Backup-passw0rd", &recovery).unwrap();
        assert_eq!(*parsed.file_key("Backup-passw0rd", &recovery).unwrap(), *key);
        // Each secret matters on its own.
        assert_ne!(*header.file_key("other-Passw0rd", &recovery).unwrap(), *key);
        assert_ne!(*header.file_key("Backup-passw0rd", &[2u8; RECOVERY_KEY_LEN]).unwrap(), *key);

        let mut other = bytes;
        other[0] = b'X';
        assert!(Header::parse(&other).is_none(), "not a backup");
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dental-backup-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn manager() -> SessionInfo {
        SessionInfo {
            user_id: hex::encode([9u8; 16]),
            username: "owner".into(),
            full_name: "Dr. Owner".into(),
            role: localdb::ROLE_MANAGER.into(),
            is_admin: true,
            is_owner: true,
            online: true,
            offline_until: 0,
            billing: None,
            locked: false,
        }
    }

    fn user_names(db: &Connection) -> Vec<String> {
        let mut statement = db.prepare("SELECT username FROM users ORDER BY username").unwrap();
        statement.query_map([], |row| row.get(0)).unwrap().map(Result::unwrap).collect()
    }

    /// Export from one clinic database, restore into another one (other key), as the app does.
    #[test]
    fn export_then_restore() {
        let dir = temp_dir("round-trip");
        let source = localdb::create(&dir.join("source.db"), &[1; 32]).unwrap();
        localdb::record_login(&source, &[1; 16], "doctor", "Dr. A", localdb::ROLE_MANAGER, 100).unwrap();
        localdb::record_login(&source, &[2; 16], "nurse", "N. B", localdb::ROLE_STAFF, 100).unwrap();

        let backup = dir.join("clinic.dbk");
        assert_eq!(export(&source, &dir, &backup, "weak").unwrap_err().key, "auth.errors.weakPassword");
        let recovery_key = export(&source, &dir, &backup, "Backup-passw0rd").unwrap();
        assert!(!dir.join(EXPORT_WORK_FILE).exists(), "work file left behind");
        let bytes = fs::read(&backup).unwrap();
        assert!(bytes.starts_with(MAGIC));
        assert!(!bytes.windows(6).any(|w| w == b"doctor"), "backup is not encrypted");

        let target = localdb::create(&dir.join("target.db"), &[2; 32]).unwrap();
        localdb::record_login(&target, &[3; 16], "other", "O. C", localdb::ROLE_MANAGER, 100).unwrap();
        let restore_with =
            |password: &str, key: &str| restore(&target, &manager(), &dir, &backup, password, key, RestoreMode::Replace);

        assert_eq!(restore_with("Backup-passw0rd", "1234").unwrap_err().key, "backup.errors.invalidRecoveryKey");
        assert_eq!(restore_with("Wrong-passw0rd", &recovery_key).unwrap_err().key, "backup.errors.wrongSecrets");
        let other_key = format_recovery_key(&[7; RECOVERY_KEY_LEN]);
        assert_eq!(restore_with("Backup-passw0rd", &other_key).unwrap_err().key, "backup.errors.wrongSecrets");
        assert_eq!(user_names(&target), ["other"], "failed restore changed the data");

        let not_a_backup = dir.join("random.dbk");
        fs::write(&not_a_backup, b"hello").unwrap();
        let error = restore(&target, &manager(), &dir, &not_a_backup, "Backup-passw0rd", &recovery_key, RestoreMode::Replace).unwrap_err();
        assert_eq!(error.key, "backup.errors.notABackup");

        restore_with("Backup-passw0rd", &recovery_key).unwrap();
        assert!(!dir.join(RESTORE_WORK_FILE).exists(), "work file left behind");
        // The backup's users, plus whoever restored it.
        assert_eq!(user_names(&target), ["doctor", "nurse", "owner"]);
    }

    /// Merging adds the backup's rows and keeps this computer's where both have one.
    #[test]
    fn export_then_merge() {
        let dir = temp_dir("merge");
        let source = localdb::create(&dir.join("source.db"), &[1; 32]).unwrap();
        localdb::record_login(&source, &[1; 16], "doctor", "Dr. A", localdb::ROLE_MANAGER, 100).unwrap();
        localdb::record_login(&source, &[2; 16], "nurse", "N. B", localdb::ROLE_MANAGER, 100).unwrap();
        let backup = dir.join("clinic.dbk");
        let recovery_key = export(&source, &dir, &backup, "Backup-passw0rd").unwrap();

        let target = localdb::create(&dir.join("target.db"), &[2; 32]).unwrap();
        // The same nurse, with another role here.
        localdb::record_login(&target, &[2; 16], "nurse", "N. B", localdb::ROLE_STAFF, 100).unwrap();
        localdb::record_login(&target, &[3; 16], "other", "O. C", localdb::ROLE_STAFF, 100).unwrap();

        restore(&target, &manager(), &dir, &backup, "Backup-passw0rd", &recovery_key, RestoreMode::Merge).unwrap();
        assert_eq!(user_names(&target), ["doctor", "nurse", "other", "owner"]);
        let nurse_role: String =
            target.query_row("SELECT role FROM users WHERE username = 'nurse'", [], |row| row.get(0)).unwrap();
        assert_eq!(nurse_role, localdb::ROLE_STAFF, "this computer's row was overwritten");
        assert_eq!(localdb::schema_version(&target, "main").unwrap(), localdb::latest_schema_version());
    }

    #[test]
    fn clear_keeps_who_cleared() {
        let dir = temp_dir("clear");
        let db = localdb::create(&dir.join("clinic.db"), &[1; 32]).unwrap();
        localdb::record_login(&db, &[1; 16], "doctor", "Dr. A", localdb::ROLE_MANAGER, 100).unwrap();
        localdb::record_login(&db, &[2; 16], "nurse", "N. B", localdb::ROLE_STAFF, 100).unwrap();

        clear(&db, &manager()).unwrap();
        assert_eq!(user_names(&db), ["owner"]);
        let role: String = db.query_row("SELECT role FROM users", [], |row| row.get(0)).unwrap();
        assert_eq!(role, localdb::ROLE_MANAGER);
        assert_eq!(localdb::schema_version(&db, "main").unwrap(), localdb::latest_schema_version());
    }

    #[test]
    fn new_password_rules() {
        assert!(check_new_password("Backup-passw0rd").is_ok());
        assert!(check_new_password("Short1a").is_err());
        assert!(check_new_password("no-digits-Here").is_err());
        assert!(check_new_password("NO-LOWER-1234").is_err());
        assert!(check_new_password("no-upper-1234").is_err());
    }
}
