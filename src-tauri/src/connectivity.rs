//! Watches whether the app can work online: one watcher for the whole app, whose
//! status the frontend shows (src/auth/connectivity.ts) and the login logic uses.
//!
//! Being on the internet is not enough: the app is `Online` only when the server's
//! health check answers and reports its database ready. The operating system's
//! connectivity hint (Windows NCSI, which itself probes the internet) is only used
//! to tell "no network at all" (`Offline`) from "network, but no server"
//! (`ServerUnavailable`), and to check again as soon as the network changes.
//!
//! Checks never overlap: a check asked for while one is running waits for it and
//! returns its result. They run every `ONLINE_INTERVAL` while online, and with a
//! growing delay (`RETRY_INTERVALS`) otherwise, so a server that is down is not
//! flooded with requests.

use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;

use crate::api::{Api, ApiError};
use crate::clock;

/// Time between checks while online.
const ONLINE_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// Time between checks while not online: grows with each failed check, then stays at the last.
const RETRY_INTERVALS: &[Duration] = &[
    Duration::from_secs(5),
    Duration::from_secs(10),
    Duration::from_secs(20),
    Duration::from_secs(40),
    Duration::from_secs(60),
];
/// After a network change, wait this long for the network to settle (changes come in bursts).
const NETWORK_CHANGE_DEBOUNCE: Duration = Duration::from_millis(1500);

/// The event the frontend listens to; its payload is a `ConnectivityStatus`.
pub const EVENT: &str = "connectivity";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectivityState {
    /// Not checked yet (app start).
    Checking,
    /// No network connection.
    Offline,
    /// A network connection, but the server does not answer, answers with an
    /// error, or reports that its database is down.
    ServerUnavailable,
    /// The server answers its health check and is ready.
    Online,
}

/// What the operating system reports about the network.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NetworkLevel {
    /// Not reported (not Windows, or the call failed).
    Unknown,
    /// No network connection.
    None,
    /// A local network without internet access.
    Local,
    /// Internet access (possibly behind a captive portal).
    Internet,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectivityStatus {
    pub state: ConnectivityState,
    pub network: NetworkLevel,
    /// When this status was determined (unix seconds); 0 before the first check.
    pub checked_at: i64,
}

impl ConnectivityStatus {
    pub fn is_online(&self) -> bool {
        self.state == ConnectivityState::Online
    }
}

struct Shared {
    status: ConnectivityStatus,
    /// Raised by every finished check, so a waiting caller can tell a fresh result.
    generation: u64,
    /// Set to ask the watcher thread for a check now (network change).
    wake: bool,
}

/// Called after every check with its result, and whether the state changed.
type Listener = Box<dyn Fn(ConnectivityStatus, bool) + Send + Sync>;

pub struct Watcher {
    api: Api,
    shared: Mutex<Shared>,
    wakeup: Condvar,
    /// Held while a check runs: checks never overlap.
    check_lock: tauri::async_runtime::Mutex<()>,
    listener: Mutex<Option<Listener>>,
}

impl Watcher {
    pub fn new(api: Api) -> Arc<Self> {
        Arc::new(Self {
            api,
            shared: Mutex::new(Shared {
                status: ConnectivityStatus { state: ConnectivityState::Checking, network: NetworkLevel::Unknown, checked_at: 0 },
                generation: 0,
                wake: false,
            }),
            wakeup: Condvar::new(),
            check_lock: tauri::async_runtime::Mutex::new(()),
            listener: Mutex::new(None),
        })
    }

    /// The latest status, without checking.
    pub fn status(&self) -> ConnectivityStatus {
        self.shared.lock().unwrap().status
    }

    /// Checks now and returns the result. If a check is already running, waits for
    /// it and returns its result instead of starting another one.
    pub async fn refresh(&self) -> ConnectivityStatus {
        let generation = self.shared.lock().unwrap().generation;
        let _running = self.check_lock.lock().await;
        {
            let shared = self.shared.lock().unwrap();
            if shared.generation != generation {
                return shared.status;
            }
        }
        let status = probe(&self.api).await;
        let changed = {
            let mut shared = self.shared.lock().unwrap();
            let changed = shared.status.state != status.state;
            if changed {
                eprintln!("Connectivity: {:?} -> {:?} (network {:?})", shared.status.state, status.state, status.network);
            }
            shared.status = status;
            shared.generation += 1;
            changed
        };
        if let Some(listener) = self.listener.lock().unwrap().as_ref() {
            listener(status, changed);
        }
        status
    }

    /// Asks the watcher thread to check soon (after the debounce delay).
    fn wake(&self) {
        self.shared.lock().unwrap().wake = true;
        self.wakeup.notify_all();
    }

    /// Waits until the next check is due or the network changes. Returns true for a network change.
    fn wait(&self, interval: Duration) -> bool {
        let shared = self.shared.lock().unwrap();
        let (mut shared, _) = self.wakeup.wait_timeout_while(shared, interval, |shared| !shared.wake).unwrap();
        if !shared.wake {
            return false;
        }
        shared.wake = false;
        drop(shared);
        // Let a burst of network changes settle into one check.
        std::thread::sleep(NETWORK_CHANGE_DEBOUNCE);
        self.shared.lock().unwrap().wake = false;
        true
    }

