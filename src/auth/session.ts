import { invoke } from "@tauri-apps/api/core";
import type { PersonIdentityInput } from "./setup";

/** The logged-in user (see SessionInfo in src-tauri/src/auth.rs). */
export interface Session {
  userId: string;
  username: string;
  fullName: string;
  /** Local role, stored in the clinic database: "manager", "staff", ... */
  role: string;
  isAdmin: boolean;
  /** Logged in through the server (true) or offline from this computer (false). */
  online: boolean;
  /** Until when this user can log in without the server (unix seconds). */
  offlineUntil: number;
}

/**
 * What the login screen can offer (see ConnectionMode in src-tauri/src/auth.rs):
 * - "online": the server is reachable; login and sign-up go through it.
 * - "setup": the server is reachable but this computer was never set up: the clinic
 *   and its owner must be registered first (src/auth/setup.ts).
 * - "offline": no server, but the local database is usable and users have logged in here before: login only.
 * - "localDatabaseUnavailable": no server, and the local database (or the vault with its keys) is
 *   missing, damaged or unreadable: no offline login.
 * - "unavailable": no server and nothing to log in to locally.
 */
export type ConnectionMode = "online" | "setup" | "offline" | "localDatabaseUnavailable" | "unavailable";

// Each call throws a RustMessage (see src/i18n/message.ts) on failure.
// The server is only ever contacted from Rust.

export function currentSession(): Promise<Session | null> {
  return invoke<Session | null>("current_session");
}

/**
 * The login screen for the current connectivity. With `refresh`, the server is
 * checked first; otherwise the watcher's latest status is used (src/auth/connectivity.ts).
 */
export function connectionStatus(refresh: boolean): Promise<ConnectionMode> {
  return invoke<ConnectionMode>("connection_status", { refresh });
}

export function login(username: string, password: string): Promise<Session> {
  return invoke<Session>("login", { username, password });
}

/** A new account (see SignUpInput in src-tauri/src/auth.rs). */
export interface SignUpInput extends PersonIdentityInput {
  username: string;
  password: string;
  fullName: string;
  phone: string;
}

export function signUp(account: SignUpInput): Promise<void> {
  return invoke("sign_up", { account });
}

export function logout(): Promise<void> {
  return invoke("logout");
}

/** Same rules as the server (dental-server/internal/service/auth.go). */
export const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,32}$/;
/** Also needs a digit, a lowercase and an uppercase letter (src/auth/schemas.ts). */
export const MIN_PASSWORD_LENGTH = 8;
