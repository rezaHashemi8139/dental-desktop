//! Where the app finds the server.
//!
//! All server traffic goes through Rust (api.rs); the frontend never talks to the
//! server itself, it only calls Tauri commands.
//!
//! The address is `SERVER_URL` below. It can be changed in three ways:
//! - edit `SERVER_URL` here;
//! - set `DENTAL_SERVER_URL` when building (e.g. for production builds);
//! - without rebuilding: put `{ "serverUrl": "https://..." }` in `settings.json`
//!   in the app data folder (%APPDATA%\<app identifier>\settings.json). It wins
//!   over the other two and is read when the app starts.

use std::path::Path;

use serde::Deserialize;

/// Server address used when settings.json does not name one.
pub const SERVER_URL: &str = match option_env!("DENTAL_SERVER_URL") {
    Some(url) => url,
    None => "http://localhost:8080",
};

pub const SETTINGS_FILE: &str = "settings.json";

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Settings {
    server_url: Option<String>,
}

/// The server address: from settings.json in `data_dir` if set there, otherwise `SERVER_URL`.
pub fn server_url(data_dir: &Path) -> String {
    let path = data_dir.join(SETTINGS_FILE);
    let settings = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<Settings>(&bytes).unwrap_or_else(|e| {
            eprintln!("Ignoring {}: {e}", path.display());
            Settings::default()
        }),
        Err(_) => Settings::default(),
    };

    match settings.server_url.as_deref().map(str::trim) {
        Some(url) if url.starts_with("https://") || url.starts_with("http://") => url.to_owned(),
        Some(url) if !url.is_empty() => {
            eprintln!("Ignoring serverUrl {url:?} in {}: must start with http:// or https://", path.display());
            SERVER_URL.to_owned()
        }
        _ => SERVER_URL.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_file_overrides_default() {
        let dir = std::env::temp_dir().join(format!("dental-settings-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(SETTINGS_FILE);

        assert_eq!(server_url(&dir), SERVER_URL, "no file");

        std::fs::write(&file, r#"{ "serverUrl": " https://dental.example.com " }"#).unwrap();
        assert_eq!(server_url(&dir), "https://dental.example.com");

        std::fs::write(&file, r#"{ "serverUrl": "ftp://nope" }"#).unwrap();
        assert_eq!(server_url(&dir), SERVER_URL, "bad scheme");

        std::fs::write(&file, "not json").unwrap();
        assert_eq!(server_url(&dir), SERVER_URL, "broken file");
    }
}
