//! Sign-up, login (online or offline), reconnecting and logout. See dental-server/docs/security-design.md.
//!
//! Online login: the server checks the credentials and sends the local-database
//! keys; the database is rekeyed and the vault updated for offline use.
//! Offline login (only when the server cannot be reached): the local database must
//! look usable, the vault entry is unlocked with the user's password (Argon2id),
//! the signed grant must be valid and not expired, and the clock must not have
//! been turned back.
//! Reconnecting: an offline session logs in online by itself once the server is
//! back (see `reconnect_login` and `switch_online`), without closing the session.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use prost::Message as _;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::api::{Api, ApiError};
use crate::connectivity::ConnectivityStatus;
use crate::message::Message;
use crate::person;
use crate::proto;
use crate::secure::{self, KeyPair, KEY_LEN};
use crate::vault::{DatabaseKey, Installation, Vault, VaultEntry};
use crate::{clock, localdb, setup};

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
    /// Owns the clinic, so can buy its subscription (billing.rs). Only known
    /// online: false for an offline session until it reconnects.
    pub is_owner: bool,
    /// Logged in through the server (true) or from the vault (false). An offline
    /// session becomes online once it reconnects.
    pub online: bool,
    /// Until when this user can log in without the server (unix seconds).
    pub offline_until: i64,
    /// Set for a restricted login (`BillingSession`): why the clinic cannot be
    /// used now, e.g. no subscription in force. Only the subscription page works.
    pub billing: Option<Message>,
    /// Locked by the user (the lock screen): clinic data stays closed to the
    /// frontend until the password is given again (`with_session`). Sync goes on.
    pub locked: bool,
}

/// An open login: the database stays open until logout.
pub struct Session {
    pub info: SessionInfo,
    /// Holding the connection keeps the database unlocked; dropping it locks it again.
    pub db: Connection,
    /// Version of the key `db` is encrypted with (as in DatabaseKey).
    key_version: u32,
    token: Option<Zeroizing<String>>,
    /// Offline sessions only: the password, kept in memory (wiped on drop) so the
    /// session can log in online by itself once the server is back. Cleared once
    /// online, and when reconnecting is given up.
    reconnect_password: Option<Zeroizing<String>>,
    /// Wrong account passwords in a row, given for sensitive actions (`verify_password`).
    wrong_passwords: u32,
    /// Changes whenever the data in `db` is replaced as a whole (restore, clearing),
    /// and differs between sessions: a sync whose request was sent before such a
    /// change drops its answer (sync.rs).
    data_epoch: u64,
}

/// A restricted login: the clinic's owner, while the clinic cannot be used (no
/// subscription in force, or more clinics or computers than it allows). The server
/// sends no database keys and no offline grant, so the database stays locked;
/// only the subscription calls work (billing.rs). A billing-only session never
/// becomes a full one on the server, so once a purchase is approved the app logs
/// in again by itself with the kept password (`resume_request`).
pub struct BillingSession {
    pub info: SessionInfo,
    token: Zeroizing<String>,
    /// Kept in memory (wiped on drop), like an offline session's, so the clinic
    /// opens as soon as the subscription is active, without typing it again.
    password: Zeroizing<String>,
}

impl BillingSession {
    pub fn token(&self) -> &str {
        &self.token
    }

    /// The credentials to log in again with (`login`).
    pub fn resume_request(&self) -> (String, Zeroizing<String>) {
        (self.info.username.clone(), self.password.clone())
    }
}

/// What a login opened.
pub enum Login {
    Full(Session),
    Billing(BillingSession),
}

/// After this many wrong account passwords in a row for sensitive actions, the
/// session is logged out.
pub const MAX_WRONG_PASSWORDS: u32 = 3;

fn next_data_epoch() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

impl Session {
    pub fn data_epoch(&self) -> u64 {
        self.data_epoch
    }

    /// The data was replaced as a whole (restore, clearing).
    pub fn data_replaced(&mut self) {
        self.data_epoch = next_data_epoch();
    }

    pub fn token(&self) -> Option<&str> {
        self.token.as_deref().map(String::as_str)
    }

    /// What reconnecting needs, if this is an offline session that can still reconnect.
    pub fn reconnect_request(&self) -> Option<ReconnectRequest> {
        let password = self.reconnect_password.as_ref()?;
        Some(ReconnectRequest {
            user_id: self.info.user_id.clone(),
            username: self.info.username.clone(),
            password: password.clone(),
        })
    }

    /// Whether this is still the offline session `request` was made from.
    pub fn is_waiting_for(&self, request: &ReconnectRequest) -> bool {
        self.token.is_none() && self.info.user_id == request.user_id
    }

    pub fn stop_reconnecting(&mut self) {
        self.reconnect_password = None;
    }

    /// Counts a wrong account password given for a sensitive action. Returns how
    /// many tries are left; at 0 the caller logs out.
    pub fn wrong_password(&mut self) -> u32 {
        self.wrong_passwords += 1;
        MAX_WRONG_PASSWORDS.saturating_sub(self.wrong_passwords)
    }

