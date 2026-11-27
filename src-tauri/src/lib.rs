mod api;
mod auth;
mod backup;
mod billing;
mod clock;
mod connectivity;
mod device;
mod languages;
mod localdb;
mod lockdown;
mod message;
mod patients;
mod person;
mod profile;
mod proto;
mod secure;
mod settings;
mod setup;
mod sync;
mod update;
mod vault;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use auth::{BillingSession, ConnectionMode, Context, ReconnectError, Session, SessionInfo};
use connectivity::{ConnectivityState, ConnectivityStatus, Watcher};
use message::Message;
use tauri::{AppHandle, Emitter, Manager, State};
use zeroize::Zeroizing;

/// Sent to the frontend when the session changes by itself (an offline session
/// reconnected); the payload is the new SessionInfo.
const SESSION_EVENT: &str = "session";
/// Sent when the session ended by itself: the server revoked access, or too many
/// wrong passwords were given for a database action. The payload is
/// the Message to show on the login screen.
const SESSION_ENDED_EVENT: &str = "session-ended";

/// The current login, if any. Only one user is logged in at a time.
struct AuthState {
    ctx: Context,
    watcher: Arc<Watcher>,
    session: Mutex<Option<Session>>,
    /// The clinic owner's restricted login (no subscription in force): only the
    /// subscription calls work. Never set together with `session`.
    billing: Mutex<Option<BillingSession>>,
    /// Held by login, setup, reconnecting, backups and clearing: they never overlap, since each may
    /// rotate the database key, write the vault or copy the database. A second request while one
    /// runs is refused instead of queued (no duplicate logins).
    busy: tauri::async_runtime::Mutex<()>,
    /// Sends the clinic's changes to the server and fetches the others' (sync.rs).
    syncer: sync::Syncer,
    /// New versions and forced updates (update.rs).
    updates: update::Updates,
}

/// The error for a call refused while the session is locked (`lock_session`).
const LOCKED_ERROR: &str = "auth.errors.locked";

/// Runs `work` on the open session. For commands that read or change clinic data:
/// refused while the session is locked.
fn with_session<T>(state: &AuthState, work: impl FnOnce(&Session) -> Result<T, Message>) -> Result<T, Message> {
    let guard = state.session.lock().unwrap();
    let session = guard.as_ref().ok_or_else(|| Message::new("errors.notLoggedIn"))?;
    if session.info.locked {
        return Err(Message::new(LOCKED_ERROR));
    }
    work(session)
}

/// Syncs in the background: after a local change, a login, and every connectivity
/// check while online. Never while this version must be updated first.
fn request_sync(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AuthState>();
        let online = state.session.lock().unwrap().as_ref().is_some_and(|s| s.token().is_some());
        if !online || state.updates.is_required() {
            // Nothing to send to yet; the change still counts as waiting.
            let _ = app.emit(sync::EVENT, state.syncer.status(&state.session));
            return;
        }
        let result = state
            .syncer
            .sync(&state.ctx.api, &state.session, |status| {
                let _ = app.emit(sync::EVENT, status);
            })
            .await;
        if let Err(e) = result {
            if e.is_update_required() {
                update_required_by_server(&app, &state);
            }
        }
    });
}

/// The server refused a call because this version is too old.
fn update_required_by_server(app: &AppHandle, state: &AuthState) {
    if state.updates.server_requires_update() {
        let _ = app.emit(update::EVENT, state.updates.status());
    }
}

#[tauri::command]
fn update_status(state: State<'_, AuthState>) -> update::UpdateStatus {
    state.updates.status()
}

/// Looks for a new version now.
#[tauri::command]
async fn check_for_update(app: AppHandle, state: State<'_, AuthState>) -> Result<update::UpdateStatus, Message> {
    Ok(state.updates.check(&app, state.ctx.api.base_url()).await)
}

