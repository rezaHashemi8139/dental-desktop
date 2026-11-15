//! Sign-up, login (online or offline) and logout. See dental-server/docs/security-design.md.
//!
//! Online login: the server checks the credentials and sends the local-database
//! keys; the database is rekeyed and the vault updated for offline use.
//! Offline login (only when the server cannot be reached): the vault entry is
//! unlocked with the user's password, the signed grant must be valid and not
//! expired, and the clock must not have been turned back.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use prost::Message as _;
use rusqlite::Connection;
use serde::Serialize;
use zeroize::Zeroizing;

use crate::api::{Api, ApiError};
use crate::message::Message;
use crate::proto;
use crate::secure::{self, KeyPair, KEY_LEN};
use crate::vault::{DatabaseKey, Installation, Vault, VaultEntry};
use crate::{clock, device, localdb};

/// Public key of the server's grant-signing key (Ed25519, base64).
/// Set DENTAL_SIGNING_PUBLIC_KEY at build time for production.
const SIGNING_PUBLIC_KEY: &str = match option_env!("DENTAL_SIGNING_PUBLIC_KEY") {
    Some(key) => key,
    // Development server: the public half of SIGNING_KEY in dental-server/.env.
    // If that key is regenerated, update this value too, or every login fails with invalidGrant.
    None => "Uiy7cmF7oPw2nz1EKN5Hyk1lKZyxniSRF6UBkGiOuAA=",
};

pub struct Context {
    pub data_dir: PathBuf,
    pub api: Api,
    pub signing_public_key: [u8; 32],
}

impl Context {
    pub fn new(data_dir: PathBuf, api: Api) -> Self {
        let signing_public_key = base64::engine::general_purpose::STANDARD
            .decode(SIGNING_PUBLIC_KEY)
            .ok()
            .and_then(|key| key.try_into().ok())
            .expect("DENTAL_SIGNING_PUBLIC_KEY must be a 32-byte key in base64");
        Self { data_dir, api, signing_public_key }
    }

    fn database_path(&self) -> PathBuf {
        self.data_dir.join(localdb::DATABASE_FILE)
    }
}

/// The logged-in user, sent to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub user_id: String,
    pub username: String,
    pub full_name: String,
    /// Local role (manager, staff, ...), stored in the local database.
    pub role: String,
    pub is_admin: bool,
    /// Logged in through the server (true) or from the vault (false).
    pub online: bool,
    /// Until when this user can log in without the server (unix seconds).
    pub offline_until: i64,
}

/// An open login: the database stays open until logout.
pub struct Session {
    pub info: SessionInfo,
    /// Holding the connection keeps the database unlocked; dropping it locks it again.
    #[allow(dead_code)] // used by the clinic features to come
    pub db: Connection,
    token: Option<Zeroizing<String>>,
}

impl Session {
    pub fn token(&self) -> Option<&str> {
        self.token.as_deref().map(String::as_str)
    }
}

fn err(key: &str) -> Message {
    Message::new(key)
}

fn internal(details: impl std::fmt::Display) -> Message {
    Message::error("errors.unknown", details)
}

/// Maps a server error reason to a translation key.
fn server_error(code: &str, reason: &str) -> Message {
    match reason {
        "invalid_argument" => err("auth.errors.invalidInput"),
        "invalid_installation" => err("auth.errors.invalidInstallation"),
        "installation_revoked" => err("auth.errors.installationRevoked"),
        "invalid_credentials" => err("auth.errors.invalidCredentials"),
        "user_disabled" => err("auth.errors.userDisabled"),
        "not_a_member" => err("auth.errors.notAMember"),
        "username_taken" => err("auth.errors.usernameTaken"),
        _ => Message::error("auth.errors.server", format!("{code}: {reason}")),
    }
}

/// Server errors that mean "try offline" rather than "refuse".
fn server_unavailable(code: &str) -> bool {
    matches!(code, "unavailable" | "internal" | "unknown" | "deadline_exceeded" | "resource_exhausted")
}

/// What the login screen can offer, decided at startup.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionMode {
    /// The server is reachable: login and sign-up go through it.
    Online,
    /// No server, but the local database is here with users who can log in offline: login only.
    Offline,
    /// No server and nothing to log in to locally.
    Unavailable,
}

pub async fn connection_mode(ctx: &Context) -> ConnectionMode {
    match ctx.api.health().await {
        Ok(health) if health.database_ok => return ConnectionMode::Online,
        // Login would fail with "unavailable" and fall back to offline anyway.
        Ok(_) => eprintln!("Server is up but its database is not"),
        Err(e) => eprintln!("Server not reachable: {e}"),
    }
    if local_login_possible(ctx) {
        ConnectionMode::Offline
    } else {
        ConnectionMode::Unavailable
    }
}

