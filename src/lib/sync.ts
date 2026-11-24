import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { RustMessage } from "@/i18n/message";

/**
 * Syncing the clinic's records with the server (src-tauri/src/sync.rs). Changes
 * are always saved locally first; Rust sends them whenever there is an online
 * session, and fetches what other computers changed. Financial data never syncs.
 */
export type SyncState = "offline" | "syncing" | "idle" | "error";

export interface SyncStatus {
  state: SyncState;
  /** Records changed on this computer and not on the server yet. */
  pending: number;
  /** Records the server refused; they wait until someone fixes them. */
  rejected: number;
  /** Unix seconds; 0 = not yet in this session. */
  lastSyncedAt: number;
  error: RustMessage | null;
}

let status: SyncStatus = { state: "offline", pending: 0, rejected: 0, lastSyncedAt: 0, error: null };
const listeners = new Set<() => void>();

function set(next: SyncStatus) {
  status = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Call once at startup. */
export async function initSync(): Promise<void> {
  await listen<SyncStatus>("sync", (event) => set(event.payload));
  await refreshSyncStatus();
}

/** Reads the status again, e.g. after logging in. */
export async function refreshSyncStatus(): Promise<void> {
  set(await invoke<SyncStatus>("sync_status"));
}

/** Syncs now, in the background; the status follows by itself. */
export function syncNow(): Promise<void> {
  return invoke("sync_now");
}

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(subscribe, () => status);
}
