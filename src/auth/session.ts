import { invoke } from "@tauri-apps/api/core";
import type { RustMessage } from "@/i18n/message";
import type { PersonIdentityInput } from "./setup";

/** The logged-in user (see SessionInfo in src-tauri/src/auth.rs). */
export interface Session {
  userId: string;
  username: string;
  fullName: string;
  /** Local role, stored in the clinic database: "manager", "staff", ... */
  role: string;
  isAdmin: boolean;
  /** Owns the clinic, so can buy its subscription. Only known online: false offline. */
  isOwner: boolean;
  /** Logged in through the server (true) or offline from this computer (false). */
  online: boolean;
  /** Until when this user can log in without the server (unix seconds). */
  offlineUntil: number;
  /**
   * Set for the owner's restricted login: why the clinic cannot be used now (no
   * subscription in force, or over its limits). Only the subscription page works,
   * and the clinic's data stays locked (src/lib/billing.ts).
   */
  billing: RustMessage | null;
  /** Locked by the user: the lock screen shows until the password is given (`unlockSession`). */
  locked: boolean;
}

/**
 * What the login screen can offer (see ConnectionMode in src-tauri/src/auth.rs):
 * - "online": the server is reachable; login and sign-up go through it.
 * - "setup": the server is reachable but this computer is not connected to a clinic yet:
 *   login and sign-up work, and logging in leads to picking or adding the clinic (src/auth/setup.ts).
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
  /** Optional: empty for none. */
  email: string;
}

export function signUp(account: SignUpInput): Promise<void> {
  return invoke("sign_up", { account });
}

/**
 * Replaces a password, proven with the current one: e.g. the temporary password a
 * clinic admin gave, which the server refuses to log in with until it is changed.
 * Needs the server. Does not log in.
 */
export function changePassword(username: string, currentPassword: string, newPassword: string): Promise<void> {
  return invoke("change_password", { username, currentPassword, newPassword });
}

/** The error of a login refused because the account still has a temporary password. */
export const PASSWORD_CHANGE_REQUIRED = "auth.errors.passwordChangeRequired";

/**
 * A restricted login (Session.billing) whose subscription is now active: Rust logs
 * in again with the credentials it kept, so the clinic opens without the password
 * being typed. The new session may still be restricted (e.g. this clinic is not
 * covered yet).
 */
export function resumeLogin(): Promise<Session> {
  return invoke<Session>("resume_login");
}

export function logout(): Promise<void> {
  return invoke("logout");
}

/**
 * Locks the open login: the lock screen shows (src/components/lock-screen.tsx)
 * and Rust refuses clinic data until `unlockSession`. Returns the session.
 */
export function lockSession(): Promise<Session> {
  return invoke<Session>("lock_session");
}

/**
 * Opens a locked login with the user's own password. After `MAX_WRONG_PASSWORDS`
 * wrong ones in a row (src/lib/backup.ts) Rust logs out instead.
 */
export function unlockSession(password: string): Promise<Session> {
  return invoke<Session>("unlock_session", { password });
}

/** The logged-in user's own account (see Profile in src-tauri/src/profile.rs). */
export interface Profile {
  username: string;
  fullName: string;
  /** The identification code; empty if the account has none. */
  identity: string;
  phone: string;
  /** Empty when none was given. */
  email: string;
  /** Gregorian "YYYY-MM-DD"; empty when none was given. */
  birthDate: string;
}

/** What the user can change about their account; the rest is fixed. */
export interface ProfileInput {
  fullName: string;
  phone: string;
  /** Optional: empty removes the email on file. */
  email: string;
  /** Optional, Gregorian "YYYY-MM-DD": empty removes the birth date on file. */
  birthDate: string;
}

/** Needs the server. */
export function getProfile(): Promise<Profile> {
  return invoke<Profile>("get_profile");
}

/** Needs the server. Returns the session, with the new name. */
export function updateProfile(profile: ProfileInput): Promise<Session> {
  return invoke<Session>("update_profile", { profile });
}

/**
 * The logged-in user's own password, proven with the current one. Needs the server,
 * which then ends every session of the account; Rust logs in again with the new
 * password, so the session goes on: returns it. If that fails, the session ends
 * (event "session-ended") and the login screen asks for the new password.
 */
export function changeOwnPassword(currentPassword: string, newPassword: string): Promise<Session> {
  return invoke<Session>("change_own_password", { currentPassword, newPassword });
}

/** Same rules as the server (dental-server/internal/service/auth.go). */
export const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,32}$/;
/** Also needs a digit, a lowercase and an uppercase letter (src/auth/schemas.ts). */
export const MIN_PASSWORD_LENGTH = 8;
