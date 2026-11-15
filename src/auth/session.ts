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

// Each call throws a RustMessage (see src/i18n/message.ts) on failure.

export function currentSession(): Promise<Session | null> {
  return invoke<Session | null>("current_session");
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
export const MIN_PASSWORD_LENGTH = 10;