/// Whether the local database exists and someone in the vault holds its key.
/// The database itself can only be opened with a user's password, so this is
/// checked again (for real) when they log in.
fn local_login_possible(ctx: &Context) -> bool {
    let database_present = std::fs::metadata(ctx.database_path()).map(|m| m.is_file() && m.len() > 0).unwrap_or(false);
    if !database_present {
        return false;
    }
    match Installation::load(&ctx.data_dir) {
        Ok(Some(installation)) => Vault::load(&ctx.data_dir, &installation.id).map(|v| v.has_users()).unwrap_or(false),
        _ => false,
    }
}

pub async fn sign_up(ctx: &Context, username: &str, password: &str, full_name: &str) -> Result<(), Message> {
    let request = proto::SignUpRequest {
        username: username.trim().to_owned(),
        password: password.to_owned(),
        full_name: full_name.trim().to_owned(),
    };
    match ctx.api.sign_up(&request).await {
        Ok(_) => Ok(()),
        Err(ApiError::Network(_)) => Err(err("auth.errors.serverUnreachable")),
        Err(ApiError::Server { code, reason }) => Err(server_error(&code, &reason)),
    }
}

pub async fn login(ctx: &Context, username: &str, password: &str) -> Result<Session, Message> {
    let username = username.trim();
    if username.is_empty() || password.is_empty() {
        return Err(err("auth.errors.invalidCredentials"));
    }

    let installation = match Installation::load(&ctx.data_dir).map_err(internal)? {
        Some(installation) => installation,
        None => match register(ctx).await {
            Ok(installation) => installation,
            Err(ApiError::Network(_)) => return Err(err("auth.errors.setupNeedsInternet")),
            Err(ApiError::Server { code, reason }) => return Err(server_error(&code, &reason)),
        },
    };

    let client_key = KeyPair::generate();
    let request = proto::LoginRequest {
        installation_id: installation.id.to_vec(),
        installation_secret: installation.secret.to_vec(),
        username: username.to_owned(),
        password: password.to_owned(),
        client_public_key: client_key.public.to_vec(),
    };

    match ctx.api.login(&request).await {
        Ok(response) => login_online(ctx, &installation, &client_key, username, password, response).await,
        Err(ApiError::Network(_)) => login_offline(ctx, &installation, username, password),
        Err(ApiError::Server { code, .. }) if server_unavailable(&code) => {
            login_offline(ctx, &installation, username, password)
        }
        Err(ApiError::Server { code, reason }) => {
            // The server no longer lets this user (or anyone) in: drop their offline access too.
            let mut vault = Vault::load(&ctx.data_dir, &installation.id).map_err(internal)?;
            match reason.as_str() {
                "not_a_member" | "user_disabled" => vault.remove_username(username),
                "installation_revoked" => vault.clear(),
                _ => {}
            }
            vault.save().map_err(internal)?;
            Err(server_error(&code, &reason))
        }
    }
}

async fn register(ctx: &Context) -> Result<Installation, ApiError> {
    let response = ctx.api.register(&proto::RegisterRequest { machine: Some(device::machine_info()) }).await?;
    let installation = Installation {
        id: response.installation_id.as_slice().try_into().map_err(|_| ApiError::Server {
            code: "internal".into(),
            reason: "invalid installation id".into(),
        })?,
        secret: Zeroizing::new(response.installation_secret),
    };
    installation
        .save(&ctx.data_dir)
        .map_err(|e| ApiError::Server { code: "internal".into(), reason: e.to_string() })?;
    Ok(installation)
}

fn verify_grant(
    ctx: &Context,
    signed: &proto::SignedOfflineGrant,
    installation_id: &[u8; 16],
) -> Result<proto::OfflineGrant, Message> {
    secure::verify_signature(&ctx.signing_public_key, &signed.grant, &signed.signature)
        .map_err(|_| err("auth.errors.invalidGrant"))?;
    let grant = proto::OfflineGrant::decode(signed.grant.as_slice()).map_err(|_| err("auth.errors.invalidGrant"))?;
    if grant.installation_id != installation_id {
        return Err(err("auth.errors.invalidGrant"));
    }
    Ok(grant)
}

fn seconds(timestamp: &Option<prost_types::Timestamp>) -> i64 {
    timestamp.as_ref().map(|t| t.seconds).unwrap_or(0)
}

