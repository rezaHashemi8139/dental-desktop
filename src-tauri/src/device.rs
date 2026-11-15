//! Describes this computer for InstallationService.Register.

use sysinfo::{CpuRefreshKind, Networks, System};

use crate::proto::MachineInfo;
use crate::secure::sha256;

pub fn machine_info() -> MachineInfo {
    let mut system = System::new().ok();
    if let Some(system) = system.as_mut() {
        system.refresh_memory();
        system.refresh_cpu_list(CpuRefreshKind::nothing());
    }

    MachineInfo {
        machine_id_hash: machine_id_hash().to_vec(),
        hostname: System::host_name().unwrap_or_default(),
        os_name: System::long_os_version().or_else(|_| System::name()).unwrap_or_default(),
        os_version: System::os_version().unwrap_or_default(),
        cpu_model: system
            .as_ref()
            .and_then(|s| s.cpus().first())
            .map(|cpu| cpu.brand().trim().to_owned())
            .unwrap_or_default(),
        cpu_cores: System::physical_core_count().unwrap_or(0) as u32,
        memory_bytes: system.as_ref().map(|s| s.total_memory()).unwrap_or(0),
        mac_addresses: mac_addresses(),
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
    }
}

/// SHA-256 of the Windows MachineGuid, prefixed so the hash is only meaningful to this app.
/// Falls back to the hostname where there is no MachineGuid.
fn machine_id_hash() -> [u8; 32] {
    let id = windows_machine_guid().or_else(|| System::host_name().ok()).unwrap_or_default();
    sha256(format!("dental/machine-id/v1:{id}").as_bytes())
}

#[cfg(windows)]
fn windows_machine_guid() -> Option<String> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
    winreg::RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(r"SOFTWARE\Microsoft\Cryptography", KEY_READ | KEY_WOW64_64KEY)
        .and_then(|key| key.get_value::<String, _>("MachineGuid"))
        .ok()
}

#[cfg(not(windows))]
fn windows_machine_guid() -> Option<String> {
    None
}

fn mac_addresses() -> Vec<String> {
    let Ok(networks) = Networks::new_with_refreshed_list() else {
        return Vec::new();
    };
    let mut macs: Vec<String> = networks
        .iter()
        .map(|(_, data)| data.mac_address())
        .filter(|mac| !mac.is_unspecified())
        .map(|mac| mac.to_string().to_uppercase())
        .collect();
    macs.sort();
    macs.dedup();
    macs.truncate(32);
    macs
}