    /// A right account password: the count of wrong ones starts again.
    pub fn right_password(&mut self) {
        self.wrong_passwords = 0;
    }
}

/// The error of `verify_password` for a wrong password.
pub const WRONG_PASSWORD: &str = "identity.errors.wrongPassword";

/// Checks that `password` is the logged-in user's own, against their vault entry
/// (written by every online login, so it works online and offline). Slow on
/// purpose (Argon2id): call it without holding the session lock.
pub fn verify_password(ctx: &Context, user: &SessionInfo, password: &str) -> Result<(), Message> {
    let installation =
        Installation::load(&ctx.data_dir).map_err(internal)?.ok_or_else(|| err("identity.errors.unavailable"))?;
    let vault = Vault::load(&ctx.data_dir, &installation.id).map_err(internal)?;
    let entry = vault
        .find(&user.username)
        .filter(|entry| entry.user_id == user.user_id)
        .ok_or_else(|| err("identity.errors.unavailable"))?;
    vault.unlock(entry, password).map(|_| ()).map_err(|_| err(WRONG_PASSWORD))
}

/// An offline session's credentials, to log in online once the server is back.
pub struct ReconnectRequest {
    user_id: String,
    username: String,
    password: Zeroizing<String>,
}

impl ReconnectRequest {
    /// For an online session whose token the server has just ended because the user
    /// changed their own password: `reconnect_login` with the new password, then
    /// `switch_online` and `finish_reconnect`, move the open session and the vault
    /// entry to it, so the user goes on without logging in again.
    pub fn after_password_change(user: &SessionInfo, new_password: &str) -> Self {
        Self {
            user_id: user.user_id.clone(),
            username: user.username.clone(),
            password: Zeroizing::new(new_password.to_owned()),
        }
    }
}

fn err(key: &str) -> Message {
    Message::new(key)
}

fn internal(details: impl std::fmt::Display) -> Message {
    Message::error("errors.unknown", details)
}

/// The server's reason for refusing a login with a temporary password.
const PASSWORD_CHANGE_REQUIRED: &str = "password_change_required";
/// Its translation key; the login screen recognizes it and asks for a new password
/// (src/pages/change-password-form.tsx).
const PASSWORD_CHANGE_REQUIRED_ERROR: &str = "auth.errors.passwordChangeRequired";

/// Maps a server error reason (dental-server/internal/service/common.go) to a translation key.
pub(crate) fn server_error(code: &str, reason: &str) -> Message {
    match reason {
        "invalid_argument" => err("auth.errors.invalidInput"),
        "invalid_installation" => err("auth.errors.invalidInstallation"),
        "installation_revoked" => err("auth.errors.installationRevoked"),
        "invalid_credentials" => err("auth.errors.invalidCredentials"),
        "user_disabled" => err("auth.errors.userDisabled"),
        "not_a_member" => err("auth.errors.notAMember"),
        "username_taken" => err("auth.errors.usernameTaken"),
        "weak_password" => err("auth.errors.weakPassword"),
        "license_number_taken" => err("setup.errors.licenseNumberTaken"),
        "identity_taken" => err("person.errors.identityTaken"),
        "identity_mismatch" => err("person.errors.identityMismatch"),
        "identity_required" => err("setup.errors.identityRequired"),
        "clinic_not_found" => err("setup.errors.clinicNotFound"),
        "city_not_found" => err("setup.errors.cityNotFound"),
        "not_clinic_owner" => err("setup.errors.notClinicOwner"),
        "no_clinic" => err("auth.errors.noClinic"),
        PASSWORD_CHANGE_REQUIRED => err(PASSWORD_CHANGE_REQUIRED_ERROR),
        "password_unchanged" => err("auth.errors.passwordUnchanged"),
        "subscription_inactive" => err("auth.errors.subscriptionInactive"),
        "clinic_limit_exceeded" => err("auth.errors.clinicLimitExceeded"),
        "device_limit_exceeded" => err("auth.errors.deviceLimitExceeded"),
        "patient_not_found" => err("patients.errors.historyNotFound"),
        "subscription_required" => err("billing.errors.subscriptionRequired"),
        "plan_not_found" => err("billing.errors.planNotFound"),
        "plan_inactive" => err("billing.errors.planInactive"),
        "renewal_queued" => err("billing.errors.renewalQueued"),
        "payment_account_not_found" => err("billing.errors.paymentAccountNotFound"),
        "payment_pending" => err("billing.errors.paymentPending"),
        "payment_not_found" => err("billing.errors.paymentNotFound"),
        "payment_not_pending" => err("billing.errors.paymentNotPending"),
        "purchase_limit_reached" => err("billing.errors.purchaseLimitReached"),
        "payment_required" => err("billing.errors.paymentRequired"),
        "payment_not_required" => err("billing.errors.paymentNotRequired"),
        "not_admin" => err("members.errors.notAdmin"),
        "user_not_found" => err("members.errors.userNotFound"),
        "already_member" => err("members.errors.alreadyMember"),
        crate::api::UPDATE_REQUIRED => err(crate::update::REQUIRED_ERROR),
        _ => Message::error("auth.errors.server", format!("{code}: {reason}")),
    }
}

