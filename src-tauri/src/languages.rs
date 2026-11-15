//! Language packs downloaded from the language server.
//!
//! English and Persian are built into the frontend. Other languages are listed
//! in a catalog on the server and, once installed, saved as
//! `<app data dir>/languages/<code>.json`, in the same format as
//! `src/locales/*.json`. See `languages-server/README.md` for the server layout.

use std::{fs, io, path::PathBuf, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::message::Message;

/// Base URL of the language server (static files, no trailing slash):
/// `{LANGUAGE_SERVER_URL}/index.json` is the catalog and
/// `{LANGUAGE_SERVER_URL}/{code}.json` is one language.
/// Can be overridden at build time with the `LANGUAGE_SERVER_URL` environment variable.
const LANGUAGE_SERVER_URL: &str = match option_env!("LANGUAGE_SERVER_URL") {
    Some(url) => url,
    None => "https://example.com/dental/languages",
};

/// A language file is a few KB; anything far larger is not one.
const MAX_FILE_SIZE: usize = 2 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Serialize, Deserialize)]
pub struct CatalogEntry {
    code: String,
    name: String,
    abbr: String,
    #[serde(default = "default_dir")]
    dir: String,
    #[serde(default = "default_version")]
    version: u32,
}

#[derive(Deserialize)]
struct Catalog {
    languages: Vec<CatalogEntry>,
}

fn default_dir() -> String {
    "ltr".into()
}

fn default_version() -> u32 {
    1
}

/// Codes become file names, so only allow things like `de`, `pt-BR`, `zh-Hant`.
fn is_valid_code(code: &str) -> bool {
    (2..=16).contains(&code.len())
        && code.starts_with(|c: char| c.is_ascii_alphabetic())
        && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn check_code(code: &str) -> Result<(), Message> {
    if is_valid_code(code) {
        Ok(())
    } else {
        Err(Message::new("errors.invalidLanguageCode").with("code", code))
    }
}

fn languages_dir(app: &AppHandle) -> Result<PathBuf, Message> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("languages"))
        .map_err(|e| Message::error("errors.fileSystem", e))
}

/// Checks that `value` is a language file for `code`.
fn validate_language_file(value: &Value, code: &str) -> Result<(), String> {
    let meta = value
        .get("_meta")
        .and_then(Value::as_object)
        .ok_or("missing \"_meta\" section")?;

    match meta.get("code").and_then(Value::as_str) {
        Some(file_code) if file_code == code => {}
        Some(file_code) => return Err(format!("\"_meta.code\" is \"{file_code}\", expected \"{code}\"")),
        None => return Err("missing \"_meta.code\"".into()),
    }

    match meta.get("name").and_then(Value::as_str) {
        Some(name) if !name.trim().is_empty() => Ok(()),
        _ => Err("missing \"_meta.name\"".into()),
    }
}

async fn download(path: &str) -> Result<Vec<u8>, Message> {
    download_from(LANGUAGE_SERVER_URL, path).await
}

async fn download_from(base_url: &str, path: &str) -> Result<Vec<u8>, Message> {
    let url = format!("{base_url}/{path}");
    let network_error = |e: reqwest::Error| Message::error("errors.network", e);

    let response = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(network_error)?
        .get(&url)
        .send()
        .await
        .map_err(network_error)?;

    let status = response.status();
    if !status.is_success() {
        return Err(Message::new("errors.languageServer").with("status", status.as_u16()));
    }

    let bytes = response.bytes().await.map_err(network_error)?;
    if bytes.len() > MAX_FILE_SIZE {
        return Err(Message::error("errors.invalidLanguageFile", "file is too large"));
    }
    Ok(bytes.to_vec())
}

/// Languages offered by the server.
#[tauri::command]
pub async fn get_language_catalog() -> Result<Vec<CatalogEntry>, Message> {
    let bytes = download("index.json").await?;
    let catalog: Catalog =
        serde_json::from_slice(&bytes).map_err(|e| Message::error("errors.invalidCatalog", e))?;

    Ok(catalog
        .languages
        .into_iter()
        .filter(|entry| is_valid_code(&entry.code))
        .collect())
}