/// Installs the version found by the last check. Logs out first, so the database
/// is closed and locked before the installer replaces the app; changes not synced
/// yet stay marked in it and are sent after the restart.
#[tauri::command]
async fn install_update(app: AppHandle, state: State<'_, AuthState>) -> Result<(), Message> {
    let Ok(_busy) = state.busy.try_lock() else {
        return Err(Message::new("auth.errors.busy"));
    };
    let open = state.session.lock().unwrap().is_some() || state.billing.lock().unwrap().is_some();
    if open {
        end_sessions(&state).await;
        let _ = app.emit(SESSION_ENDED_EVENT, Message::new("update.loggedOut"));
    }
    state.updates.install(&app).await
}

#[tauri::command]
fn sync_status(state: State<'_, AuthState>) -> sync::SyncStatus {
    state.syncer.status(&state.session)
}

/// Syncs now (the "sync" button), in the background; progress comes as "sync" events.
#[tauri::command]
fn sync_now(app: AppHandle) {
    request_sync(&app);
}

#[tauri::command]
fn list_patients(state: State<'_, AuthState>, query: String, page: u32) -> Result<patients::PatientPage, Message> {
    with_session(&state, |session| patients::list_patients(&session.db, &query, page))
}

#[tauri::command]
fn get_patient(state: State<'_, AuthState>, id: String) -> Result<Option<patients::PatientRecord>, Message> {
    let Ok(id) = hex::decode(&id) else { return Ok(None) };
    with_session(&state, |session| patients::get_patient(&session.db, &id))
}

/// Adds or updates a patient (see patients::save_patient) and syncs it.
#[tauri::command]
fn save_patient(
    app: AppHandle,
    state: State<'_, AuthState>,
    id: Option<String>,
    patient: patients::PatientInput,
) -> Result<patients::PatientRecord, Message> {
    let saved = with_session(&state, |session| {
        patients::save_patient(&session.db, id.as_deref(), &patient, clock::now_millis())
    })?;
    request_sync(&app);
    Ok(saved)
}

#[tauri::command]
fn list_treatments(state: State<'_, AuthState>, patient_id: String) -> Result<Vec<patients::TreatmentRecord>, Message> {
    with_session(&state, |session| patients::list_treatments(&session.db, &patient_id))
}

/// Adds (no `id`) or updates a treatment and syncs it.
#[tauri::command]
fn save_treatment(
    app: AppHandle,
    state: State<'_, AuthState>,
    id: Option<String>,
    treatment: patients::TreatmentInput,
) -> Result<patients::TreatmentRecord, Message> {
    let saved = with_session(&state, |session| {
        patients::save_treatment(&session.db, id.as_deref(), &treatment, clock::now_millis())
    })?;
    request_sync(&app);
    Ok(saved)
}

/// Everyone who has logged in on this computer: who may have performed a treatment.
#[tauri::command]
fn list_local_users(state: State<'_, AuthState>) -> Result<Vec<localdb::LocalUser>, Message> {
    with_session(&state, |session| {
        localdb::list_users(&session.db).map_err(|e| Message::error("errors.unknown", e))
    })
}

#[tauri::command]
fn delete_treatment(app: AppHandle, state: State<'_, AuthState>, id: String) -> Result<(), Message> {
    with_session(&state, |session| patients::delete_treatment(&session.db, &id, clock::now_millis()))?;
    request_sync(&app);
    Ok(())
}

/// A patient's history in every clinic, from the server (online only). The server
/// logs who looked.
#[tauri::command]
async fn patient_history(
    app: AppHandle,
    state: State<'_, AuthState>,
    identity: String,
) -> Result<patients::PatientHistory, Message> {
    let request = person::to_proto(&identity)?;
    let token = with_session(&state, |session| {
        session.token().map(str::to_owned).ok_or_else(|| Message::new("patients.errors.historyNeedsServer"))
    })?;
    match state.ctx.api.patient_history(&token, request).await {
        Ok(response) => Ok(patients::history_from_proto(response)),
        Err(api::ApiError::Network(e)) => Err(Message::error("errors.network", e)),
        Err(api::ApiError::Server { code, reason }) => {
            if reason == api::UPDATE_REQUIRED {
                update_required_by_server(&app, &state);
            }
            Err(auth::server_error(&code, &reason))
        }
    }
}