/// Server errors that mean "try offline" rather than "refuse".
fn server_unavailable(code: &str) -> bool {
    matches!(code, "unavailable" | "internal" | "unknown" | "deadline_exceeded" | "resource_exhausted")
}

/// Server refusals that end the user's access to this installation, offline included:
/// no longer a member, account or computer blocked, or the clinic's subscription
/// no longer covers it.
fn access_revoked(reason: &str) -> bool {
    matches!(
        reason,
        "not_a_member"
            | "user_disabled"
            | "installation_revoked"
            | "no_clinic"
            | "subscription_inactive"
            | "clinic_limit_exceeded"
            | "device_limit_exceeded"
    )
}

/// A new account, as typed in the sign-up form (src/auth/session.ts).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignUpInput {
    pub username: String,
    pub password: String,
    pub full_name: String,
    /// The identification code (person.rs).
    pub identity: String,
    pub phone: String,
    /// Optional: empty for none.
    pub email: String,
}

/// What the login screen can offer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionMode {
    /// The server is reachable: login and sign-up go through it.
    Online,
    /// The server is reachable but this installation is not connected to a clinic yet:
    /// login and sign-up work, and logging in leads to picking or adding the clinic (setup.rs).
    Setup,
    /// No server, but the local database is usable and users can log in offline: login only.
    Offline,
    /// No server, and users have logged in here before, but the local database
    /// (or the vault holding its keys) is missing, damaged or unreadable.
    LocalDatabaseUnavailable,
    /// No server and nothing to log in to locally (never set up, or nobody logged in online yet).
    Unavailable,
}

