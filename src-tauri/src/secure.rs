//! Client-side cryptography. Must match the server (`dental-server/internal/secure`)
//! and the scheme documented in `proto/dental/v1/crypto.proto`.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use ed25519_dalek::{Signature, VerifyingKey};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::proto::SealedBox;

pub const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 24;
const SEALED_BOX_INFO: &[u8] = b"dental/sealed-box/v1";

#[derive(Debug)]
pub struct CryptoError(pub &'static str);

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for CryptoError {}

pub type Result<T> = std::result::Result<T, CryptoError>;

pub fn random_bytes<const N: usize>() -> Zeroizing<[u8; N]> {
    let mut bytes = Zeroizing::new([0u8; N]);
    getrandom::fill(bytes.as_mut()).expect("system random number generator failed");
    bytes
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

// ---------------------------------------------------------------------------
// X25519 key pairs and sealed boxes.

/// A one-time or per-user X25519 key pair. The secret is wiped on drop.
pub struct KeyPair {
    secret: StaticSecret,
    pub public: [u8; 32],
}

impl KeyPair {
    pub fn generate() -> Self {
        Self::from_secret(*random_bytes::<32>())
    }

    pub fn from_secret(secret: [u8; 32]) -> Self {
        let secret = StaticSecret::from(secret);
        let public = PublicKey::from(&secret).to_bytes();
        Self { secret, public }
    }

    pub fn secret_bytes(&self) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(self.secret.to_bytes())
    }
}

fn sealed_box_key(shared: &[u8], client_public: &[u8], server_public: &[u8]) -> Zeroizing<[u8; KEY_LEN]> {
    let salt = [client_public, server_public].concat();
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    Hkdf::<Sha256>::new(Some(&salt), shared)
        .expand(SEALED_BOX_INFO, key.as_mut())
        .expect("32 bytes is a valid HKDF output length");
    key
}

fn cipher(key: &[u8]) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new_from_slice(key).expect("key is 32 bytes")
}

fn nonce(bytes: &[u8]) -> Result<XNonce> {
    XNonce::try_from(bytes).map_err(|_| CryptoError("invalid nonce"))
}

/// Opens a box sealed to `recipient` (by the server, or locally by [`seal`]).
pub fn open_sealed(recipient: &KeyPair, sealed: &SealedBox, aad: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    let sender_public: [u8; 32] = sealed
        .server_public_key
        .as_slice()
        .try_into()
        .map_err(|_| CryptoError("invalid sealed box key"))?;
    let shared = recipient.secret.diffie_hellman(&PublicKey::from(sender_public));
    if !shared.was_contributory() {
        return Err(CryptoError("invalid sealed box key"));
    }
    let key = sealed_box_key(shared.as_bytes(), &recipient.public, &sender_public);
    cipher(key.as_ref())
        .decrypt(&nonce(&sealed.nonce)?, Payload { msg: &sealed.ciphertext, aad })
        .map(Zeroizing::new)
        .map_err(|_| CryptoError("sealed box cannot be opened"))
}

/// Seals `plain` to `recipient_public`, the same way the server does.
pub fn seal(recipient_public: &[u8; 32], plain: &[u8], aad: &[u8]) -> SealedBox {
    let sender = KeyPair::generate();
    let shared = sender.secret.diffie_hellman(&PublicKey::from(*recipient_public));
    let key = sealed_box_key(shared.as_bytes(), recipient_public, &sender.public);
    let nonce_bytes = random_bytes::<NONCE_LEN>();
    let ciphertext = cipher(key.as_ref())
        .encrypt(&nonce(nonce_bytes.as_ref()).expect("24 bytes"), Payload { msg: plain, aad })
        .expect("encryption cannot fail for small messages");
    SealedBox {
        server_public_key: sender.public.to_vec(),
        nonce: nonce_bytes.to_vec(),
        ciphertext,
    }
}

// ---------------------------------------------------------------------------
// Password-based encryption: Argon2id + XChaCha20-Poly1305.

/// Argon2id settings for a key derived from a user's password. They are stored
/// next to what they encrypt (see vault.rs), so they can be raised later without
/// locking anyone out. Changing them cannot weaken existing data: other settings
/// give a different key, and decryption simply fails.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    pub memory_kib: u32,
    pub time: u32,
    pub threads: u32,
}