#[tauri::command]
fn current_session(state: State<'_, AuthState>) -> Option<SessionInfo> {
    if let Some(billing) = state.billing.lock().unwrap().as_ref() {
        return Some(billing.info.clone());
    }
    state.session.lock().unwrap().as_ref().map(|s| s.info.clone())
}

/// The latest connectivity status, without checking (the header indicator).
#[tauri::command]
fn connectivity_status(state: State<'_, AuthState>) -> ConnectivityStatus {
    state.watcher.status()
}

/// Checks connectivity now (or joins the check already running) and returns the result.
#[tauri::command]
async fn check_connectivity(state: State<'_, AuthState>) -> Result<ConnectivityStatus, Message> {
    Ok(state.watcher.refresh().await)
}

/// Which login screen to show. Checks the server first when `refresh` is set
/// (startup, "retry") or nothing was checked yet; otherwise uses the latest status.
#[tauri::command]
async fn connection_status(state: State<'_, AuthState>, refresh: bool) -> Result<ConnectionMode, Message> {
    let mut status = state.watcher.status();
    if refresh || status.state == ConnectivityState::Checking {
        status = state.watcher.refresh().await;
    }
    Ok(auth::connection_mode(&state.ctx, &status))
}

/// First start, after a login refused with "setup.errors.required": the clinics
/// the account owns or administers, to pick the one this computer belongs to.
#[tauri::command]
async fn list_my_clinics(
    state: State<'_, AuthState>,
    username: String,
    password: String,
) -> Result<setup::MyClinics, Message> {
    let password = Zeroizing::new(password);
    if state.updates.is_required() {
        return Err(Message::new(update::REQUIRED_ERROR));
    }
    setup::my_clinics(&state.ctx, &username, &password).await
}

/// Iran's provinces and cities, for a new clinic's city.
#[tauri::command]
async fn list_cities(state: State<'_, AuthState>) -> Result<Vec<setup::Province>, Message> {
    setup::cities(&state.ctx).await
}

/// First start: connects this computer to one clinic of the account, new or
/// existing, for good. The frontend then logs in with the same credentials.
/// Returns the free trial a first clinic may have started.
#[tauri::command]
async fn setup_clinic(
    state: State<'_, AuthState>,
    username: String,
    password: String,
    target: setup::SetupTarget,
) -> Result<Option<setup::FreeTrial>, Message> {
    let password = Zeroizing::new(password);
    let Ok(_busy) = state.busy.try_lock() else {
        return Err(Message::new("auth.errors.busy"));
    };
    if state.updates.is_required() {
        return Err(Message::new(update::REQUIRED_ERROR));
    }
    setup::setup(&state.ctx, &username, &password, &target).await
}

/// Replaces a temporary password (or any password, proven with the current one).
/// The frontend then logs in with the new one.
#[tauri::command]
async fn change_password(
    state: State<'_, AuthState>,
    username: String,
    current_password: String,
    new_password: String,
) -> Result<(), Message> {
    let (current_password, new_password) = (Zeroizing::new(current_password), Zeroizing::new(new_password));
    if state.updates.is_required() {
        return Err(Message::new(update::REQUIRED_ERROR));
    }
    auth::change_password(&state.ctx, &username, &current_password, &new_password).await
}

#[tauri::command]
async fn sign_up(state: State<'_, AuthState>, account: auth::SignUpInput) -> Result<Message, Message> {
    auth::sign_up(&state.ctx, &account).await?;
    Ok(Message::new("auth.signUpSuccess"))
}

