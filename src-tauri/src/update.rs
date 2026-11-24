//! Self-update, and forced updates.
//!
//! New versions come from the dental server (dental-server/internal/releases):
//! Tauri's updater plugin asks `<server>/updates/<target>/<arch>/<current version>`,
//! downloads the installer, checks its signature against the public key in
//! tauri.conf.json (`plugins.updater.pubkey`; the private key signs releases in
//! scripts/build.mjs) and installs it. On Windows the installer closes the app and
//! starts the new version.
//!
//! A forced update: the server's health check names a minimum app version
//! (connectivity.rs). An older app stops working until it is updated: the
//! frontend shows only the update screen, logins are refused, and the server
//! refuses its calls with "update_required". The minimum is remembered in
//! `update.json`, so an outdated app stays stopped after a restart without network.
//! A lower minimum from the server (an update no longer forced) lifts it.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

use crate::api::APP_VERSION;
use crate::message::Message;

/// The event the frontend listens to; its payload is an `UpdateStatus`.
pub const EVENT: &str = "update";
/// The error of everything refused because this version must be updated first.
pub const REQUIRED_ERROR: &str = "update.errors.required";
/// Download progress, payload `DownloadProgress`.
pub const PROGRESS_EVENT: &str = "update-progress";
/// Remembers the latest minimum version the server asked for.
const STATE_FILE: &str = "update.json";
/// How often to look for a new version while online.
const CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// Same path as dental-server/internal/releases (CheckURL); the plugin fills in the variables.
const UPDATE_PATH: &str = "/updates/{{target}}/{{arch}}/{{current_version}}";
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// A "major.minor.patch" version: the only form the app's versions take (scripts/build.mjs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version([u64; 3]);

impl Version {
    pub fn parse(text: &str) -> Option<Self> {
        let mut parts = text.trim().split('.').map(|part| part.parse::<u64>().ok());
        let version = Version([parts.next()??, parts.next()??, parts.next()??]);
        parts.next().is_none().then_some(version)
    }

    fn current() -> Self {
        Self::parse(APP_VERSION).expect("the app version is major.minor.patch")
    }
}

/// What the frontend shows (src/lib/update.ts).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current_version: String,
    /// A newer version the server offers, if one was found.
    pub available: Option<AvailableUpdate>,
    /// This version may not be used any more: only updating is possible.
    pub required: bool,
    /// The version the server requires at least, when `required`.
    pub minimum_version: Option<String>,
    /// Downloading or installing right now.
    pub installing: bool,
    /// Why the last check or install failed.
    pub error: Option<Message>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub version: String,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub downloaded: u64,
    /// None when the server does not say the size.
    pub total: Option<u64>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SavedState {
    #[serde(default)]
    minimum_version: String,
}

pub struct Updates {
    state_file: PathBuf,
    status: Mutex<UpdateStatus>,
    /// The update found by the last check, ready to install.
    pending: Mutex<Option<tauri_plugin_updater::Update>>,
    last_check: Mutex<Option<Instant>>,
    checking: tauri::async_runtime::Mutex<()>,
}

