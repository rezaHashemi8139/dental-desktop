mod api;
mod auth;
mod clock;
mod device;
mod languages;
mod localdb;
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            current_session,
            connection_status,
            sign_up,
            login,
            logout,
            languages::get_language_catalog,
            languages::list_installed_languages,
            languages::install_language,
            languages::remove_language,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