#[tauri::command]
async fn login(app: AppHandle, state: State<'_, AuthState>, username: String, password: String) -> Result<SessionInfo, Message> {
    let Ok(_busy) = state.busy.try_lock() else {
        return Err(Message::new("auth.errors.busy"));
    };
    // Offline too: a version the server has stopped must be updated first.
    if state.updates.is_required() {
        return Err(Message::new(update::REQUIRED_ERROR));
    }
    // A new login replaces the previous one.
    end_sessions(&state).await;

    // The watcher decides online or offline; a stale "not online" is checked again first.
    let online = state.watcher.status().is_online() || state.watcher.refresh().await.is_online();
    let login = auth::login(&state.ctx, &username, &password, online).await.inspect_err(|e| {
        if e.key == update::REQUIRED_ERROR {
            update_required_by_server(&app, &state);
        }
    })?;
    if let auth::Login::Full(session) = &login {
        if online && !session.info.online {
            // The server went away since the last check: let everyone know now.
            let watcher = Arc::clone(&state.watcher);
            tauri::async_runtime::spawn(async move { watcher.refresh().await });
        }
    }
    Ok(keep_login(&app, &state, login))
}

/// Makes `login` the open one. Call with `busy` held and no session open.
fn keep_login(app: &AppHandle, state: &AuthState, login: auth::Login) -> SessionInfo {
    match login {
        auth::Login::Full(session) => {
            let info = session.info.clone();
            *state.session.lock().unwrap() = Some(session);
            // Changes made offline go out now, and what other installations changed comes in.
            request_sync(app);
            info
        }
        auth::Login::Billing(billing) => {
            // Restricted: no database, nothing to sync.
            let info = billing.info.clone();
            *state.billing.lock().unwrap() = Some(billing);
            info
        }
    }
}

/// A restricted login after a purchase is approved (or activated at once): logs in
/// again with the kept credentials, so the clinic opens without typing the password.
/// Returns the new session: full, or still restricted if the subscription does not
/// cover this clinic and computer yet. On failure the restricted session stays open.
#[tauri::command]
async fn resume_login(app: AppHandle, state: State<'_, AuthState>) -> Result<SessionInfo, Message> {
    let Ok(_busy) = state.busy.try_lock() else {
        return Err(Message::new("auth.errors.busy"));
    };
    let (username, password) = state
        .billing
        .lock()
        .unwrap()
        .as_ref()
        .map(BillingSession::resume_request)
        .ok_or_else(|| Message::new("errors.notLoggedIn"))?;
    let login = auth::login(&state.ctx, &username, &password, true).await?;
    // Replaced: the old restricted session ends on the server too.
    let previous = state.billing.lock().unwrap().take();
    if let Some(previous) = previous {
        auth::logout_billing(&state.ctx, previous).await;
    }
    Ok(keep_login(&app, &state, login))
}

/// Never waits for a reconnect in progress: the session is closed at once, and a
/// reconnect that finishes later finds it gone and discards its result.
#[tauri::command]
async fn logout(state: State<'_, AuthState>) -> Result<(), Message> {
    end_sessions(&state).await;
    Ok(())
}

/// Ends the open login, full or restricted, on the server too.
async fn end_sessions(state: &AuthState) {
    let session = state.session.lock().unwrap().take();
    if let Some(session) = session {
        auth::logout(&state.ctx, session).await;
    }
    let billing = state.billing.lock().unwrap().take();
    if let Some(billing) = billing {
        auth::logout_billing(&state.ctx, billing).await;
    }
}

// --- Subscription (billing.rs) ---------------------------------------------

/// The owner's server token: the restricted session's, or a full online session's.
fn billing_token(state: &AuthState) -> Result<String, Message> {
    server_token(state, "billing.errors.needsServer")
}

/// The open login's server token: the restricted session's, or a full online
/// session's (not while locked). `offline_error` is the error for an offline session.
fn server_token(state: &AuthState, offline_error: &str) -> Result<String, Message> {
    if let Some(billing) = state.billing.lock().unwrap().as_ref() {
        return Ok(billing.token().to_owned());
    }
    with_session(state, |session| session.token().map(str::to_owned).ok_or_else(|| Message::new(offline_error)))
}

#[tauri::command]
async fn billing_status(state: State<'_, AuthState>) -> Result<billing::BillingStatus, Message> {
    let token = Zeroizing::new(billing_token(&state)?);
    billing::status(&state.ctx, &token).await
}

