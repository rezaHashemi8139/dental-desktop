mod api;
mod auth;
mod backup;
mod clock;
mod connectivity;
mod device;
mod languages;
mod localdb;
mod lockdown;
mod message;
mod proto;
mod secure;
mod settings;
mod setup;
mod vault;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use auth::{ConnectionMode, Context, ReconnectError, Session, SessionInfo};
use connectivity::{ConnectivityState, ConnectivityStatus, Watcher};
use message::Message;
use tauri::{AppHandle, Emitter, Manager, State};
use zeroize::Zeroizing;

/// Sent to the frontend when the session changes by itself (an offline session
/// reconnected); the payload is the new SessionInfo.
const SESSION_EVENT: &str = "session";
/// Sent when the session was ended by the server (access revoked); the payload is
/// the Message to show on the login screen.
const SESSION_ENDED_EVENT: &str = "session-ended";

/// The current login, if any. Only one user is logged in at a time.
struct AuthState {
    ctx: Context,
    watcher: Arc<Watcher>,
    session: Mutex<Option<Session>>,
    /// Held by login, setup, reconnecting, backups and clearing: they never overlap, since each may
    /// rotate the database key, write the vault or copy the database. A second request while one
    /// runs is refused instead of queued (no duplicate logins).
    busy: tauri::async_runtime::Mutex<()>,
}

#[tauri::command]
fn current_session(state: State<'_, AuthState>) -> Option<SessionInfo> {
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

/// First start: registers this computer with its clinic and the clinic's owner.
/// Returns the owner's username for the login form.
#[tauri::command]
async fn setup_clinic(
    state: State<'_, AuthState>,
    clinic: setup::ClinicInput,
    owner: setup::OwnerInput,
) -> Result<String, Message> {
    let Ok(_busy) = state.busy.try_lock() else {
        return Err(Message::new("auth.errors.busy"));
    };
    setup::setup(&state.ctx, &clinic, &owner).await
}

#[tauri::command]
async fn sign_up(state: State<'_, AuthState>, username: String, password: String, full_name: String) -> Result<Message, Message> {
    auth::sign_up(&state.ctx, &username, &password, &full_name).await?;
    Ok(Message::new("auth.signUpSuccess"))
}

#[tauri::command]
async fn login(state: State<'_, AuthState>, username: String, password: String) -> Result<SessionInfo, Message> {
    let Ok(_busy) = state.busy.try_lock() else {
        return Err(Message::new("auth.errors.busy"));
    };
    // A new login replaces the previous one.
    if let Some(previous) = state.session.lock().unwrap().take() {
        drop(previous);
    }

    // The watcher decides online or offline; a stale "not online" is checked again first.
    let online = state.watcher.status().is_online() || state.watcher.refresh().await.is_online();
    let session = auth::login(&state.ctx, &username, &password, online).await?;
    if online && !session.info.online {
        // The server went away since the last check: let everyone know now.
        let watcher = Arc::clone(&state.watcher);
        tauri::async_runtime::spawn(async move { watcher.refresh().await });
    }

    let info = session.info.clone();
    *state.session.lock().unwrap() = Some(session);
    Ok(info)
}

/// Never waits for a reconnect in progress: the session is closed at once, and a
/// reconnect that finishes later finds it gone and discards its result.
#[tauri::command]
async fn logout(state: State<'_, AuthState>) -> Result<(), Message> {
    let session = state.session.lock().unwrap().take();
    if let Some(session) = session {
        auth::logout(&state.ctx, session).await;
    }
    Ok(())
}

/// Saves an encrypted copy of the clinic database to `path` (chosen by the user
/// in a Save dialog). Managers only. Returns the recovery key: shown once, never stored.
#[tauri::command]
async fn export_database(state: State<'_, AuthState>, path: PathBuf, password: String) -> Result<String, Message> {
    // Never during a login or a reconnect, which may rekey the database.
    let Ok(_busy) = state.busy.try_lock() else {
        return Err(Message::new("auth.errors.busy"));
    };
    let password = Zeroizing::new(password);
    let guard = state.session.lock().unwrap();
    let session = backup::manager_session(guard.as_ref())?;
    backup::export(&session.db, &state.ctx.data_dir, &path, &password)
}

/// Restores the backup at `path` into the clinic database, replacing its contents
/// or merging into them (`mode`). Managers only.
#[tauri::command]
async fn restore_database(
    state: State<'_, AuthState>,
    path: PathBuf,
    password: String,
    recovery_key: String,
    mode: backup::RestoreMode,
) -> Result<(), Message> {
    let Ok(_busy) = state.busy.try_lock() else {
        return Err(Message::new("auth.errors.busy"));
    };
    let (password, recovery_key) = (Zeroizing::new(password), Zeroizing::new(recovery_key));
    let guard = state.session.lock().unwrap();
    let session = backup::manager_session(guard.as_ref())?;
    backup::restore(&session.db, &session.info, &state.ctx.data_dir, &path, &password, &recovery_key, mode)
}

/// Deletes all clinic data on this computer; the manager who does it keeps access. Managers only.
#[tauri::command]
async fn clear_database(state: State<'_, AuthState>) -> Result<(), Message> {
    let Ok(_busy) = state.busy.try_lock() else {
        return Err(Message::new("auth.errors.busy"));
    };
    let guard = state.session.lock().unwrap();
    let session = backup::manager_session(guard.as_ref())?;
    backup::clear(&session.db, &session.info)
}

/// Runs after every connectivity check: tells the frontend about changes and,
/// while the server is reachable, lets an offline session reconnect.
fn on_connectivity(app: &AppHandle, status: ConnectivityStatus, changed: bool) {
    if changed {
        if let Err(e) = app.emit(connectivity::EVENT, status) {
            eprintln!("Could not send the connectivity status: {e}");
        }
    }
    if status.is_online() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { reconnect(app).await });
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
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let api = api::Api::new(settings::server_url(&data_dir));
            let watcher = Watcher::new(api.clone());
            app.manage(AuthState {
                ctx: Context::new(data_dir, api),
                watcher: Arc::clone(&watcher),
                session: Mutex::new(None),
                busy: tauri::async_runtime::Mutex::new(()),
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
            setup_clinic,
            sign_up,
            login,
            logout,
            export_database,
            restore_database,
            clear_database,
            open_devtools,
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
                    let session = state.session.lock().unwrap().take();
                    if let Some(session) = session {
                        tauri::async_runtime::block_on(auth::logout(&state.ctx, session));
                    }
                }
            }
        });
}