/// Used for everything encrypted from now on (RFC 9106's 64 MiB option). Logging
/// in happens rarely on a desktop, so this is well above the OWASP minimum
/// (19 MiB, 2 passes): each password guess against a stolen vault costs about 5x
/// more time and over 3x more memory. Measured: ~80 ms per login on a recent PC
/// (legacy: ~15 ms); expect a few hundred ms on an old one.
pub const KDF_PARAMS: KdfParams = KdfParams { memory_kib: 64 * 1024, time: 3, threads: 1 };

/// What vault entries written before the settings were stored used.
pub const LEGACY_KDF_PARAMS: KdfParams = KdfParams { memory_kib: 19 * 1024, time: 2, threads: 1 };

/// Settings read from a file are refused above this, so an edited file cannot make the app hang.
const MAX_KDF_MEMORY_KIB: u32 = 1024 * 1024;
const MAX_KDF_TIME: u32 = 20;
const MAX_KDF_THREADS: u32 = 16;

pub const SALT_LEN: usize = 16;

/// The Argon2id key for `password`. Refuses settings above the MAX_KDF_* limits.
pub fn password_key(password: &str, salt: &[u8], kdf: &KdfParams) -> Result<Zeroizing<[u8; KEY_LEN]>> {
    if kdf.memory_kib > MAX_KDF_MEMORY_KIB || kdf.time > MAX_KDF_TIME || kdf.threads > MAX_KDF_THREADS {
        return Err(CryptoError("password settings out of range"));
    }
    let params = Params::new(kdf.memory_kib, kdf.time, kdf.threads, Some(KEY_LEN))
        .map_err(|_| CryptoError("invalid password settings"))?;
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, key.as_mut())
        .map_err(|_| CryptoError("invalid password settings"))?;
    Ok(key)
}

/// Encrypts `plain` with a key derived from `password` using [`KDF_PARAMS`].
/// Output: salt || nonce || ciphertext. Store `KDF_PARAMS` alongside it.
pub fn encrypt_with_password(password: &str, plain: &[u8], aad: &[u8]) -> Vec<u8> {
    encrypt_with_password_using(password, &KDF_PARAMS, plain, aad)
}

/// Like [`encrypt_with_password`] with other settings. Only tests need this
/// (to make data in the old format).
pub(crate) fn encrypt_with_password_using(password: &str, kdf: &KdfParams, plain: &[u8], aad: &[u8]) -> Vec<u8> {
    let salt = random_bytes::<SALT_LEN>();
    let nonce_bytes = random_bytes::<NONCE_LEN>();
    let key = password_key(password, salt.as_ref(), kdf).expect("valid password settings");
    let ciphertext = cipher(key.as_ref())
        .encrypt(&nonce(nonce_bytes.as_ref()).expect("24 bytes"), Payload { msg: plain, aad })
        .expect("encryption cannot fail for small messages");
    [salt.as_ref(), nonce_bytes.as_ref(), &ciphertext].concat()
}

/// Reverses [`encrypt_with_password`], given the settings it was encrypted with.
/// A wrong password fails here.
pub fn decrypt_with_password(password: &str, kdf: &KdfParams, data: &[u8], aad: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    if data.len() < SALT_LEN + NONCE_LEN {
        return Err(CryptoError("encrypted data too short"));
    }
    let (salt, rest) = data.split_at(SALT_LEN);
    let (nonce_bytes, ciphertext) = rest.split_at(NONCE_LEN);
    let key = password_key(password, salt, kdf)?;
    cipher(key.as_ref())
        .decrypt(&nonce(nonce_bytes)?, Payload { msg: ciphertext, aad })
        .map(Zeroizing::new)
        .map_err(|_| CryptoError("wrong password"))
}

// ---------------------------------------------------------------------------
// Offline grant signatures.

pub fn verify_signature(public_key: &[u8; 32], message: &[u8], signature: &[u8]) -> Result<()> {
    let key = VerifyingKey::from_bytes(public_key).map_err(|_| CryptoError("invalid signing key"))?;
    let signature = Signature::from_slice(signature).map_err(|_| CryptoError("invalid signature"))?;
    key.verify_strict(message, &signature).map_err(|_| CryptoError("invalid signature"))
}

// ---------------------------------------------------------------------------
// DPAPI: ties data to the current Windows user account.

#[cfg(windows)]
mod dpapi {
    use std::ptr;

    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    use zeroize::Zeroizing;

    use super::{CryptoError, Result};