#[tauri::command]
async fn list_plans(state: State<'_, AuthState>) -> Result<Vec<billing::Plan>, Message> {
    let token = Zeroizing::new(billing_token(&state)?);
    billing::plans(&state.ctx, &token).await
}

#[tauri::command]
async fn quote_payment(
    state: State<'_, AuthState>,
    plan_id: String,
    mode: billing::PurchaseMode,
) -> Result<billing::Quote, Message> {
    let token = Zeroizing::new(billing_token(&state)?);
    billing::quote(&state.ctx, &token, &plan_id, mode).await
}

#[tauri::command]
async fn create_payment(state: State<'_, AuthState>, payment: billing::PaymentInput) -> Result<billing::Payment, Message> {
    let token = Zeroizing::new(billing_token(&state)?);
    billing::create_payment(&state.ctx, &token, &payment).await
}

#[tauri::command]
async fn list_my_payments(state: State<'_, AuthState>) -> Result<Vec<billing::Payment>, Message> {
    let token = Zeroizing::new(billing_token(&state)?);
    billing::payments(&state.ctx, &token).await
}

#[tauri::command]
async fn cancel_payment(state: State<'_, AuthState>, id: String) -> Result<billing::Payment, Message> {
    let token = Zeroizing::new(billing_token(&state)?);
    billing::cancel_payment(&state.ctx, &token, &id).await
}

/// Runs a database action (export, restore, clear) under Rust's own checks,
/// whatever the UI shows: only for the logged-in manager, while not locked, and
/// only with their own account password (`with_account_password`).
async fn run_database_action<T>(
    app: &AppHandle,
    state: &AuthState,
    account_password: &str,
    action: impl FnOnce(&mut Session) -> Result<T, Message>,
) -> Result<T, Message> {
    // Never during a login or a reconnect, which may rekey the database.
    let Ok(_busy) = state.busy.try_lock() else {
        return Err(Message::new("auth.errors.busy"));
    };
    with_account_password(app, state, account_password, "a database action", unlocked_manager, action).await
}

/// The open session, if its user is a manager and it is not locked.
fn unlocked_manager(session: Option<&Session>) -> Result<&Session, Message> {
    let session = backup::manager_session(session)?;
    if session.info.locked {
        return Err(Message::new(LOCKED_ERROR));
    }
    Ok(session)
}

/// The open session, whatever its state.
fn open_session(session: Option<&Session>) -> Result<&Session, Message> {
    session.ok_or_else(|| Message::new("errors.notLoggedIn"))
}

/// Runs `action` on the open session once the user has proven it is them with
/// their own account password. `allowed` decides whether the session may do it,
/// checked before the password and again after (no logout or other login in the
/// meantime). After `MAX_WRONG_PASSWORDS` wrong ones in a row the session is
/// logged out, and the frontend told as for a revoked session; `what` names the
/// action in the log.
async fn with_account_password<T>(
    app: &AppHandle,
    state: &AuthState,
    password: &str,
    what: &str,
    allowed: impl Fn(Option<&Session>) -> Result<&Session, Message>,
    action: impl FnOnce(&mut Session) -> Result<T, Message>,
) -> Result<T, Message> {
    let user = {
        let guard = state.session.lock().unwrap();
        allowed(guard.as_ref())?.info.clone()
    };
    // Slow (Argon2id): the session stays free meanwhile.
    let checked = auth::verify_password(&state.ctx, &user, password);

    let ended = {
        let mut guard = state.session.lock().unwrap();
        if allowed(guard.as_ref())?.info.user_id != user.user_id {
            return Err(Message::new("errors.notLoggedIn"));
        }
        let session = guard.as_mut().expect("checked above");
        match checked {
            Ok(()) => {
                session.right_password();
                return action(session);
            }
            Err(e) if e.key != auth::WRONG_PASSWORD => return Err(e),
            Err(e) => match session.wrong_password() {
                0 => guard.take(),
                left => return Err(e.with("left", left)),
            },
        }
    };

    let message = Message::new("identity.errors.tooManyAttempts").with("max", auth::MAX_WRONG_PASSWORDS);
    if let Some(session) = ended {
        eprintln!("Logged out: {} wrong passwords in a row for {what}", auth::MAX_WRONG_PASSWORDS);
        auth::logout(&state.ctx, session).await;
        let _ = app.emit(SESSION_ENDED_EVENT, message.clone());
    }
    Err(message)
}

