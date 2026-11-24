import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Whether the app can work online, from the single connectivity watcher in Rust
 * (src-tauri/src/connectivity.rs). The app is "online" only when the server's
 * health check answers; internet access alone is not enough. Components read it
 * with `useConnectivity()` and never check connectivity themselves.
 */
export type ConnectivityState = "checking" | "offline" | "serverUnavailable" | "online";

/** What the operating system reports about the network (see NetworkLevel in connectivity.rs). */
export type NetworkLevel = "unknown" | "none" | "local" | "internet";

export interface ConnectivityStatus {
  state: ConnectivityState;
  network: NetworkLevel;
  /** When the status was determined (unix seconds); 0 before the first check. */
  checkedAt: number;
}

interface Snapshot {
  status: ConnectivityStatus;
  /** A check asked for from here (`checkConnectivity`) is running. */
  checking: boolean;
}

let snapshot: Snapshot = { status: { state: "checking", network: "unknown", checkedAt: 0 }, checking: false };
const listeners = new Set<() => void>();

function update(next: Partial<Snapshot>) {
  // An older result (e.g. a command answer overtaken by an event) never replaces a newer one.
  if (next.status && next.status.checkedAt < snapshot.status.checkedAt) delete next.status;
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Call once at startup: follows the watcher's status from then on. */
export async function initConnectivity(): Promise<void> {
  await listen<ConnectivityStatus>("connectivity", (event) => update({ status: event.payload }));
  update({ status: await invoke<ConnectivityStatus>("connectivity_status") });
}

/** Checks now (joining a check already running in Rust) and returns the result. */
export async function checkConnectivity(): Promise<ConnectivityStatus> {
  update({ checking: true });
  try {
    update({ status: await invoke<ConnectivityStatus>("check_connectivity") });
  } finally {
    update({ checking: false });
  }
  return snapshot.status;
}

export function getConnectivity(): ConnectivityStatus {
  return snapshot.status;
}

/** Calls `listener` after every change, outside React. Returns a function that stops it. */
export function subscribeConnectivity(listener: () => void): () => void {
  return subscribe(listener);
}

export function useConnectivity(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}