    /// Extra entropy so other programs of the same user cannot unprotect our data
    /// by calling DPAPI without knowing it.
    const ENTROPY: &[u8] = b"dental-smart-management-base/dpapi/v1";

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 }
    }

    unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Zeroizing<Vec<u8>> {
        let data = Zeroizing::new(std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec());
        std::ptr::write_bytes(out.pbData, 0, out.cbData as usize);
        LocalFree(out.pbData as _);
        data
    }

    pub fn protect(data: &[u8]) -> Result<Vec<u8>> {
        let input = blob(data);
        let entropy = blob(ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: ptr::null_mut() };
        let ok = unsafe {
            CryptProtectData(&input, ptr::null(), &entropy, ptr::null(), ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        };
        if ok == 0 {
            return Err(CryptoError("DPAPI protect failed"));
        }
        Ok(unsafe { take(out) }.to_vec())
    }

    pub fn unprotect(data: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        let input = blob(data);
        let entropy = blob(ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: ptr::null_mut() };
        let ok = unsafe {
            CryptUnprotectData(&input, ptr::null_mut(), &entropy, ptr::null(), ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        };
        if ok == 0 {
            return Err(CryptoError("DPAPI unprotect failed"));
        }
        Ok(unsafe { take(out) })
    }
}

#[cfg(not(windows))]
mod dpapi {
    use zeroize::Zeroizing;

    use super::{CryptoError, Result};

    pub fn protect(_data: &[u8]) -> Result<Vec<u8>> {
        Err(CryptoError("DPAPI is only available on Windows"))
    }

    pub fn unprotect(_data: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        Err(CryptoError("DPAPI is only available on Windows"))
    }
}

pub use dpapi::{protect, unprotect};

#[cfg(test)]
mod tests {
    use super::*;

    /// Same vector as the server's TestSealedBoxKeyVector: both sides derive the same key.
    #[test]
    fn sealed_box_key_matches_server() {
        let key = sealed_box_key(&[1; 32], &[2; 32], &[3; 32]);
        assert_eq!(hex::encode(key.as_ref()), "77defcb63219db93339edc125d4289adb3e97e0eceb698e237e137f222e0a387");
    }

    #[test]
    fn seal_and_open() {
        let recipient = KeyPair::generate();
        let sealed = seal(&recipient.public, b"database key", b"installation");
        assert_eq!(open_sealed(&recipient, &sealed, b"installation").unwrap().as_slice(), b"database key");
        assert!(open_sealed(&recipient, &sealed, b"other").is_err());
        assert!(open_sealed(&KeyPair::generate(), &sealed, b"installation").is_err());
    }

    #[test]
    fn password_encryption() {
        let data = encrypt_with_password("secret password", b"private key", b"user");
        let decrypt = |password, kdf, aad| decrypt_with_password(password, kdf, &data, aad);
        assert_eq!(decrypt("secret password", &KDF_PARAMS, b"user").unwrap().as_slice(), b"private key");
        assert!(decrypt("wrong password", &KDF_PARAMS, b"user").is_err());
        assert!(decrypt("secret password", &KDF_PARAMS, b"other user").is_err());
        // Other settings give another key: changing them in the file only breaks decryption.
        assert!(decrypt("secret password", &LEGACY_KDF_PARAMS, b"user").is_err());
        let huge = KdfParams { memory_kib: u32::MAX, ..KDF_PARAMS };
        assert!(decrypt("secret password", &huge, b"user").is_err(), "absurd settings are refused, not run");
    }

    /// Data from before the settings were raised still decrypts with the old ones.
    #[test]
    fn legacy_password_encryption() {
        let data = encrypt_with_password_using("old password", &LEGACY_KDF_PARAMS, b"old private key", b"user");
        let plain = decrypt_with_password("old password", &LEGACY_KDF_PARAMS, &data, b"user").unwrap();
        assert_eq!(plain.as_slice(), b"old private key");
        assert!(decrypt_with_password("old password", &KDF_PARAMS, &data, b"user").is_err());
    }

    #[test]
    fn signatures() {
        let signing = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
        let public = signing.verifying_key().to_bytes();
        let signature = ed25519_dalek::Signer::sign(&signing, b"grant").to_bytes();
        assert!(verify_signature(&public, b"grant", &signature).is_ok());
        assert!(verify_signature(&public, b"changed", &signature).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_round_trip() {
        let protected = protect(b"installation secret").unwrap();
        assert_ne!(protected.as_slice(), b"installation secret");
        assert_eq!(unprotect(&protected).unwrap().as_slice(), b"installation secret");
    }
}