// --- Locking (the lock screen) ---------------------------------------------

/// Locks the open login: the lock screen shows, and clinic data stays closed
/// (`with_session`) until `unlock_session`. The database stays open and syncing
/// goes on. Only a full session can be locked.
#[tauri::command]
fn lock_session(state: State<'_, AuthState>) -> Result<SessionInfo, Message> {
    let mut guard = state.session.lock().unwrap();
    let session = guard.as_mut().ok_or_else(|| Message::new("errors.notLoggedIn"))?;
    session.info.locked = true;
    Ok(session.info.clone())
}

/// Opens a locked login again with the user's own password. Wrong ones count as
/// for database actions: after `MAX_WRONG_PASSWORDS` in a row, it logs out.
#[tauri::command]
async fn unlock_session(app: AppHandle, state: State<'_, AuthState>, password: String) -> Result<SessionInfo, Message> {
    let password = Zeroizing::new(password);
    with_account_password(&app, &state, &password, "unlocking", open_session, |session| {
        session.info.locked = false;
        Ok(session.info.clone())
    })
    .await
}

// --- The user's own account (profile.rs) -----------------------------------

#[tauri::command]
async fn get_profile(app: AppHandle, state: State<'_, AuthState>) -> Result<profile::Profile, Message> {
    let token = Zeroizing::new(server_token(&state, "account.errors.needsServer")?);
    profile::get(&state.ctx, &token).await.inspect_err(|e| check_update_required(&app, &state, e))
}

/// Changes the user's full name, phone and email on the server, then shows the new name
/// in the open login (and the local list of users) at once. Returns the session.
#[tauri::command]
async fn update_profile(
    app: AppHandle,
    state: State<'_, AuthState>,
    profile: profile::ProfileInput,
) -> Result<SessionInfo, Message> {
    let token = Zeroizing::new(server_token(&state, "account.errors.needsServer")?);
    let updated =
        profile::update(&state.ctx, &token, &profile).await.inspect_err(|e| check_update_required(&app, &state, e))?;
    // Still the same user: no logout or other login in the meantime.
    let same_user = |info: &SessionInfo| info.username.eq_ignore_ascii_case(&updated.username);

    if let Some(billing) = state.billing.lock().unwrap().as_mut().filter(|b| same_user(&b.info)) {
        billing.info.full_name = updated.full_name;
        return Ok(billing.info.clone());
    }
    let mut guard = state.session.lock().unwrap();
    let session = guard.as_mut().filter(|s| same_user(&s.info)).ok_or_else(|| Message::new("errors.notLoggedIn"))?;
    session.info.full_name = updated.full_name;
    if let Err(e) = profile::record_full_name(&session.db, &session.info.user_id, &session.info.full_name) {
        // Written again at the next login anyway.
        eprintln!("Could not save the new name locally: {e}");
    }
    Ok(session.info.clone())
}

/// Tells the frontend when a server call failed because this version must be updated first.
fn check_update_required(app: &AppHandle, state: &AuthState, error: &Message) {
    if error.key == update::REQUIRED_ERROR {
        update_required_by_server(app, state);
    }
}

/// Saves an encrypted copy of the clinic database to `path` (chosen by the user
/// in a Save dialog). Returns the recovery key: shown once, never stored.
#[tauri::command]
async fn export_database(
    app: AppHandle,
    state: State<'_, AuthState>,
    account_password: String,
    path: PathBuf,
    password: String,
) -> Result<String, Message> {
    let (account_password, password) = (Zeroizing::new(account_password), Zeroizing::new(password));
    run_database_action(&app, &state, &account_password, |session| {
        backup::export(&session.db, &state.ctx.data_dir, &path, &password)
    })
    .await
}

