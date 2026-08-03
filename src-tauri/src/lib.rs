// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use rusqlite::Connection;

#[tauri::command]
fn test_db_connection() -> Result<String, String> {
    let conn = Connection::open("test.db").map_err(|e| e.to_string())?;
    
    conn.execute_batch("PRAGMA key = 'test123456';")
        .map_err(|e| e.to_string())?;
    
    conn.execute(
        "CREATE TABLE IF NOT EXISTS test (id INTEGER PRIMARY KEY, name TEXT)",
        [],
    ).map_err(|e| e.to_string())?;
    
    conn.execute("INSERT INTO test (name) VALUES ('hello')", [])
        .map_err(|e| e.to_string())?;
    
    Ok("Successfully connected to the database!".to_string())
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, test_db_connection])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
