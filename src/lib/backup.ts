import { invoke } from "@tauri-apps/api/core";

/**
 * Encrypted backups of the clinic database (see src-tauri/src/backup.rs).
 * Managers only. A backup is locked with a password the user chooses and a
 * recovery key the app makes; neither is stored anywhere, so both are needed to
 * restore it. Each call throws a RustMessage (src/i18n/message.ts) on failure.
 */

/** File extension of backup files, without the dot. */
export const BACKUP_EXTENSION = "dbk";

/** A suggested file name, e.g. "dental-backup-2026-11-24.dbk". */
export function defaultBackupFileName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `dental-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.${BACKUP_EXTENSION}`;
}

/** Saves a backup to `path` (from a Save dialog). Returns the recovery key, shown to the user once. */
export function exportDatabase(path: string, password: string): Promise<string> {
  return invoke<string>("export_database", { path, password });
}

/** Replaces all clinic data on this computer with the backup at `path`. */
export function restoreDatabase(path: string, password: string, recoveryKey: string): Promise<void> {
  return invoke("restore_database", { path, password, recoveryKey });
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
