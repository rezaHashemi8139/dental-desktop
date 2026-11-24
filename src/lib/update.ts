import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { RustMessage } from "@/i18n/message";

/**
 * New versions of the app, from Rust (src-tauri/src/update.rs), which checks the
 * server by itself while online. When `required` is set, the server no longer
 * lets this version work: the app shows only the update screen
 * (src/components/update-required-screen.tsx) until the update is installed.
 */
export interface UpdateStatus {
  currentVersion: string;
  available: { version: string; notes: string | null } | null;
  required: boolean;
  /** The version the server requires at least, when `required`. */
  minimumVersion: string | null;
  installing: boolean;
  error: RustMessage | null;
}

export interface DownloadProgress {
  downloaded: number;
  /** null when the size is unknown. */
  total: number | null;
}

interface Snapshot {
  status: UpdateStatus;
  progress: DownloadProgress | null;
}

let snapshot: Snapshot = {
  status: { currentVersion: "", available: null, required: false, minimumVersion: null, installing: false, error: null },
  progress: null,
};
const listeners = new Set<() => void>();

function update(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Call once at startup, before the first render: a required update must show at once. */
export async function initUpdates(): Promise<void> {
  await listen<UpdateStatus>("update", (event) => update({ status: event.payload }));
  await listen<DownloadProgress>("update-progress", (event) => update({ progress: event.payload }));
  update({ status: await invoke<UpdateStatus>("update_status") });
}

/** Asks the server for a new version now. */
export async function checkForUpdate(): Promise<UpdateStatus> {
  const status = await invoke<UpdateStatus>("check_for_update");
  update({ status });
  return status;
}

/**
 * Downloads and installs the new version. Logs out first; the app then closes
 * and the new version starts. Throws a RustMessage if it fails.
 */
export async function installUpdate(): Promise<void> {
  update({ progress: null });
  await invoke("install_update");
}

export function useUpdate(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}
