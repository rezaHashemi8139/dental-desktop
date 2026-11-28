import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSession } from "@/auth/store";

/**
 * The logged-in user's reminders on days of the home calendar, any number a day
 * (src-tauri/src/reminders.rs). Personal and kept on this computer only.
 * Throws a RustMessage (src/i18n/message.ts) on failure.
 */
export interface Reminder {
  id: string;
  /** Gregorian "YYYY-MM-DD". */
  day: string;
  text: string;
  /** Unix milliseconds. */
  createdAt: number;
}

/** The most a reminder can hold (MAX_TEXT_CHARS in src-tauri/src/reminders.rs). */
export const REMINDER_MAX_LENGTH = 500;

/** Bumped after every change, so every view of the reminders reads them again. */
let revision = 0;
const listeners = new Set<() => void>();

function changed() {
  revision += 1;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The reminders of the days in [fromDay, toDay) ("YYYY-MM-DD"), by day, in the order they were added. */
export function listReminders(fromDay: string, toDay: string): Promise<Reminder[]> {
  return invoke<Reminder[]>("list_reminders", { fromDay, toDay });
}

export async function addReminder(day: string, text: string): Promise<Reminder> {
  const reminder = await invoke<Reminder>("add_reminder", { day, text });
  changed();
  return reminder;
}

export async function deleteReminder(id: string): Promise<void> {
  await invoke<void>("delete_reminder", { id });
  changed();
}

/** The day after `iso` ("YYYY-MM-DD"). */
export function nextIsoDay(iso: string): string {
  return new Date(Date.parse(iso) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * The reminders of the days in [fromDay, toDay), by day; read again after every
 * change and whenever the user changes. Empty while there is no usable session
 * or no range (null).
 */
export function useReminders(range: { fromDay: string; toDay: string } | null): Map<string, Reminder[]> {
  const session = useSession();
  const current = useSyncExternalStore(subscribe, () => revision);
  const usable = !!session && !session.locked && !session.billing;
  const key = usable && range ? `${session.userId}/${range.fromDay}/${range.toDay}` : "";
  const [result, setResult] = useState<{ key: string; days: Map<string, Reminder[]> } | null>(null);

  useEffect(() => {
    if (!key || !range) return;
    let active = true;
    listReminders(range.fromDay, range.toDay).then(
      (reminders) => {
        if (!active) return;
        const days = new Map<string, Reminder[]>();
        for (const reminder of reminders) days.set(reminder.day, [...(days.get(reminder.day) ?? []), reminder]);
        setResult({ key, days });
      },
      (e) => console.warn("Could not list the reminders:", e),
    );
    return () => {
      active = false;
    };
    // `key` stands for the session and range; a new revision reads them again.
  }, [key, current]);

  // The previous range's reminders are not shown for the new one.
  return result && result.key === key ? result.days : EMPTY;
}

const EMPTY: Map<string, Reminder[]> = new Map();
