//! Protection against turning the system clock back to keep an offline login alive.
//!
//! The app remembers the latest time it has seen (in the vault and in the registry)
//! and compares the clock with the newest modification time of Windows event logs,
//! which keep moving forward on their own. If the clock is earlier than any of
//! these, it has been turned back and offline login is refused.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Small clock corrections (NTP, time zone glitches) are not tampering.
pub const TOLERANCE: Duration = Duration::from_secs(10 * 60);

pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Unix time in milliseconds: for synced records, whose latest change wins.
pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// True if `now` is not earlier than any of `known_times` (minus [`TOLERANCE`]).
pub fn is_plausible(now: i64, known_times: &[i64]) -> bool {
    let latest = known_times.iter().copied().max().unwrap_or(0);
    now + TOLERANCE.as_secs() as i64 >= latest
}

/// Newest modification time of files Windows writes to all the time.
pub fn system_activity_time() -> i64 {
    #[cfg(windows)]
    const FILES: &[&str] = &[
        r"C:\Windows\System32\winevt\Logs\System.evtx",
        r"C:\Windows\System32\winevt\Logs\Application.evtx",
        r"C:\Windows\System32\winevt\Logs\Microsoft-Windows-Time-Service%4Operational.evtx",
    ];
    #[cfg(not(windows))]
    const FILES: &[&str] = &["/var/log/syslog", "/var/log/messages"];

    FILES
        .iter()
        .filter_map(|path| std::fs::metadata(path).ok()?.modified().ok())
        .filter_map(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .max()
        .unwrap_or(0)
}

const REGISTRY_PATH: &str = r"Software\DentalSmartManagementBase";
const REGISTRY_VALUE: &str = "LastSeen";

/// Latest time saved in the registry (0 if none).
pub fn registry_last_seen() -> i64 {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        winreg::RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(REGISTRY_PATH)
            .and_then(|key| key.get_value::<u64, _>(REGISTRY_VALUE))
            .map(|v| v as i64)
            .unwrap_or(0)
    }
    #[cfg(not(windows))]
    {
        0
    }
}

/// Raises the registry's latest time to `time` (never lowers it).
pub fn save_registry_last_seen(time: i64) {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        if time <= registry_last_seen() {
            return;
        }
        if let Ok((key, _)) = winreg::RegKey::predef(HKEY_CURRENT_USER).create_subkey(REGISTRY_PATH) {
            let _ = key.set_value(REGISTRY_VALUE, &(time as u64));
        }
    }
    #[cfg(not(windows))]
    let _ = time;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plausibility() {
        let now = 1_000_000;
        assert!(is_plausible(now, &[]));
        assert!(is_plausible(now, &[now - 100, now]));
        assert!(is_plausible(now, &[now + 60]), "small corrections are allowed");
        assert!(!is_plausible(now, &[now + 2 * 3600]), "clock turned back two hours");
    }

    #[test]
    fn system_activity_is_recent() {
        let activity = system_activity_time();
        assert!(activity > 0, "no system activity time found");
        assert!(is_plausible(now_unix(), &[activity]));
    }
}
