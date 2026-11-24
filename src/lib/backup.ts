import { invoke } from "@tauri-apps/api/core";

/**
 * Encrypted backups of the clinic database, and clearing it (see src-tauri/src/backup.rs).
 * Managers only. A backup is locked with a password the user chooses and a
 * recovery key the app makes; neither is stored anywhere, so both are needed to
 * restore it. Each call throws a RustMessage (src/i18n/message.ts) on failure.
 *
 * Every action also takes the manager's own account password (`accountPassword`),
 * which Rust checks before anything else, together with the role. After
 * MAX_WRONG_PASSWORDS wrong ones in a row Rust logs out (event "session-ended").
 */

/** Same as MAX_WRONG_PASSWORDS in src-tauri/src/auth.rs. */
export const MAX_WRONG_PASSWORDS = 3;

/** File extension of backup files, without the dot. */
export const BACKUP_EXTENSION = "dbk";

/** A suggested file name, e.g. "dental-backup-2026-11-24.dbk". */
export function defaultBackupFileName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `dental-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.${BACKUP_EXTENSION}`;
}

/** Saves a backup to `path` (from a Save dialog). Returns the recovery key, shown to the user once. */
export function exportDatabase(accountPassword: string, path: string, password: string): Promise<string> {
  return invoke<string>("export_database", { accountPassword, path, password });
}

/**
 * What a restore does with the data already on this computer: replace it all, or
 * add the backup's data to it, keeping this computer's version of what both have.
 */
export type RestoreMode = "replace" | "merge";

/** Restores the backup at `path` into the clinic data on this computer (see RestoreMode). */
export function restoreDatabase(
  accountPassword: string,
  path: string,
  password: string,
  recoveryKey: string,
  mode: RestoreMode,
): Promise<void> {
  return invoke("restore_database", { accountPassword, path, password, recoveryKey, mode });
}

/** Deletes all clinic data on this computer; the manager who does it keeps access. */
export function clearDatabase(accountPassword: string): Promise<void> {
  return invoke("clear_database", { accountPassword });
}

/**
 * A recovery key as typed: 36 hex digits (shown in groups of 4 joined by dashes);
 * case, spaces and dashes don't matter. Rust also checks its checksum.
 */
export function isRecoveryKeyFormat(text: string): boolean {
  return /^[0-9a-f]{36}$/i.test(text.replace(/[\s-]/g, ""));
}

/** The file name at the end of a path, for display. */
export function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
}