/// Contents of every installed (downloaded) language file. Broken files are skipped.
#[tauri::command]
pub fn list_installed_languages(app: AppHandle) -> Result<Vec<Value>, Message> {
    let dir = languages_dir(&app)?;
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(Message::error("errors.fileSystem", e)),
    };

    let mut languages = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(code) = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_suffix(".json"))
        else {
            continue;
        };

        let parsed = fs::read(&path)
            .map_err(|e| e.to_string())
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).map_err(|e| e.to_string()))
            .and_then(|value| validate_language_file(&value, code).map(|()| value));

        match parsed {
            Ok(value) => languages.push(value),
            Err(e) => eprintln!("Skipping language file {}: {e}", path.display()),
        }
    }
    Ok(languages)
}

/// Downloads a language from the server (or replaces it with the newer version)
/// and returns its contents.
#[tauri::command]
pub async fn install_language(app: AppHandle, code: String) -> Result<Value, Message> {
    check_code(&code)?;

    let bytes = download(&format!("{code}.json")).await?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|e| Message::error("errors.invalidLanguageFile", e))?;
    validate_language_file(&value, &code).map_err(|e| Message::error("errors.invalidLanguageFile", e))?;

    let dir = languages_dir(&app)?;
    let file_error = |e: io::Error| Message::error("errors.fileSystem", e);
    fs::create_dir_all(&dir).map_err(file_error)?;

    // Write to a temporary file first so a failed write never leaves a broken language behind.
    let temp = dir.join(format!("{code}.json.tmp"));
    fs::write(&temp, &bytes).map_err(file_error)?;
    fs::rename(&temp, dir.join(format!("{code}.json"))).map_err(file_error)?;

    Ok(value)
}

/// Deletes an installed language. The frontend refuses to remove the active one.
#[tauri::command]
pub fn remove_language(app: AppHandle, code: String) -> Result<(), Message> {
    check_code(&code)?;

    let path = languages_dir(&app)?.join(format!("{code}.json"));
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(Message::error("errors.fileSystem", e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn language_codes() {
        for code in ["de", "fa", "pt-BR", "zh-Hant"] {
            assert!(is_valid_code(code), "{code} should be valid");
        }
        for code in ["", "d", "../de", "de/x", "de.json", "-de", "1de", "de x"] {
            assert!(!is_valid_code(code), "{code:?} should be invalid");
        }
    }

    #[test]
    fn language_file_validation() {
        let file = json!({ "_meta": { "code": "de", "name": "Deutsch" }, "app": {} });
        assert!(validate_language_file(&file, "de").is_ok());
        assert!(validate_language_file(&file, "fr").is_err());
        assert!(validate_language_file(&json!({ "app": {} }), "de").is_err());
        assert!(validate_language_file(&json!({ "_meta": { "code": "de", "name": " " } }), "de").is_err());
    }

    /// Every language listed in the sample `languages-server/index.json` exists and matches its file.
    #[test]
    fn sample_server_files_are_consistent() {
        let server = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../languages-server");
        let catalog: Catalog = serde_json::from_slice(&fs::read(server.join("index.json")).unwrap()).unwrap();
        assert!(!catalog.languages.is_empty());

        for entry in catalog.languages {
            let file: Value =
                serde_json::from_slice(&fs::read(server.join(format!("{}.json", entry.code))).unwrap()).unwrap();
            validate_language_file(&file, &entry.code).unwrap();
            assert_eq!(file["_meta"]["version"].as_u64(), Some(entry.version as u64), "{} version", entry.code);
        }
    }

    /// Serves one canned HTTP response on a local port and returns the base URL.
    fn serve_once(status: &str, body: &'static [u8]) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let status = status.to_owned();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = stream.read(&mut [0; 4096]);
            let header = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            stream.write_all(header.as_bytes()).unwrap();
            stream.write_all(body).unwrap();
        });
        format!("http://{address}")
    }

    #[test]
    fn download_returns_body_or_status_error() {
        let ok = serve_once("200 OK", b"{\"languages\":[]}");
        let body = tauri::async_runtime::block_on(download_from(&ok, "index.json")).unwrap();
        assert_eq!(body, b"{\"languages\":[]}");

        let missing = serve_once("404 Not Found", b"");
        let error = tauri::async_runtime::block_on(download_from(&missing, "de.json")).unwrap_err();
        assert_eq!(error.key, "errors.languageServer");
        assert_eq!(error.params["status"], 404);
    }
}