fn to_key(bytes: &[u8]) -> Result<Zeroizing<[u8; KEY_LEN]>, Message> {
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    if bytes.len() != KEY_LEN {
        return Err(internal("server sent a key of the wrong length"));
    }
    key.copy_from_slice(bytes);
    Ok(key)
}

async fn login_online(
    ctx: &Context,
    installation: &Installation,
    client_key: &KeyPair,
    username: &str,
    password: &str,
    response: proto::LoginResponse,
) -> Result<Session, Message> {
    let token = Zeroizing::new(response.session_token);
    let user = response.user.ok_or_else(|| internal("login response without user"))?;
    let sealed = response.database_keys.ok_or_else(|| internal("login response without keys"))?;
    let signed_grant = response.offline_grant.ok_or_else(|| internal("login response without grant"))?;

    let plain = secure::open_sealed(client_key, &sealed, &installation.id).map_err(internal)?;
    let keys = proto::DatabaseKeys::decode(plain.as_slice()).map_err(internal)?;
    let current = if keys.current_version > 0 { Some(to_key(&keys.current_key)?) } else { None };
    let next = to_key(&keys.next_key)?;
    let grant = verify_grant(ctx, &signed_grant, &installation.id)?;
    if grant.user_id != user.id {
        return Err(err("auth.errors.invalidGrant"));
    }

    // Open (or create) the database and move it to the next key.
    let db = open_and_rotate(&ctx.database_path(), current.as_deref(), &next)?;
    let new_version = keys.current_version + 1;
    if let Err(e) = ctx.api.confirm_key_rotation(&token, new_version).await {
        // Not fatal: the server keeps sending the same pair, and the next login
        // finds the database already on `next` and confirms then.
        eprintln!("Key rotation not confirmed yet: {e}");
    }

    // Keep offline login working for this user and every other user of the vault.
    let database_key = DatabaseKey { version: new_version, key: next };
    let mut vault = Vault::load(&ctx.data_dir, &installation.id).map_err(internal)?;
    vault.set_database_key(&database_key).map_err(internal)?;
    vault.upsert_user(&user.id, &user.username, password, &signed_grant, &database_key).map_err(internal)?;
    let now = clock::now_unix().max(seconds(&response.server_time));
    vault.latest_seen = vault.latest_seen.max(now);
    vault.save().map_err(internal)?;
    clock::save_registry_last_seen(now);

    let default_role = if response.is_owner { localdb::ROLE_MANAGER } else { localdb::ROLE_STAFF };
    let role = localdb::record_login(&db, &user.id, &user.username, &user.full_name, default_role, now).map_err(internal)?;

    let _ = username; // the server's spelling of the username is used from here on
    Ok(Session {
        info: SessionInfo {
            user_id: hex::encode(&user.id),
            username: user.username,
            full_name: user.full_name,
            role,
            is_admin: response.is_admin,
            online: true,
            offline_until: seconds(&grant.expires_at),
        },
        db,
        token: Some(token),
    })
}

/// Opens the database with the current key and rekeys it to `next`, or creates it.
/// If an earlier rotation finished locally but was never confirmed, the database
/// already opens with `next`.
fn open_and_rotate(path: &Path, current: Option<&[u8; KEY_LEN]>, next: &[u8; KEY_LEN]) -> Result<Connection, Message> {
    if !path.exists() {
        return localdb::create(path, next).map_err(internal);
    }

    if let Some(current) = current {
        if let Ok(db) = localdb::open(path, current) {
            localdb::rekey(&db, next).map_err(internal)?;
            drop(db);
            // Re-open to prove the new key works before the server is told.
            return localdb::open(path, next).map_err(internal);
        }
    }
    if let Ok(db) = localdb::open(path, next) {
        return Ok(db);
    }

    // Neither key opens it: a database from an earlier installation of the app.
    // Keep it aside (never delete patient data) and start a new one.
    let aside = path.with_extension(format!("db.unreadable-{}", clock::now_unix()));
    std::fs::rename(path, &aside).map_err(internal)?;
    eprintln!("Unreadable database moved to {}", aside.display());
    localdb::create(path, next).map_err(internal)
}