impl Updates {
    pub fn new(data_dir: &Path) -> Self {
        let state_file = data_dir.join(STATE_FILE);
        let saved: SavedState = std::fs::read(&state_file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let updates = Self {
            state_file,
            status: Mutex::new(UpdateStatus { current_version: APP_VERSION.to_owned(), ..Default::default() }),
            pending: Mutex::new(None),
            last_check: Mutex::new(None),
            checking: tauri::async_runtime::Mutex::new(()),
        };
        updates.apply_minimum(&saved.minimum_version);
        updates
    }

    pub fn status(&self) -> UpdateStatus {
        self.status.lock().unwrap().clone()
    }

    /// Whether this version may not be used any more.
    pub fn is_required(&self) -> bool {
        self.status.lock().unwrap().required
    }

    /// Sets `required` from a minimum version ("" = none). Returns whether it changed.
    fn apply_minimum(&self, minimum: &str) -> bool {
        let minimum = Version::parse(minimum);
        let required = minimum.is_some_and(|minimum| Version::current() < minimum);
        let mut status = self.status.lock().unwrap();
        let minimum_version = minimum.filter(|_| required).map(|v| format!("{}.{}.{}", v.0[0], v.0[1], v.0[2]));
        let changed = status.required != required || status.minimum_version != minimum_version;
        status.required = required;
        status.minimum_version = minimum_version;
        changed
    }

    /// The minimum version from the server's health check (connectivity.rs).
    /// Returns whether the status changed.
    pub fn set_minimum(&self, minimum: &str) -> bool {
        let changed = self.apply_minimum(minimum);
        if changed {
            let saved = SavedState { minimum_version: minimum.to_owned() };
            let written = serde_json::to_vec(&saved).map_err(|e| e.to_string()).and_then(|bytes| {
                if let Some(dir) = self.state_file.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                std::fs::write(&self.state_file, bytes).map_err(|e| e.to_string())
            });
            if let Err(e) = written {
                eprintln!("Could not save the required app version: {e}");
            }
        }
        changed
    }

    /// The server refused a call with "update_required" before the health check
    /// said so: stop now; the next health check gives the exact version.
    pub fn server_requires_update(&self) -> bool {
        let mut status = self.status.lock().unwrap();
        let changed = !status.required;
        status.required = true;
        changed
    }

    /// Whether a check is due: never checked yet, an hour passed, or an update is
    /// required and none was found yet.
    pub fn check_due(&self) -> bool {
        let last = *self.last_check.lock().unwrap();
        let status = self.status.lock().unwrap();
        match last {
            None => true,
            Some(_) if status.required && status.available.is_none() => true,
            Some(last) => last.elapsed() >= CHECK_INTERVAL,
        }
    }

    /// Asks the server for a newer version. Runs one check at a time.
    pub async fn check(&self, app: &AppHandle, server_url: &str) -> UpdateStatus {
        let Ok(_checking) = self.checking.try_lock() else {
            return self.status();
        };
        *self.last_check.lock().unwrap() = Some(Instant::now());
        let found = find_update(app, server_url).await;
        {
            let mut status = self.status.lock().unwrap();
            match &found {
                Ok(update) => {
                    status.available = update
                        .as_ref()
                        .map(|u| AvailableUpdate { version: u.version.clone(), notes: u.body.clone() });
                    status.error = None;
                }
                Err(message) => {
                    eprintln!("Update check failed: {} {:?}", message.key, message.params);
                    status.error = Some(message.clone());
                }
            }
        }
        if let Ok(update) = found {
            *self.pending.lock().unwrap() = update;
        }
        let status = self.status();
        let _ = app.emit(EVENT, status.clone());
        status
    }

    /// Downloads and installs the update found by the last check. The caller has
    /// already closed the session (the database is locked). On Windows the
    /// installer then closes the app and starts the new version; elsewhere the
    /// app restarts itself.
    pub async fn install(&self, app: &AppHandle) -> Result<(), Message> {
        let Some(update) = self.pending.lock().unwrap().take() else {
            return Err(Message::new("update.errors.noUpdate"));
        };
        self.set_installing(app, true, None);

        let mut downloaded = 0u64;
        let result = update
            .download_and_install(
                |chunk, total| {
                    downloaded += chunk as u64;
                    let _ = app.emit(PROGRESS_EVENT, DownloadProgress { downloaded, total });
                },
                || {},
            )
            .await;
        match result {
            Ok(()) => {
                // Windows never gets here: the installer has already ended the app.
                app.restart();
            }
            Err(e) => {
                let message = Message::error("update.errors.failed", &e);
                eprintln!("Update failed: {e}");
                // Offered again: the user can retry without a new check.
                *self.pending.lock().unwrap() = Some(update);
                self.set_installing(app, false, Some(message.clone()));
                Err(message)
            }
        }
    }

    fn set_installing(&self, app: &AppHandle, installing: bool, error: Option<Message>) {
        let status = {
            let mut status = self.status.lock().unwrap();
            status.installing = installing;
            status.error = error;
            status.clone()
        };
        let _ = app.emit(EVENT, status);
    }
}

async fn find_update(app: &AppHandle, server_url: &str) -> Result<Option<tauri_plugin_updater::Update>, Message> {
    let endpoint = format!("{}{UPDATE_PATH}", server_url.trim_end_matches('/'));
    let endpoint = endpoint.parse().map_err(|e| Message::error("update.errors.failed", e))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .and_then(|builder| builder.timeout(CHECK_TIMEOUT).build())
        .map_err(|e| Message::error("update.errors.failed", e))?;
    updater.check().await.map_err(|e| Message::error("update.errors.failed", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_as_numbers() {
        assert_eq!(Version::parse("1.2.3"), Some(Version([1, 2, 3])));
        assert!(Version::parse("0.9.9").unwrap() < Version::parse("0.10.0").unwrap());
        for bad in ["", "1.2", "1.2.3.4", "1.x.3", "v1.2.3"] {
            assert_eq!(Version::parse(bad), None, "{bad}");
        }
        assert!(Version::parse(APP_VERSION).is_some());
    }

    #[test]
    fn minimum_version_is_remembered() {
        let dir = std::env::temp_dir().join(format!("dental-update-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let current = Version::current().0;
        let newer = format!("{}.{}.{}", current[0], current[1], current[2] + 1);

        let updates = Updates::new(&dir);
        assert!(!updates.is_required());
        assert!(!updates.set_minimum(APP_VERSION), "this version itself is allowed");
        assert!(updates.set_minimum(&newer));
        assert!(updates.is_required());
        assert_eq!(updates.status().minimum_version.as_deref(), Some(newer.as_str()));

        // After a restart without network.
        assert!(Updates::new(&dir).is_required());

        // The server no longer forces it.
        assert!(updates.set_minimum(""));
        assert!(!Updates::new(&dir).is_required());
    }
}
