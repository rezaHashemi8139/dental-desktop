//! Local files that make offline login possible, kept in the app data folder.
//!
//! - `installation.json`: this installation's id and secret (secret protected with DPAPI).
//! - `vault.json`: one entry per user who has logged in online here. Each holds
//!   the user's X25519 key pair, with the private key encrypted with a key derived
//!   from the user's password (Argon2id) and then with DPAPI; the local-database key
//!   sealed to the user's public key; and the user's signed offline grant.
//!
//! Database keys are sealed to *public* keys, so when one user's login rotates the
//! key, every other user's copy is updated without knowing their passwords.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use prost::Message as _;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::proto::{SealedBox, SignedOfflineGrant};
use crate::secure::{self, KdfParams, KeyPair, KDF_PARAMS, KEY_LEN, LEGACY_KDF_PARAMS};

pub const INSTALLATION_FILE: &str = "installation.json";
pub const VAULT_FILE: &str = "vault.json";

#[derive(Debug)]
pub enum VaultError {
    Io(io::Error),
    Corrupt(&'static str),
    Crypto(secure::CryptoError),
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VaultError::Io(e) => write!(f, "{e}"),
            VaultError::Corrupt(what) => write!(f, "corrupt local file: {what}"),
            VaultError::Crypto(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for VaultError {}

impl From<io::Error> for VaultError {
    fn from(e: io::Error) -> Self {
        VaultError::Io(e)
    }
}

impl From<secure::CryptoError> for VaultError {
    fn from(e: secure::CryptoError) -> Self {
        VaultError::Crypto(e)
    }
}

type Result<T> = std::result::Result<T, VaultError>;

fn b64(data: &[u8]) -> String {
    B64.encode(data)
}

fn unb64(text: &str, what: &'static str) -> Result<Vec<u8>> {
    B64.decode(text).map_err(|_| VaultError::Corrupt(what))
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|_| VaultError::Corrupt("invalid JSON")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Writes through a temporary file so a crash never leaves a half-written file.
fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, serde_json::to_vec_pretty(value).expect("serializable"))?;
    fs::rename(&temp, path)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Installation identity

pub struct Installation {
    pub id: [u8; 16],
    pub secret: Zeroizing<Vec<u8>>,
}

#[derive(Serialize, Deserialize)]
struct InstallationFile {
    id: String,
    /// The secret, protected with DPAPI.
    secret: String,
}

impl Installation {
    pub fn load(dir: &Path) -> Result<Option<Self>> {
        let Some(file) = read_json::<InstallationFile>(&dir.join(INSTALLATION_FILE))? else {
            return Ok(None);
        };
        let id = hex::decode(&file.id)
            .ok()
            .and_then(|id| id.try_into().ok())
            .ok_or(VaultError::Corrupt("installation id"))?;
        let secret = secure::unprotect(&unb64(&file.secret, "installation secret")?)?;
        Ok(Some(Self { id, secret }))
    }

    pub fn save(&self, dir: &Path) -> Result<()> {
        let file = InstallationFile { id: hex::encode(self.id), secret: b64(&secure::protect(&self.secret)?) };
        write_json(&dir.join(INSTALLATION_FILE), &file)
    }
}

// ---------------------------------------------------------------------------
// Vault

#[derive(Serialize, Deserialize, Clone)]
pub struct VaultEntry {
    /// Server user id (hex).
    pub user_id: String,
    pub username: String,
    public_key: String,
    /// DPAPI(salt || nonce || XChaCha20-Poly1305(Argon2id(password), private key)).
    private_key: String,
    /// The Argon2id settings `private_key` was encrypted with. Missing in entries
    /// written before they were stored; those used the legacy settings.
    #[serde(default = "legacy_kdf")]
    kdf: KdfParams,
    /// The local-database key (version || key) sealed to `public_key`.
    database_key: String,
    /// The latest SignedOfflineGrant from the server (protobuf, base64).
    grant: String,
}

#[derive(Serialize, Deserialize)]
pub struct Vault {
    #[serde(skip)]
    path: PathBuf,
    installation_id: String,
    /// Latest time (unix seconds) this installation has seen; see clock.rs.
    pub latest_seen: i64,
    users: Vec<VaultEntry>,
}

/// A database key with its version, as stored in the vault.
pub struct DatabaseKey {
    pub version: u32,
    pub key: Zeroizing<[u8; KEY_LEN]>,
}

impl Vault {
    pub fn load(dir: &Path, installation_id: &[u8; 16]) -> Result<Self> {
        let path = dir.join(VAULT_FILE);
        match read_json::<Vault>(&path)? {
            // A vault left over from another installation is useless here.
            Some(mut vault) if vault.installation_id == hex::encode(installation_id) => {
                vault.path = path;
                Ok(vault)
            }
            _ => Ok(Self { path, installation_id: hex::encode(installation_id), latest_seen: 0, users: Vec::new() }),
        }
    }

    pub fn save(&self) -> Result<()> {
        write_json(&self.path, self)
    }

    pub fn find(&self, username: &str) -> Option<&VaultEntry> {
        self.users.iter().find(|entry| entry.username.eq_ignore_ascii_case(username))
    }

    pub fn remove_username(&mut self, username: &str) {
        self.users.retain(|entry| !entry.username.eq_ignore_ascii_case(username));
    }

    /// Whether anyone has logged in online here, so can log in offline.
    pub fn has_users(&self) -> bool {
        !self.users.is_empty()
    }

    pub fn clear(&mut self) {
        self.users.clear();
    }

    fn aad(&self, user_id: &str) -> Vec<u8> {
        format!("{}/{user_id}", self.installation_id).into_bytes()
    }

    /// Adds or replaces a user's entry after an online login. A fresh key pair is
    /// made each time, so a changed password takes effect immediately.
    pub fn upsert_user(
        &mut self,
        user_id: &[u8],
        username: &str,
        password: &str,
        grant: &SignedOfflineGrant,
        database_key: &DatabaseKey,
    ) -> Result<()> {
        let user_id = hex::encode(user_id);
        let aad = self.aad(&user_id);
        let pair = KeyPair::generate();
        let private_key = encrypt_private_key(&pair, password, &aad)?;

        let entry = VaultEntry {
            user_id: user_id.clone(),
            username: username.to_owned(),
            public_key: b64(&pair.public),
            private_key,
            kdf: KDF_PARAMS,
            database_key: b64(&seal_database_key(&pair.public, database_key, &aad)),
            grant: b64(&grant.encode_to_vec()),
        };
        self.users.retain(|e| e.user_id != user_id && !e.username.eq_ignore_ascii_case(username));
        self.users.push(entry);
        Ok(())
    }

    /// Re-seals a new database key to every user (after a key rotation).
    pub fn set_database_key(&mut self, database_key: &DatabaseKey) -> Result<()> {
        for i in 0..self.users.len() {
            let aad = self.aad(&self.users[i].user_id);
            let public: [u8; 32] = unb64(&self.users[i].public_key, "public key")?
                .try_into()
                .map_err(|_| VaultError::Corrupt("public key"))?;
            self.users[i].database_key = b64(&seal_database_key(&public, database_key, &aad));
        }
        Ok(())
    }

    /// Unlocks a user's private key with their password. Fails for a wrong password.
    pub fn unlock(&self, entry: &VaultEntry, password: &str) -> Result<KeyPair> {
        let protected = unb64(&entry.private_key, "private key")?;
        let encrypted = secure::unprotect(&protected)?;
        let secret = secure::decrypt_with_password(password, &entry.kdf, &encrypted, &self.aad(&entry.user_id))?;
        let secret: [u8; 32] = secret.as_slice().try_into().map_err(|_| VaultError::Corrupt("private key"))?;
        Ok(KeyPair::from_secret(secret))
    }

    /// After a successful offline login: if the user's entry was encrypted with
    /// older Argon2id settings, encrypts it again with the current ones. The key
    /// pair stays the same, so the sealed database key remains valid.
    /// Returns whether anything changed (the caller saves the vault).
    pub fn upgrade_password_settings(&mut self, user_id: &str, password: &str, pair: &KeyPair) -> Result<bool> {
        let aad = self.aad(user_id);
        let Some(entry) = self.users.iter_mut().find(|e| e.user_id == user_id) else {
            return Ok(false);
        };
        if entry.kdf == KDF_PARAMS {
            return Ok(false);
        }
        entry.private_key = encrypt_private_key(pair, password, &aad)?;
        entry.kdf = KDF_PARAMS;
        Ok(true)
    }

    pub fn database_key(&self, entry: &VaultEntry, pair: &KeyPair) -> Result<DatabaseKey> {
        let sealed = SealedBox::decode(unb64(&entry.database_key, "database key")?.as_slice())
            .map_err(|_| VaultError::Corrupt("database key"))?;
        let plain = secure::open_sealed(pair, &sealed, &self.aad(&entry.user_id))?;
        if plain.len() != 4 + KEY_LEN {
            return Err(VaultError::Corrupt("database key"));
        }
        let mut key = Zeroizing::new([0u8; KEY_LEN]);
        key.copy_from_slice(&plain[4..]);
        Ok(DatabaseKey { version: u32::from_le_bytes(plain[..4].try_into().unwrap()), key })
    }

    pub fn grant(&self, entry: &VaultEntry) -> Result<SignedOfflineGrant> {
        SignedOfflineGrant::decode(unb64(&entry.grant, "grant")?.as_slice()).map_err(|_| VaultError::Corrupt("grant"))
    }
}

fn legacy_kdf() -> KdfParams {
    LEGACY_KDF_PARAMS
}

/// The `private_key` field: the secret encrypted with the password (KDF_PARAMS), then with DPAPI.
fn encrypt_private_key(pair: &KeyPair, password: &str, aad: &[u8]) -> Result<String> {
    let encrypted = secure::encrypt_with_password(password, pair.secret_bytes().as_ref(), aad);
    Ok(b64(&secure::protect(&encrypted)?))
}

fn seal_database_key(public: &[u8; 32], database_key: &DatabaseKey, aad: &[u8]) -> Vec<u8> {
    let mut plain = Zeroizing::new(Vec::with_capacity(4 + KEY_LEN));
    plain.extend_from_slice(&database_key.version.to_le_bytes());
    plain.extend_from_slice(database_key.key.as_ref());
    secure::seal(public, &plain, aad).encode_to_vec()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dental-vault-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn key(version: u32, byte: u8) -> DatabaseKey {
        DatabaseKey { version, key: Zeroizing::new([byte; KEY_LEN]) }
    }

    fn grant() -> SignedOfflineGrant {
        SignedOfflineGrant { grant: vec![1, 2, 3], signature: vec![4; 64] }
    }

    #[test]
    fn installation_round_trip() {
        let dir = temp_dir("installation");
        assert!(Installation::load(&dir).unwrap().is_none());
        Installation { id: [5; 16], secret: Zeroizing::new(vec![6; 32]) }.save(&dir).unwrap();

        let raw = fs::read_to_string(dir.join(INSTALLATION_FILE)).unwrap();
        assert!(!raw.contains(&b64(&[6; 32])), "secret stored without DPAPI");
        let loaded = Installation::load(&dir).unwrap().unwrap();
        assert_eq!(loaded.id, [5; 16]);
        assert_eq!(loaded.secret.as_slice(), &[6; 32]);
    }

    #[test]
    fn users_unlock_with_own_password_and_follow_rotation() {
        let dir = temp_dir("vault");
        let mut vault = Vault::load(&dir, &[1; 16]).unwrap();
        vault.upsert_user(&[10; 16], "Doctor", "doctor-password", &grant(), &key(1, 0xAA)).unwrap();
        vault.upsert_user(&[11; 16], "secretary", "secretary-password", &grant(), &key(1, 0xAA)).unwrap();

        // Doctor logs in online later: the key rotates to version 2 for everyone.
        vault.set_database_key(&key(2, 0xBB)).unwrap();
        vault.save().unwrap();

        let vault = Vault::load(&dir, &[1; 16]).unwrap();
        let secretary = vault.find("SECRETARY").unwrap();
        assert!(vault.unlock(secretary, "doctor-password").is_err(), "unlocked with another user's password");
        let pair = vault.unlock(secretary, "secretary-password").unwrap();
        let db_key = vault.database_key(secretary, &pair).unwrap();
        assert_eq!((db_key.version, db_key.key[0]), (2, 0xBB));

        // A vault from another installation is ignored.
        assert!(Vault::load(&dir, &[2; 16]).unwrap().find("doctor").is_none());
    }

    /// An entry saved before the Argon2id settings were stored (no "kdf" field)
    /// still unlocks, and is moved to the current settings after a login.
    #[test]
    fn legacy_entry_unlocks_and_upgrades() {
        let dir = temp_dir("legacy");
        let mut vault = Vault::load(&dir, &[1; 16]).unwrap();
        vault.upsert_user(&[10; 16], "doctor", "doctor-password", &grant(), &key(3, 0xCC)).unwrap();

        // Rewrite the entry the way the old version did: legacy settings, no "kdf" field.
        let user_id = vault.users[0].user_id.clone();
        let pair = vault.unlock(&vault.users[0], "doctor-password").unwrap();
        let old = secure::encrypt_with_password_using("doctor-password", &LEGACY_KDF_PARAMS, pair.secret_bytes().as_ref(), &vault.aad(&user_id));
        vault.users[0].private_key = b64(&secure::protect(&old).unwrap());
        vault.save().unwrap();
        let mut json: serde_json::Value = serde_json::from_slice(&fs::read(dir.join(VAULT_FILE)).unwrap()).unwrap();
        json["users"][0].as_object_mut().unwrap().remove("kdf");
        fs::write(dir.join(VAULT_FILE), serde_json::to_vec(&json).unwrap()).unwrap();

        let mut vault = Vault::load(&dir, &[1; 16]).unwrap();
        let entry = vault.find("doctor").unwrap().clone();
        assert_eq!(entry.kdf, LEGACY_KDF_PARAMS);
        assert!(vault.unlock(&entry, "wrong-password").is_err());
        let pair = vault.unlock(&entry, "doctor-password").unwrap();

        assert!(vault.upgrade_password_settings(&user_id, "doctor-password", &pair).unwrap());
        assert!(!vault.upgrade_password_settings(&user_id, "doctor-password", &pair).unwrap(), "already current");
        vault.save().unwrap();

        let vault = Vault::load(&dir, &[1; 16]).unwrap();
        let entry = vault.find("doctor").unwrap();
        assert_eq!(entry.kdf, KDF_PARAMS);
        let pair = vault.unlock(entry, "doctor-password").unwrap();
        let db_key = vault.database_key(entry, &pair).unwrap();
        assert_eq!((db_key.version, db_key.key[0]), (3, 0xCC), "database key still opens after the upgrade");
    }
}