    /// Starts the watcher thread. `on_status` runs after every check, whoever asked
    /// for it, with the result and whether the state changed.
    pub fn start(self: &Arc<Self>, on_status: impl Fn(ConnectivityStatus, bool) + Send + Sync + 'static) {
        *self.listener.lock().unwrap() = Some(Box::new(on_status));
        network_changes::subscribe(Arc::clone(self));
        let watcher = Arc::clone(self);
        std::thread::Builder::new()
            .name("connectivity".into())
            .spawn(move || {
                let mut failures = 0usize;
                loop {
                    let status = tauri::async_runtime::block_on(watcher.refresh());
                    let interval = if status.is_online() {
                        failures = 0;
                        ONLINE_INTERVAL
                    } else {
                        let interval = RETRY_INTERVALS[failures.min(RETRY_INTERVALS.len() - 1)];
                        failures += 1;
                        interval
                    };
                    if watcher.wait(interval) {
                        // A network change starts the retry delays over.
                        failures = 0;
                    }
                }
            })
            .expect("starting the connectivity thread");
    }
}

/// One check: the network hint, then the server's health check.
async fn probe(api: &Api) -> ConnectivityStatus {
    let network = network_level();
    let state = match api.health().await {
        Ok(health) if health.database_ok => ConnectivityState::Online,
        Ok(_) => ConnectivityState::ServerUnavailable,
        // The server is the only real proof of being online. Without it, the
        // network hint tells "no network" from "server down".
        Err(ApiError::Network(_)) if matches!(network, NetworkLevel::None | NetworkLevel::Local) => {
            ConnectivityState::Offline
        }
        Err(_) => ConnectivityState::ServerUnavailable,
    };
    ConnectivityStatus { state, network, checked_at: clock::now_unix() }
}

#[cfg(windows)]
fn network_level() -> NetworkLevel {
    use windows_sys::Win32::NetworkManagement::IpHelper::GetNetworkConnectivityHint;
    use windows_sys::Win32::Networking::WinSock::*;

    let mut hint = NL_NETWORK_CONNECTIVITY_HINT::default();
    // SAFETY: `hint` is a valid, writable struct for the call to fill in.
    if unsafe { GetNetworkConnectivityHint(&mut hint) } != 0 {
        return NetworkLevel::Unknown;
    }
    level_from_hint(hint.ConnectivityLevel)
}

#[cfg(windows)]
#[allow(non_upper_case_globals)] // Windows' own constant names
fn level_from_hint(level: windows_sys::Win32::Networking::WinSock::NL_NETWORK_CONNECTIVITY_LEVEL_HINT) -> NetworkLevel {
    use windows_sys::Win32::Networking::WinSock::*;
    match level {
        NetworkConnectivityLevelHintNone => NetworkLevel::None,
        NetworkConnectivityLevelHintLocalAccess => NetworkLevel::Local,
        NetworkConnectivityLevelHintInternetAccess | NetworkConnectivityLevelHintConstrainedInternetAccess => {
            NetworkLevel::Internet
        }
        _ => NetworkLevel::Unknown,
    }
}

#[cfg(not(windows))]
fn network_level() -> NetworkLevel {
    NetworkLevel::Unknown
}

/// Wakes the watcher when Windows reports a change in network connectivity.
#[cfg(windows)]
mod network_changes {
    use std::sync::Arc;

    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::NetworkManagement::IpHelper::NotifyNetworkConnectivityHintChange;
    use windows_sys::Win32::Networking::WinSock::NL_NETWORK_CONNECTIVITY_HINT;

    use super::Watcher;

    unsafe extern "system" fn changed(context: *const core::ffi::c_void, _hint: NL_NETWORK_CONNECTIVITY_HINT) {
        // SAFETY: `context` is the Watcher leaked in `subscribe`, which is never freed.
        let watcher = unsafe { &*(context as *const Watcher) };
        watcher.wake();
    }

    /// Registers for the app's whole lifetime (the watcher is never freed).
    pub fn subscribe(watcher: Arc<Watcher>) {
        let context = Arc::into_raw(watcher) as *const core::ffi::c_void;
        let mut handle: HANDLE = std::ptr::null_mut();
        // SAFETY: `changed` matches the callback signature, and `context` stays valid forever.
        let result = unsafe { NotifyNetworkConnectivityHintChange(Some(changed), context, false, &mut handle) };
        if result != 0 {
            eprintln!("Network change notifications unavailable (error {result}); checking on a timer only");
            // SAFETY: the registration failed, so nothing else holds the pointer.
            drop(unsafe { Arc::from_raw(context as *const Watcher) });
        }
    }
}

#[cfg(not(windows))]
mod network_changes {
    pub fn subscribe(_watcher: std::sync::Arc<super::Watcher>) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unreachable_server_is_never_online() {
        let watcher = Watcher::new(Api::new("http://127.0.0.1:9"));
        assert_eq!(watcher.status().state, ConnectivityState::Checking);
        let status = tauri::async_runtime::block_on(watcher.refresh());
        assert!(matches!(status.state, ConnectivityState::Offline | ConnectivityState::ServerUnavailable));
        assert!(status.checked_at > 0);
        assert_eq!(watcher.status().state, status.state, "result is kept");
    }

    /// A server that accepts connections and never answers, so a check lasts until its timeout.
    fn silent_server() -> (std::net::TcpListener, String) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        (listener, url)
    }

    #[test]
    fn silent_server_is_unavailable_and_checks_share_one_result() {
        let (_listener, url) = silent_server();
        let watcher = Watcher::new(Api::new(url));

        // A second check asked for while the first runs waits for it instead of sending another request.
        let first = std::thread::spawn({
            let watcher = Arc::clone(&watcher);
            move || tauri::async_runtime::block_on(watcher.refresh())
        });
        std::thread::sleep(Duration::from_millis(300));
        let second = tauri::async_runtime::block_on(watcher.refresh());
        let first = first.join().unwrap();

        assert_ne!(first.state, ConnectivityState::Online);
        assert_eq!(first.checked_at, second.checked_at);
        assert_eq!(watcher.shared.lock().unwrap().generation, 1, "only one check ran");
    }
}
