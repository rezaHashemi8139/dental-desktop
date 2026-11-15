mod api;
mod auth;
mod clock;
mod device;
mod languages;
mod localdb;
mod lockdown;
mod message;
mod proto;
mod secure;
mod settings;
mod vault;

use std::sync::Mutex;

use auth::{ConnectionMode, Context, Session, SessionInfo};
use message::Message;
use tauri::{Manager, State};

/// The current login, if any. Only one user is logged in at a time.
struct AuthState {
    ctx: Context,
    session: Mutex<Option<Session>>,
}

#[tauri::command]
fn current_session(state: State<'_, AuthState>) -> Option<SessionInfo> {
    state.session.lock().unwrap().as_ref().map(|s| s.info.clone())
}

/// Checks the server, then the local database: decides which login screen to show.
#[tauri::command]
async fn connection_status(state: State<'_, AuthState>) -> Result<ConnectionMode, Message> {
    Ok(auth::connection_mode(&state.ctx).await)
}

#[tauri::command]
async fn sign_up(state: State<'_, AuthState>, username: String, password: String, full_name: String) -> Result<Message, Message> {
    auth::sign_up(&state.ctx, &username, &password, &full_name).await?;
    Ok(Message::new("auth.signUpSuccess"))
}

#[tauri::command]
async fn login(state: State<'_, AuthState>, username: String, password: String) -> Result<SessionInfo, Message> {
    // A new login replaces the previous one.
    if let Some(previous) = state.session.lock().unwrap().take() {
        drop(previous);
    }
    let session = auth::login(&state.ctx, &username, &password).await?;
    let info = session.info.clone();
    *state.session.lock().unwrap() = Some(session);
    Ok(info)
}

#[tauri::command]
async fn logout(state: State<'_, AuthState>) -> Result<(), Message> {
    let session = state.session.lock().unwrap().take();
    if let Some(session) = session {
        auth::logout(&state.ctx, session).await;
    }
    Ok(())
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
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let server_url = settings::server_url(&data_dir);
            app.manage(AuthState {
                ctx: Context::new(data_dir, api::Api::new(server_url)),
                session: Mutex::new(None),
            });

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
            connection_status,
            sign_up,
            login,
            logout,
            open_devtools,
            languages::get_language_catalog,
            languages::list_installed_languages,
            languages::install_language,
            languages::remove_language,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
