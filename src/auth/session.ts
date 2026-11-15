import { invoke } from "@tauri-apps/api/core";

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
 * - "offline": no server, but this computer has the clinic database and users who logged in before: login only.
 * - "unavailable": no server and nothing to log in to locally.
 */
export type ConnectionMode = "online" | "offline" | "unavailable";

// Each call throws a RustMessage (see src/i18n/message.ts) on failure.
// The server is only ever contacted from Rust.

export function currentSession(): Promise<Session | null> {
  return invoke<Session | null>("current_session");
}

export function connectionStatus(): Promise<ConnectionMode> {
  return invoke<ConnectionMode>("connection_status");
}

export function login(username: string, password: string): Promise<Session> {
  return invoke<Session>("login", { username, password });
}

export function signUp(username: string, password: string, fullName: string): Promise<void> {
  return invoke("sign_up", { username, password, fullName });
}

export function logout(): Promise<void> {
  return invoke("logout");
}

/** Same rules as the server (dental-server/internal/service/auth.go). */
export const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,32}$/;
/** Also needs a digit, a lowercase and an uppercase letter (src/auth/schemas.ts). */
export const MIN_PASSWORD_LENGTH = 8;
