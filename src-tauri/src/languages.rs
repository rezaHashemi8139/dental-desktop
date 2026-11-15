//! Interface languages downloaded from the dental server (LanguageService).
//!
//! Persian is built into the frontend. Every other language (English, German, ...) is offered
//! by the server (dental-server/internal/languages) and, once installed, saved as
//! `<app data dir>/languages/<code>.json`, in the same format as `src/locales/*.json`.

use std::{fs, io, path::PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::api::ApiError;
use crate::message::Message;
use crate::{proto, AuthState};

/// A language file is a few KB; anything far larger is not one.
const MAX_FILE_SIZE: usize = 2 * 1024 * 1024;

/// One language on offer (sent to the frontend as `CatalogEntry` in src/i18n/index.ts).
#[derive(Debug, Serialize)]
pub struct CatalogEntry {
    code: String,
    name: String,
    abbr: String,
    dir: String,
    version: u32,
}

impl From<proto::Language> for CatalogEntry {
    fn from(l: proto::Language) -> Self {
        Self { code: l.code, name: l.name, abbr: l.abbr, dir: l.dir, version: l.version }
    }
}

fn server_error(e: ApiError) -> Message {
    match e {
        ApiError::Network(details) => Message::error("errors.network", details),
        ApiError::Server { reason, .. } if reason == "language_not_found" => Message::new("errors.languageNotFound"),
        ApiError::Server { code, reason } => Message::error("errors.languageServer", format!("{code}: {reason}")),
    }
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

/// Languages offered by the server.
#[tauri::command]
pub async fn get_language_catalog(state: State<'_, AuthState>) -> Result<Vec<CatalogEntry>, Message> {
    let response = state.ctx.api.list_languages().await.map_err(server_error)?;
    Ok(response
        .languages
        .into_iter()
        .filter(|language| is_valid_code(&language.code))
        .map(CatalogEntry::from)
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
pub async fn install_language(app: AppHandle, state: State<'_, AuthState>, code: String) -> Result<Value, Message> {
    check_code(&code)?;

    let bytes = state.ctx.api.get_language(&code).await.map_err(server_error)?.content;
    if bytes.len() > MAX_FILE_SIZE {
        return Err(Message::error("errors.invalidLanguageFile", "file is too large"));
    }
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

    #[test]
    fn server_errors() {
        let not_found = server_error(ApiError::Server { code: "not_found".into(), reason: "language_not_found".into() });
        assert_eq!(not_found.key, "errors.languageNotFound");
        assert_eq!(server_error(ApiError::Network("x".into())).key, "errors.network");
    }
}
