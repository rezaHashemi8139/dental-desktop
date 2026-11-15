// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

mod languages;
mod message;

use message::Message;
use rusqlite::Connection;

#[tauri::command]
fn test_db_connection() -> Result<Message, Message> {
    let db_error = |e: rusqlite::Error| Message::error("errors.database", e);

    let conn = Connection::open("test.db").map_err(db_error)?;

    conn.execute_batch("PRAGMA key = 'test123456';")
        .map_err(db_error)?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS test (id INTEGER PRIMARY KEY, name TEXT)",
        [],
    ).map_err(db_error)?;

    conn.execute("INSERT INTO test (name) VALUES ('hello')", [])
        .map_err(db_error)?;

    Ok(Message::new("database.connected"))
}

#[tauri::command]
fn greet(name: &str) -> Message {
    Message::new("greet.message").with("name", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            test_db_connection,
            languages::get_language_catalog,
            languages::list_installed_languages,
            languages::install_language,
            languages::remove_language,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