fn login_offline(ctx: &Context, installation: &Installation, username: &str, password: &str) -> Result<Session, Message> {
    let mut vault = Vault::load(&ctx.data_dir, &installation.id).map_err(internal)?;
    let entry: VaultEntry = vault.find(username).cloned().ok_or_else(|| err("auth.errors.offlineNotAvailable"))?;
    let pair = vault.unlock(&entry, password).map_err(|_| err("auth.errors.invalidCredentials"))?;

    let grant = verify_grant(ctx, &vault.grant(&entry).map_err(internal)?, &installation.id)?;
    if hex::encode(&grant.user_id) != entry.user_id {
        return Err(err("auth.errors.invalidGrant"));
    }

    let now = clock::now_unix();
    let known_times = [seconds(&grant.issued_at), vault.latest_seen, clock::registry_last_seen(), clock::system_activity_time()];
    if !clock::is_plausible(now, &known_times) {
        return Err(err("auth.errors.clockTampered"));
    }
    let expires_at = seconds(&grant.expires_at);
    if now >= expires_at {
        return Err(err("auth.errors.offlineExpired"));
    }

    let database_key = vault.database_key(&entry, &pair).map_err(internal)?;
    let db = localdb::open(&ctx.database_path(), &database_key.key).map_err(|_| err("auth.errors.databaseUnavailable"))?;
    let role = localdb::record_login(&db, &grant.user_id, &grant.username, &grant.full_name, localdb::ROLE_STAFF, now)
        .map_err(internal)?;

    // Entries from before the stronger password settings are upgraded on first use.
    if let Err(e) = vault.upgrade_password_settings(&entry.user_id, password, &pair) {
        eprintln!("Could not upgrade the password settings of {}: {e}", entry.username);
    }
    vault.latest_seen = vault.latest_seen.max(now);
    vault.save().map_err(internal)?;
    clock::save_registry_last_seen(now);

    Ok(Session {
        info: SessionInfo {
            user_id: entry.user_id,
            username: grant.username,
            full_name: grant.full_name,
            role,
            is_admin: grant.is_admin,
            online: false,
            offline_until: expires_at,
        },
        db,
        token: None,
    })
}

/// Ends the session on the server (if online) and closes the database.
pub async fn logout(ctx: &Context, session: Session) {
    if let Some(token) = session.token() {
        let _ = ctx.api.logout(token).await;
    }
    drop(session); // closes the database; the token is wiped on drop
}

/// Full flow against a running development server:
///   cargo test e2e -- --ignored
/// Needs the server from dental-server running on localhost:8080.
#[cfg(all(test, windows))]
mod e2e {
    use super::*;

    fn context(name: &str) -> Context {
        let dir = std::env::temp_dir().join(format!("dental-e2e-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        Context::new(dir, Api::new(crate::settings::SERVER_URL))
    }

    fn unique(name: &str) -> String {
        format!("{name}{}", clock::now_unix() % 1_000_000)
    }

    #[test]
    #[ignore = "needs the development server"]
    fn e2e_online_and_offline_login() {
        tauri::async_runtime::block_on(flow());
    }

    async fn flow() {
        let online = context("online");
        assert_eq!(connection_mode(&online).await, ConnectionMode::Online);
        let doctor = unique("doctor");
        sign_up(&online, &doctor, "doctor-password", "Dr. Test").await.unwrap();

        // First login: becomes owner, database is created.
        let session = login(&online, &doctor, "doctor-password").await.unwrap();
        assert!(session.info.online && session.info.is_admin);
        assert_eq!(session.info.role, localdb::ROLE_MANAGER);
        assert!(session.info.offline_until > clock::now_unix() + 6 * 24 * 3600);
        logout(&online, session).await;

        // Second login rotates the key; the database still opens.
        let session = login(&online, &doctor, "doctor-password").await.unwrap();
        logout(&online, session).await;

        assert!(login(&online, &doctor, "wrong-password").await.is_err());

        // Same installation, server unreachable: offline login from the vault.
        let offline = Context::new(online.data_dir.clone(), Api::new("http://127.0.0.1:9"));
        assert_eq!(connection_mode(&offline).await, ConnectionMode::Offline);
        let nothing_here = Context::new(context("empty").data_dir, Api::new("http://127.0.0.1:9"));
        assert_eq!(connection_mode(&nothing_here).await, ConnectionMode::Unavailable);
        let session = login(&offline, &doctor, "doctor-password").await.unwrap();
        assert!(!session.info.online);
        assert_eq!(session.info.role, localdb::ROLE_MANAGER, "role read from the local database");
        drop(session);

        let error = login(&offline, &doctor, "wrong-password").await.err().unwrap();
        assert_eq!(error.key, "auth.errors.invalidCredentials");
        let error = login(&offline, "someone-else", "whatever-password").await.err().unwrap();
        assert_eq!(error.key, "auth.errors.offlineNotAvailable");
    }
}