/// Restores the backup at `path` into the clinic database, replacing its contents
/// or merging into them (`mode`).
#[tauri::command]
async fn restore_database(
    app: AppHandle,
    state: State<'_, AuthState>,
    account_password: String,
    path: PathBuf,
    password: String,
    recovery_key: String,
    mode: backup::RestoreMode,
) -> Result<(), Message> {
    let account_password = Zeroizing::new(account_password);
    let (password, recovery_key) = (Zeroizing::new(password), Zeroizing::new(recovery_key));
    run_database_action(&app, &state, &account_password, |session| {
        backup::restore(&session.db, &session.info, &state.ctx.data_dir, &path, &password, &recovery_key, mode)?;
        // The restored data is not what the server last saw: all of it is synced again,
        // and a sync running meanwhile drops its answer.
        session.data_replaced();
        if let Err(e) = sync::resync_all(&session.db) {
            eprintln!("Restored, but not marked for syncing: {e}");
        }
        Ok(())
    })
    .await?;
    request_sync(&app);
    Ok(())
}

/// Deletes all clinic data on this computer, then logs out: the manager logs in
/// again to the emptied database, where their role was kept.
#[tauri::command]
async fn clear_database(app: AppHandle, state: State<'_, AuthState>, account_password: String) -> Result<(), Message> {
    let account_password = Zeroizing::new(account_password);
    run_database_action(&app, &state, &account_password, |session| {
        backup::clear(&session.db, &session.info)?;
        session.data_replaced();
        Ok(())
    })
    .await?;
    let session = state.session.lock().unwrap().take();
    if let Some(session) = session {
        auth::logout(&state.ctx, session).await;
    }
    Ok(())
}

/// Runs after every connectivity check: tells the frontend about changes and,
/// while the server is reachable, lets an offline session reconnect.
fn on_connectivity(app: &AppHandle, status: ConnectivityStatus, changed: bool) {
    if changed {
        if let Err(e) = app.emit(connectivity::EVENT, status) {
            eprintln!("Could not send the connectivity status: {e}");
        }
    }
    let state = app.state::<AuthState>();
    if let Some(minimum) = state.watcher.minimum_app_version() {
        if state.updates.set_minimum(&minimum) {
            eprintln!("Minimum app version from the server: {minimum:?}; update required: {}", state.updates.is_required());
            let _ = app.emit(update::EVENT, state.updates.status());
        }
    }
    if status.is_online() {
        if state.updates.check_due() {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = app.state::<AuthState>();
                state.updates.check(&app, state.ctx.api.base_url()).await;
            });
        }
        if !state.updates.is_required() {
            let online_session = state.session.lock().unwrap().as_ref().is_some_and(|s| s.token().is_some());
            if online_session {
                // Brings in what the clinic's other installations changed.
                request_sync(app);
            } else {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { reconnect(app).await });
            }
        }
    }
}

