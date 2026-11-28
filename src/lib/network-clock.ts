import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getConnectivity, subscribeConnectivity } from "@/auth/connectivity";

/**
 * The correct time for the clocks in the header and on the home page. With
 * internet, it is the network time (NTP, see src-tauri/src/network_time.rs)
 * shown in the system's time zone; without it, the system clock. Also tells
 * whether the system clock is wrong, so the home page can warn about it.
 *
 * Display only: records keep using the system clock (Date.now() and Rust).
 * One ticker for the whole app; components read it with `useClock()`.
 */
export interface NetworkTime {
  /** Network time minus system time, in milliseconds (positive: the system clock is behind). */
  offsetMs: number;
  /** Where the time came from, e.g. "time.cloudflare.com". */
  source: string;
  /** When it was measured, by the system clock (unix milliseconds). */
  checkedAt: number;
}

export interface Clock {
  /** The correct time (unix milliseconds): the network's when known, otherwise the system's. */
  now: number;
  /** The system clock at the same moment. */
  systemNow: number;
  /** The latest network answer; null without internet. */
  network: NetworkTime | null;
}

/** A system clock off by more than this is wrong (the header clock shows minutes). */
const TOLERANCE_MS = 60_000;
/** Time between checks while the network answers, and while it does not. */
const CHECK_INTERVAL_MS = 15 * 60_000;
const RETRY_INTERVAL_MS = 60_000;
/** Between two ticks the system clock moved this much more (or less) than real time: someone changed it. */
const JUMP_MS = 5_000;

let network: NetworkTime | null = null;
let snapshot: Clock = read();
const listeners = new Set<() => void>();

let checking: Promise<void> | null = null;
let checkTimer: ReturnType<typeof setTimeout> | undefined;
let lastSystem = Date.now();
let lastMonotonic = performance.now();

function read(): Clock {
  const systemNow = Date.now();
  return { now: systemNow + (network?.offsetMs ?? 0), systemNow, network };
}

function publish() {
  snapshot = read();
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Asks Rust for the network time now (or joins the request already running). */
function check(): Promise<void> {
  if (checking) return checking;
  clearTimeout(checkTimer);
  checking = (async () => {
    try {
      network = await invoke<NetworkTime | null>("network_time");
    } catch (e) {
      console.warn("Could not get the network time:", e);
      network = null;
    }
    publish();
    checkTimer = setTimeout(check, network ? CHECK_INTERVAL_MS : RETRY_INTERVAL_MS);
  })().finally(() => {
    checking = null;
  });
  return checking;
}

/** Runs every second, on the second of the correct time, so displayed seconds change on time. */
function tick() {
  const system = Date.now();
  const monotonic = performance.now();
  const jump = system - lastSystem - (monotonic - lastMonotonic);
  lastSystem = system;
  lastMonotonic = monotonic;
  if (Math.abs(jump) > JUMP_MS) {
    // The system clock was changed (or the computer slept): the network time did
    // not jump, so the offset moves the other way until a fresh check confirms it.
    if (network) network = { ...network, offsetMs: network.offsetMs - jump };
    void check();
  }
  publish();
  setTimeout(tick, 1000 - (snapshot.now % 1000));
}

/** Call once at startup. Does not wait for the network: the system clock shows until it answers. */
export function initNetworkClock() {
  void check();
  let level = getConnectivity().network;
  // A new network (or none) may change the answer: check again right away.
  subscribeConnectivity(() => {
    const next = getConnectivity().network;
    if (next === level) return;
    level = next;
    void check();
  });
  setTimeout(tick, 1000 - (snapshot.now % 1000));
}

/** The current time, updated every second. */
export function useClock(): Clock {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/** True when the network time is known and the system clock differs from it noticeably. */
export function isSystemClockWrong(clock: Clock): boolean {
  return clock.network !== null && Math.abs(clock.network.offsetMs) > TOLERANCE_MS;
}