/// The login screen for a connectivity status (see connectivity.rs).
pub fn connection_mode(ctx: &Context, status: &ConnectivityStatus) -> ConnectionMode {
    if status.is_online() {
        return if setup::needed(ctx) { ConnectionMode::Setup } else { ConnectionMode::Online };
    }
    match local_login_status(ctx) {
        LocalLogin::Ready => ConnectionMode::Offline,
        LocalLogin::NobodyYet => ConnectionMode::Unavailable,
        LocalLogin::Broken(reason) => {
            eprintln!("Offline login unavailable: {reason}");
            ConnectionMode::LocalDatabaseUnavailable
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum LocalLogin {
    /// The database looks usable and someone in the vault holds its key.
    Ready,
    /// Not set up, or nobody has logged in online here yet.
    NobodyYet,
    /// Someone could log in, but the database or the vault is unusable.
    Broken(String),
}

/// Whether offline login can work. The database itself can only be opened with
/// a user's password, so this checks everything that can be checked without it;
/// opening it for real happens when they log in.
fn local_login_status(ctx: &Context) -> LocalLogin {
    let installation = match Installation::load(&ctx.data_dir) {
        Ok(Some(installation)) => installation,
        Ok(None) => return LocalLogin::NobodyYet,
        Err(e) => return LocalLogin::Broken(format!("installation file: {e}")),
    };
    let vault = match Vault::load(&ctx.data_dir, &installation.id) {
        Ok(vault) => vault,
        Err(e) => return LocalLogin::Broken(format!("vault: {e}")),
    };
    if !vault.has_users() {
        return LocalLogin::NobodyYet;
    }
    match localdb::check_file(&ctx.database_path()) {
        Ok(()) => LocalLogin::Ready,
        Err(e) => LocalLogin::Broken(format!("database: {e}")),
    }
}

/// Replaces a password, proven with the current one. For accounts a clinic admin
/// created with a temporary password: their first login is refused with
/// "password_change_required" until they choose their own. Needs the server.
///
/// The vault is not touched: the next online login writes the user's entry with
/// the new password (an account with a temporary password has none yet).
pub async fn change_password(ctx: &Context, username: &str, current_password: &str, new_password: &str) -> Result<(), Message> {
    let request = proto::ChangePasswordRequest {
        username: username.trim().to_owned(),
        current_password: current_password.to_owned(),
        new_password: new_password.to_owned(),
    };
    match ctx.api.change_password(&request).await {
        Ok(_) => Ok(()),
        Err(ApiError::Network(_)) => Err(err("auth.errors.serverUnreachable")),
        Err(ApiError::Server { code, reason }) => Err(server_error(&code, &reason)),
    }
}

pub async fn sign_up(ctx: &Context, account: &SignUpInput) -> Result<(), Message> {
    let request = proto::SignUpRequest {
        username: account.username.trim().to_owned(),
        password: account.password.clone(),
        full_name: account.full_name.trim().to_owned(),
        identity: Some(person::to_proto(&account.identity)?),
        phone: account.phone.trim().to_owned(),
        email: account.email.trim().to_owned(),
    };
    match ctx.api.sign_up(&request).await {
        Ok(_) => Ok(()),
        Err(ApiError::Network(_)) => Err(err("auth.errors.serverUnreachable")),
        Err(ApiError::Server { code, reason }) => Err(server_error(&code, &reason)),
    }
}

/// Logs in through the server when `online` (falling back to offline if it turns
/// out to be unreachable after all), otherwise straight from the vault. The clinic's
/// owner gets a restricted `BillingSession` while the clinic cannot be used.
pub async fn login(ctx: &Context, username: &str, password: &str, online: bool) -> Result<Login, Message> {
    let username = username.trim();
    if username.is_empty() || password.is_empty() {
        return Err(err("auth.errors.invalidCredentials"));
    }

    // Connected to a clinic (setup.rs) before anyone can log in. The login screen
    // recognizes this error and lists the account's clinics instead.
    let installation = Installation::load(&ctx.data_dir)
        .map_err(internal)?
        .ok_or_else(|| err("setup.errors.required"))?;

    if !online {
        return login_offline(ctx, &installation, username, password).map(Login::Full);
    }
    match request_login(ctx, &installation, username, password).await {
        Ok((_, response)) if response.billing_only => {
            // Nobody may use the clinic now, offline included.
            revoke_offline_access(ctx, &installation, username, &response.billing_reason)?;
            billing_session(response, password).map(Login::Billing)
        }
        Ok((client_key, response)) => {
            login_online(ctx, &installation, &client_key, password, response).await.map(Login::Full)
        }
        Err(ApiError::Network(_)) => login_offline(ctx, &installation, username, password).map(Login::Full),
        Err(ApiError::Server { code, .. }) if server_unavailable(&code) => {
            login_offline(ctx, &installation, username, password).map(Login::Full)
        }
        Err(ApiError::Server { code, reason }) => {
            revoke_offline_access(ctx, &installation, username, &reason)?;
            Err(server_error(&code, &reason))
        }
    }
}

/// A billing-only LoginResponse (no keys, no grant) as a restricted session.
fn billing_session(response: proto::LoginResponse, password: &str) -> Result<BillingSession, Message> {
    let user = response.user.ok_or_else(|| internal("login response without user"))?;
    Ok(BillingSession {
        info: SessionInfo {
            user_id: hex::encode(&user.id),
            username: user.username,
            full_name: user.full_name,
            // No local database to read a role from; only the owner gets here.
            role: localdb::ROLE_MANAGER.to_owned(),
            is_admin: response.is_admin,
            is_owner: response.is_owner,
            online: true,
            offline_until: 0,
            billing: Some(billing_reason(&response.billing_reason)),
            locked: false,
        },
        token: Zeroizing::new(response.session_token),
        password: Zeroizing::new(password.to_owned()),
    })
}

/// Why the owner got a restricted session, worded for the owner, who can fix it.
fn billing_reason(reason: &str) -> Message {
    match reason {
        "subscription_inactive" => err("billing.reasons.subscriptionInactive"),
        "clinic_limit_exceeded" => err("billing.reasons.clinicLimitExceeded"),
        "device_limit_exceeded" => err("billing.reasons.deviceLimitExceeded"),
        _ => server_error("permission_denied", reason),
    }
}

/// The server no longer lets this user (or anyone) in: drops their offline access too.
fn revoke_offline_access(ctx: &Context, installation: &Installation, username: &str, reason: &str) -> Result<(), Message> {
    if !access_revoked(reason) {
        return Ok(());
    }
    let mut vault = Vault::load(&ctx.data_dir, &installation.id).map_err(internal)?;
    if reason == "installation_revoked" {
        vault.clear();
    } else {
        vault.remove_username(username);
    }
    vault.save().map_err(internal)
}

/// Sends a login request with a one-time key pair for the database keys.
async fn request_login(
    ctx: &Context,
    installation: &Installation,
    username: &str,
    password: &str,
) -> Result<(KeyPair, proto::LoginResponse), ApiError> {
    let client_key = KeyPair::generate();
    let request = proto::LoginRequest {
        installation_id: installation.id.to_vec(),
        installation_secret: installation.secret.to_vec(),
        username: username.to_owned(),
        password: password.to_owned(),
        client_public_key: client_key.public.to_vec(),
    };
    let response = ctx.api.login(&request).await?;
    Ok((client_key, response))
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

/// A successful LoginResponse, with the keys opened and the grant verified.
pub struct OnlineLogin {
    token: Zeroizing<String>,
    user: proto::User,
    is_owner: bool,
    is_admin: bool,
    current_version: u32,
    current: Option<Zeroizing<[u8; KEY_LEN]>>,
    next: Zeroizing<[u8; KEY_LEN]>,
    signed_grant: proto::SignedOfflineGrant,
    grant: proto::OfflineGrant,
    /// The later of the local clock and the server's (unix seconds).
    now: i64,
}

impl OnlineLogin {
    /// The version of `next`, which the database moves to.
    fn new_version(&self) -> u32 {
        self.current_version + 1
    }

    fn session_info(&self, role: String) -> SessionInfo {
        SessionInfo {
            user_id: hex::encode(&self.user.id),
            username: self.user.username.clone(),
            full_name: self.user.full_name.clone(),
            role,
            is_admin: self.is_admin,
            is_owner: self.is_owner,
            online: true,
            offline_until: seconds(&self.grant.expires_at),
            billing: None,
            locked: false,
        }
    }

    /// Records the login in the local database and returns the user's role there.
    fn record(&self, db: &Connection) -> Result<String, Message> {
        let default_role = if self.is_owner { localdb::ROLE_MANAGER } else { localdb::ROLE_STAFF };
        localdb::record_login(db, &self.user.id, &self.user.username, &self.user.full_name, default_role, self.now)
            .map_err(internal)
    }
}

fn open_login_response(
    ctx: &Context,
    installation: &Installation,
    client_key: &KeyPair,
    response: proto::LoginResponse,
) -> Result<OnlineLogin, Message> {
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

    Ok(OnlineLogin {
        token: Zeroizing::new(response.session_token),
        user,
        is_owner: response.is_owner,
        is_admin: response.is_admin,
        current_version: keys.current_version,
        current,
        next,
        signed_grant,
        grant,
        now: clock::now_unix().max(seconds(&response.server_time)),
    })
}

async fn login_online(
    ctx: &Context,
    installation: &Installation,
    client_key: &KeyPair,
    password: &str,
    response: proto::LoginResponse,
) -> Result<Session, Message> {
    let login = open_login_response(ctx, installation, client_key, response)?;

    // Open (or create) the database and move it to the next key.
    let db = open_and_rotate(&ctx.database_path(), login.current.as_deref(), &login.next)?;
    let role = login.record(&db)?;
    finish_online_login(ctx, installation, &login, password).await?;

    // The server's spelling of the username is used from here on.
    Ok(Session {
        info: login.session_info(role),
        db,
        key_version: login.new_version(),
        token: Some(login.token),
        reconnect_password: None,
        wrong_passwords: 0,
        data_epoch: next_data_epoch(),
    })
}

/// After the database moved to the next key: keeps offline login working for this
/// user and every other user of the vault, tells the server, and syncs who may log in.
async fn finish_online_login(
    ctx: &Context,
    installation: &Installation,
    login: &OnlineLogin,
    password: &str,
) -> Result<(), Message> {
    let database_key = DatabaseKey { version: login.new_version(), key: login.next.clone() };
    let mut vault = Vault::load(&ctx.data_dir, &installation.id).map_err(internal)?;
    vault.set_database_key(&database_key).map_err(internal)?;
    vault
        .upsert_user(&login.user.id, &login.user.username, password, &login.signed_grant, &database_key)
        .map_err(internal)?;
    vault.latest_seen = vault.latest_seen.max(login.now);
    vault.save().map_err(internal)?;
    clock::save_registry_last_seen(login.now);

    if let Err(e) = ctx.api.confirm_key_rotation(&login.token, login.new_version()).await {
        // Not fatal: the server keeps sending the same pair, and the next login
        // finds the database already on `next` and confirms then.
        eprintln!("Key rotation not confirmed yet: {e}");
    }
    sync_members(ctx, installation, &login.token).await;
    Ok(())
}

/// Drops the offline access of users who are no longer members of this
/// installation, so a user removed on the server cannot keep logging in offline.
async fn sync_members(ctx: &Context, installation: &Installation, token: &str) {
    let members = match ctx.api.list_members(token).await {
        Ok(response) => response.members,
        Err(e) => {
            eprintln!("Member list not synced: {e}");
            return;
        }
    };
    let ids: Vec<String> = members.iter().filter_map(|m| m.user.as_ref()).map(|u| hex::encode(&u.id)).collect();
    // The caller is a member, so an empty list is a broken answer: never empty the vault for it.
    if ids.is_empty() {
        return;
    }
    let result = Vault::load(&ctx.data_dir, &installation.id).and_then(|mut vault| {
        let removed = vault.retain_members(&ids);
        if removed > 0 {
            eprintln!("Removed offline access of {removed} former member(s)");
            vault.save()?;
        }
        Ok(())
    });
    if let Err(e) = result {
        eprintln!("Member list not synced: {e}");
    }
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
    // Checked first, so a missing or damaged database is reported as such.
    localdb::check_file(&ctx.database_path()).map_err(|e| {
        eprintln!("Offline login refused, database unusable: {e}");
        err("auth.errors.databaseUnavailable")
    })?;

    let mut vault = Vault::load(&ctx.data_dir, &installation.id).map_err(|e| {
        eprintln!("Offline login refused, vault unreadable: {e}");
        err("auth.errors.databaseUnavailable")
    })?;
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
            is_owner: false,
            online: false,
            offline_until: expires_at,
            billing: None,
            locked: false,
        },
        db,
        key_version: database_key.version,
        token: None,
        reconnect_password: Some(Zeroizing::new(password.to_owned())),
        wrong_passwords: 0,
        data_epoch: next_data_epoch(),
    })
}

/// Why reconnecting an offline session did not work.
pub enum ReconnectError {
    /// The server is unreachable again, or had a temporary problem: try again later.
    Later(String),
    /// The server refused (e.g. the password was changed there): stop trying.
    /// The session stays offline until the user logs in again.
    GiveUp(Message),
    /// The server no longer lets this user in: the session must end.
    Revoked(Message),
}

/// The network half of reconnecting: logs in online with the offline session's
/// credentials. Changes nothing locally except revoking offline access when the
/// server says so; `switch_online` then applies the result to the open session.
pub async fn reconnect_login(ctx: &Context, request: &ReconnectRequest) -> Result<(Installation, OnlineLogin), ReconnectError> {
    let installation = match Installation::load(&ctx.data_dir) {
        Ok(Some(installation)) => installation,
        Ok(None) => return Err(ReconnectError::GiveUp(err("setup.errors.required"))),
        Err(e) => return Err(ReconnectError::GiveUp(internal(e))),
    };

    let (client_key, response) = match request_login(ctx, &installation, &request.username, &request.password).await {
        Ok(result) => result,
        Err(ApiError::Network(e)) => return Err(ReconnectError::Later(e)),
        Err(ApiError::Server { code, reason }) if server_unavailable(&code) => {
            return Err(ReconnectError::Later(format!("{code}: {reason}")));
        }
        Err(ApiError::Server { code, reason }) => {
            if let Err(e) = revoke_offline_access(ctx, &installation, &request.username, &reason) {
                eprintln!("Could not revoke offline access: {}", e.key);
            }
            let message = server_error(&code, &reason);
            return Err(if access_revoked(&reason) { ReconnectError::Revoked(message) } else { ReconnectError::GiveUp(message) });
        }
    };

    if response.billing_only {
        // The subscription ended while the session was offline: it ends too, and the
        // owner logs in again to the restricted session.
        let _ = ctx.api.logout(&response.session_token).await;
        if let Err(e) = revoke_offline_access(ctx, &installation, &request.username, &response.billing_reason) {
            eprintln!("Could not revoke offline access: {}", e.key);
        }
        return Err(ReconnectError::Revoked(server_error("permission_denied", &response.billing_reason)));
    }
    let login = open_login_response(ctx, &installation, &client_key, response).map_err(ReconnectError::GiveUp)?;
    if hex::encode(&login.user.id) != request.user_id {
        return Err(ReconnectError::GiveUp(err("auth.errors.invalidGrant")));
    }
    Ok((installation, login))
}

/// Turns the open offline session into an online one, keeping its database
/// connection open: the database is rekeyed in place to the server's next key.
/// Call while holding the session; it does no network work.
pub fn switch_online(ctx: &Context, session: &mut Session, login: &OnlineLogin) -> Result<(), Message> {
    if session.key_version == login.current_version {
        localdb::rekey(&session.db, &login.next).map_err(internal)?;
        // Prove the new key works before the server is told.
        drop(localdb::open(&ctx.database_path(), &login.next).map_err(internal)?);
    } else if session.key_version != login.new_version() {
        // Already on `next` is fine (an earlier rotation was never confirmed); anything else is not.
        return Err(internal(format!(
            "database key version {} does not match the server's {}",
            session.key_version, login.current_version
        )));
    }

    let role = login.record(&session.db)?;
    // Reconnecting never unlocks: the lock screen stays until the password is given.
    let locked = session.info.locked;
    session.info = SessionInfo { locked, ..login.session_info(role) };
    session.key_version = login.new_version();
    session.token = Some(login.token.clone());
    session.reconnect_password = None;
    Ok(())
}

/// The local half of reconnecting, after `switch_online`: vault, key confirmation, members.
pub async fn finish_reconnect(
    ctx: &Context,
    installation: &Installation,
    login: &OnlineLogin,
    request: &ReconnectRequest,
) -> Result<(), Message> {
    finish_online_login(ctx, installation, login, &request.password).await
}

/// Ends a server session nobody uses (a reconnect whose session was closed meanwhile).
pub async fn discard_login(ctx: &Context, login: OnlineLogin) {
    let _ = ctx.api.logout(&login.token).await;
}

/// Ends a restricted session on the server.
pub async fn logout_billing(ctx: &Context, session: BillingSession) {
    let _ = ctx.api.logout(session.token()).await;
}

/// Ends the session on the server (if online) and closes the database.
pub async fn logout(ctx: &Context, session: Session) {
    if let Some(token) = session.token() {
        let _ = ctx.api.logout(token).await;
    }
    drop(session); // closes the database; the token and password are wiped on drop
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

    /// An identification code, different for each `n` below 10^8.
    fn identity_code(n: u64) -> String {
        format!("T{:08}", n % 100_000_000)
    }

    /// The login screen as the app would decide it: after a real connectivity check.
    async fn mode(ctx: &Context) -> ConnectionMode {
        let status = crate::connectivity::Watcher::new(ctx.api.clone()).refresh().await;
        connection_mode(ctx, &status)
    }

    #[test]
    #[ignore = "needs the development server"]
    fn e2e_online_and_offline_login() {
        tauri::async_runtime::block_on(flow());
    }

    async fn flow() {
        let online = context("online");
        assert_eq!(mode(&online).await, ConnectionMode::Setup);
        let doctor = unique("doctor");
        let error = login(&online, &doctor, "Doctor-passw0rd", true).await.err().unwrap();
        assert_eq!(error.key, "setup.errors.required");

        // The doctor signs up; with no clinic yet, they add theirs and this computer joins it.
        let account = SignUpInput {
            username: doctor.clone(),
            password: "Doctor-passw0rd".into(),
            full_name: "Dr. Test".into(),
            identity: identity_code(clock::now_unix() as u64),
            phone: "09121234567".into(),
            email: "doctor@example.com".into(),
        };
        sign_up(&online, &account).await.unwrap();
        let error = setup::my_clinics(&online, &doctor, "wrong-password").await.err().unwrap();
        assert_eq!(error.key, "auth.errors.invalidCredentials");
        let mine = setup::my_clinics(&online, &doctor, "Doctor-passw0rd").await.unwrap();
        assert!(mine.clinics.is_empty() && mine.identity_on_file);
        assert_eq!(mine.full_name, "Dr. Test");

        let target = setup::SetupTarget::New(setup::NewClinicInput {
            clinic: setup::ClinicInput {
                name: "Test clinic".into(),
                license_number: unique("E2E-"),
                phone: "02112345678".into(),
                // Tehran (migration 00011_iran_cities.sql in dental-server).
                city_id: 341,
                address: "1 Test Street".into(),
                postal_code: String::new(),
                latitude: 35.6892,
                longitude: 51.389,
            },
            identity: String::new(),
        });
        // A first clinic starts a free plan by itself when the server has one on sale.
        let trial = setup::setup(&online, &doctor, "Doctor-passw0rd", &target).await.unwrap();
        assert_eq!(mode(&online).await, ConnectionMode::Online);
        let error = setup::setup(&online, &doctor, "Doctor-passw0rd", &target).await.err().unwrap();
        assert_eq!(error.key, "setup.errors.alreadyDone");

        // A second computer: the clinic is listed and can be picked.
        let second = context("second");
        let mine = setup::my_clinics(&second, &doctor, "Doctor-passw0rd").await.unwrap();
        assert_eq!(mine.clinics.len(), 1);
        assert!(mine.clinics[0].is_owner);
        let license_number = mine.clinics[0].license_number.clone();
        let existing = setup::SetupTarget::Existing(setup::ExistingClinicInput { license_number });
        setup::setup(&second, &doctor, "Doctor-passw0rd", &existing).await.unwrap();
        assert_eq!(mode(&second).await, ConnectionMode::Online);

        if let Some(trial) = trial {
            assert!(trial.ends_at > clock::now_unix());
            // So the first login is a full one, and the full-login checks run with this owner.
            return full_flow(&online, &doctor, "Doctor-passw0rd").await;
        }

        // No free plan on sale: a new owner has no subscription, so a restricted login, only for buying one.
        let Login::Billing(billing) = login(&online, &doctor, "Doctor-passw0rd", true).await.unwrap() else {
            panic!("a new owner has no subscription, so the login is billing-only");
        };
        assert!(billing.info.is_owner && billing.info.billing.is_some());
        let status = crate::billing::status(&online, billing.token()).await.unwrap();
        assert!(status.current.is_none() && status.pending_payment.is_none());
        assert_eq!(status.clinics.len(), 1);
        crate::billing::plans(&online, billing.token()).await.unwrap();
        // No database keys and no offline access came with it.
        assert_eq!(local_login_status(&online), LocalLogin::NobodyYet);

        // A free plan (one the admin panel made) is active at once, and logging in
        // again with the kept password opens the full session (lib.rs resume_login).
        let plans = crate::billing::plans(&online, billing.token()).await.unwrap();
        if let Some(free) = plans.iter().find(|plan| plan.price_rials == 0 && plan.purchased == 0) {
            let input = crate::billing::PaymentInput {
                plan_id: free.id.clone(),
                mode: crate::billing::PurchaseMode::Extend,
                method: crate::billing::PaymentMethod::Free,
                payment_account_id: String::new(),
                reference: String::new(),
                paid_at: 0,
                payer_card_last4: String::new(),
            };
            let payment = crate::billing::create_payment(&online, billing.token(), &input).await.unwrap();
            assert_eq!(payment.status, crate::billing::PaymentStatus::Approved);
            let (username, password) = billing.resume_request();
            let Login::Full(session) = login(&online, &username, &password, true).await.unwrap() else {
                panic!("still billing-only after a free plan was activated");
            };
            assert!(session.info.billing.is_none() && session.info.is_owner);
            logout(&online, session).await;
        } else {
            eprintln!("Free activation not tested: no free plan left to take on the server");
        }
        logout_billing(&online, billing).await;

        // Full logins need a subscription in force, sold in the admin panel.
        let (Ok(owner), Ok(password)) = (std::env::var("DENTAL_E2E_OWNER"), std::env::var("DENTAL_E2E_PASSWORD")) else {
            eprintln!("Full logins not tested: set DENTAL_E2E_OWNER and DENTAL_E2E_PASSWORD to an owner with a subscription");
            return;
        };
        let online = context("full");
        let mine = setup::my_clinics(&online, &owner, &password).await.unwrap();
        let clinic = mine.clinics.iter().find(|clinic| clinic.cannot_add.is_none()).expect("a clinic with room");
        let license_number = clinic.license_number.clone();
        let target = setup::SetupTarget::Existing(setup::ExistingClinicInput { license_number });
        setup::setup(&online, &owner, &password, &target).await.unwrap();
        full_flow(&online, &owner, &password).await;
    }

    /// Online and offline logins of an owner whose subscription is in force, on the
    /// installation `online`, already registered to one of their clinics.
    async fn full_flow(online: &Context, doctor: &str, password: &str) {
        let full = |login: Login| match login {
            Login::Full(session) => session,
            Login::Billing(_) => panic!("billing-only login despite the subscription"),
        };

        // First login: already owner, database is created.
        let session = full(login(&online, doctor, password, true).await.unwrap());
        assert!(session.info.online && session.info.is_admin);
        assert_eq!(session.info.role, localdb::ROLE_MANAGER);
        assert!(session.info.offline_until > clock::now_unix() + 6 * 24 * 3600);
        assert!(session.reconnect_request().is_none(), "online sessions keep no password");
        // "Is it really you?" works right after an online login, against the vault.
        assert_eq!(verify_password(&online, &session.info, "wrong-password").unwrap_err().key, WRONG_PASSWORD);
        verify_password(&online, &session.info, password).unwrap();
        logout(&online, session).await;

        // Second login rotates the key; the database still opens.
        let session = full(login(&online, doctor, password, true).await.unwrap());
        logout(&online, session).await;

        assert!(login(&online, doctor, "wrong-password", true).await.is_err());

        // Same installation, server unreachable: offline login from the vault.
        let offline = Context::new(online.data_dir.clone(), Api::new("http://127.0.0.1:9"));
        assert_eq!(mode(&offline).await, ConnectionMode::Offline);
        let nothing_here = Context::new(context("empty").data_dir, Api::new("http://127.0.0.1:9"));
        assert_eq!(mode(&nothing_here).await, ConnectionMode::Unavailable);

        let error = login(&offline, doctor, "wrong-password", false).await.err().unwrap();
        assert_eq!(error.key, "auth.errors.invalidCredentials");
        let error = login(&offline, "someone-else", "whatever-password", false).await.err().unwrap();
        assert_eq!(error.key, "auth.errors.offlineNotAvailable");

        let mut session = full(login(&offline, doctor, password, false).await.unwrap());
        assert!(!session.info.online);
        assert_eq!(session.info.role, localdb::ROLE_MANAGER, "role read from the local database");

        // The server is back: the open offline session reconnects in place.
        let request = session.reconnect_request().expect("offline session can reconnect");
        let (installation, reconnected) = match reconnect_login(&online, &request).await {
            Ok(result) => result,
            Err(_) => panic!("reconnect login failed"),
        };
        assert!(session.is_waiting_for(&request));
        switch_online(&online, &mut session, &reconnected).unwrap();
        finish_reconnect(&online, &installation, &reconnected, &request).await.unwrap();
        assert!(session.info.online && session.token().is_some());
        assert!(session.reconnect_request().is_none(), "password wiped once online");
        // The same connection keeps working after the rekey.
        localdb::record_login(&session.db, &[9; 16], "someone", "Some One", localdb::ROLE_STAFF, clock::now_unix()).unwrap();
        logout(&online, session).await;

        // Keys stay consistent afterwards, online and offline.
        let session = full(login(&online, doctor, password, true).await.unwrap());
        logout(&online, session).await;
        let session = full(login(&offline, doctor, password, false).await.unwrap());
        drop(session);

        // A damaged database: offline login is refused, with its own screen.
        let path = offline.database_path();
        let mut bytes = std::fs::read(&path).unwrap();
        bytes.truncate(1000);
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(mode(&offline).await, ConnectionMode::LocalDatabaseUnavailable);
        let error = login(&offline, doctor, password, false).await.err().unwrap();
        assert_eq!(error.key, "auth.errors.databaseUnavailable");
    }

    #[test]
    fn logs_out_after_wrong_passwords_in_a_row() {
        let mut session = Session {
            info: SessionInfo {
                user_id: hex::encode([1u8; 16]),
                username: "doctor".into(),
                full_name: "Dr. A".into(),
                role: localdb::ROLE_MANAGER.into(),
                is_admin: true,
                is_owner: true,
                online: true,
                offline_until: 0,
                billing: None,
                locked: false,
            },
            db: Connection::open_in_memory().unwrap(),
            key_version: 1,
            token: None,
            reconnect_password: None,
            wrong_passwords: 0,
            data_epoch: next_data_epoch(),
        };
        assert_eq!(MAX_WRONG_PASSWORDS, 3);
        assert_eq!(session.wrong_password(), 2);
        assert_eq!(session.wrong_password(), 1);
        // A right password starts the count again.
        session.right_password();
        assert_eq!(session.wrong_password(), 2);
        assert_eq!(session.wrong_password(), 1);
        assert_eq!(session.wrong_password(), 0, "third wrong one in a row: log out");
    }
}