/// Logs an offline session in online once the server is back, without closing it:
/// the user keeps working, and the database is rekeyed in place.
async fn reconnect(app: AppHandle) {
    let state = app.state::<AuthState>();
    // Another login or reconnect is running: this one is not needed.
    let Ok(_busy) = state.busy.try_lock() else {
        return;
    };
    let Some(request) = state.session.lock().unwrap().as_ref().and_then(Session::reconnect_request) else {
        return;
    };

    let (installation, login) = match auth::reconnect_login(&state.ctx, &request).await {
        Ok(result) => result,
        Err(ReconnectError::Later(reason)) => {
            eprintln!("Reconnecting later: {reason}");
            return;
        }
        Err(ReconnectError::GiveUp(message)) => {
            eprintln!("Not reconnecting: {}", message.key);
            if let Some(session) = state.session.lock().unwrap().as_mut() {
                session.stop_reconnecting();
            }
            return;
        }
        Err(ReconnectError::Revoked(message)) => {
            eprintln!("Session ended by the server: {}", message.key);
            let ended = {
                let mut guard = state.session.lock().unwrap();
                match guard.as_ref() {
                    Some(session) if session.is_waiting_for(&request) => guard.take(),
                    _ => None,
                }
            };
            if let Some(session) = ended {
                drop(session); // locks the database
                let _ = app.emit(SESSION_ENDED_EVENT, message);
            }
            return;
        }
    };

    // Applied only to the session the request came from, and only if it is still open.
    let switched = {
        let mut guard = state.session.lock().unwrap();
        match guard.as_mut() {
            Some(session) if session.is_waiting_for(&request) => Some(
                auth::switch_online(&state.ctx, session, &login).map(|()| session.info.clone()),
            ),
            _ => None,
        }
    };
    match switched {
        None => auth::discard_login(&state.ctx, login).await,
        Some(Err(message)) => {
            // The session stays as it was (offline); the next login sorts the keys out.
            eprintln!("Could not switch to online: {} {:?}", message.key, message.params);
            if let Some(session) = state.session.lock().unwrap().as_mut() {
                session.stop_reconnecting();
            }
            auth::discard_login(&state.ctx, login).await;
        }
        Some(Ok(info)) => {
            if let Err(message) = auth::finish_reconnect(&state.ctx, &installation, &login, &request).await {
                eprintln!("Reconnected, but offline access not updated: {} {:?}", message.key, message.params);
            }
            eprintln!("Offline session of {} is online again", info.username);
            let _ = app.emit(SESSION_EVENT, info);
            // What was changed offline goes to the server now.
            request_sync(&app);
        }
    }
}

/// Debug builds only: F12 opens DevTools (the browser's own shortcut is off, see lockdown.rs).
#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    #[cfg(debug_assertions)]
    window.open_devtools();
    #[cfg(not(debug_assertions))]
    let _ = window;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Its endpoint (the server's address) is set when checking (update.rs).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let api = api::Api::new(settings::server_url(&data_dir));
            let watcher = Watcher::new(api.clone());
            app.manage(AuthState {
                updates: update::Updates::new(&data_dir),
                ctx: Context::new(data_dir, api),
                watcher: Arc::clone(&watcher),
                session: Mutex::new(None),
                billing: Mutex::new(None),
                busy: tauri::async_runtime::Mutex::new(()),
                syncer: sync::Syncer::new(),
            });
            let handle = app.handle().clone();
            watcher.start(move |status, changed| on_connectivity(&handle, status, changed));

            // The window starts hidden and the frontend shows it once its splash is drawn
            // (src/main.tsx). If the frontend fails to load, show it anyway rather than
            // leave a running app with no window.
            if let Some(window) = app.get_webview_window("main") {
                lockdown::apply(&window);
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    if !window.is_visible().unwrap_or(true) {
                        let _ = window.show();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            current_session,
            connectivity_status,
            check_connectivity,
            connection_status,
            list_my_clinics,
            list_cities,
            setup_clinic,
            sign_up,
            change_password,
            login,
            resume_login,
            logout,
            lock_session,
            unlock_session,
            get_profile,
            update_profile,
            billing_status,
            list_plans,
            quote_payment,
            create_payment,
            list_my_payments,
            cancel_payment,
            export_database,
            restore_database,
            clear_database,
            open_devtools,
            update_status,
            check_for_update,
            install_update,
            sync_status,
            sync_now,
            list_patients,
            get_patient,
            save_patient,
            list_treatments,
            save_treatment,
            delete_treatment,
            patient_history,
            list_local_users,
            languages::get_language_catalog,
            languages::list_installed_languages,
            languages::install_language,
            languages::remove_language,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Closing the app always logs out: the server token is ended and the
            // database locked. The window is already gone, so the wait isn't seen.
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<AuthState>() {
                    tauri::async_runtime::block_on(end_sessions(&state));
                }
            }
        });
}
