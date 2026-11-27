import { invoke } from "@tauri-apps/api/core";
import { localIsoDate, toGregorian, fromGregorian, type Calendar } from "@/i18n/calendar";

/**
 * Working hours (src-tauri/src/work_hours.rs): when a user came in and left, and
 * notes per day. Kept on this computer only: never sent to the server. Everyone
 * records their own hours; a manager can also record and see anyone's.
 *
 * A user may come and go any number of times a day, but in order: until the last
 * entry has its exit ("open"), no new entry can be added.
 *
 * Each call throws a RustMessage (src/i18n/message.ts) on failure.
 */

export interface WorkHoursInput {
  /** Who worked: a LocalUser id (src/lib/patients.ts). */
  userId: string;
  /** Came in, unix milliseconds. */
  startedAt: number;
  /** Left, unix milliseconds; null while still at work. */
  endedAt: number | null;
}

export interface WorkHours {
  id: string;
  userId: string;
  startedAt: number;
  endedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkHoursList {
  /** Entries that started in the period, oldest first. */
  entries: WorkHours[];
  /** Time worked in the finished entries, in milliseconds. */
  totalMillis: number;
  /** The user's entry still without an exit, whenever it started. */
  open: WorkHours | null;
  /** Notes of the days in the period, by day. */
  dayNotes: DayNote[];
}

/** A user's notes for one day. */
export interface DayNote {
  /** Local day, Gregorian "YYYY-MM-DD". */
  day: string;
  notes: string;
}

/** `userId`'s entries that started in `month`, their open one, and their notes of its days. */
export function listWorkHours(userId: string, month: CalendarMonth): Promise<WorkHoursList> {
  return invoke<WorkHoursList>("list_work_hours", {
    userId,
    from: month.start,
    to: month.end,
    fromDay: localIsoDate(month.start),
    toDay: localIsoDate(month.end),
  });
}

/** Adds an entry, or changes one (`id`). Entries of the same user may not overlap. */
export function saveWorkHours(entry: WorkHoursInput, id?: string): Promise<WorkHours> {
  return invoke<WorkHours>("save_work_hours", { id: id ?? null, entry });
}

export function deleteWorkHours(id: string): Promise<void> {
  return invoke("delete_work_hours", { id });
}

/** Sets `userId`'s notes for `day` ("YYYY-MM-DD"); empty notes remove them. */
export function saveWorkDayNote(userId: string, day: string, notes: string): Promise<DayNote> {
  return invoke<DayNote>("save_work_day_note", { userId, day, notes });
}

/** A month of the calendar in use, as local times. */
export interface CalendarMonth {
  /** Local midnight of its first day (unix milliseconds). */
  start: number;
  /** Local midnight of the next month's first day. */
  end: number;
}

/** Local midnight of a Gregorian "YYYY-MM-DD". */
export function localMidnight(iso: string): number {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day).getTime();
}

/** The month of `calendar` that the local day of `date` falls in. */
export function calendarMonth(date: number, calendar: Calendar): CalendarMonth {
  const { year, month } = fromGregorian(localIsoDate(date), calendar)!;
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  return {
    start: localMidnight(toGregorian({ year, month, day: 1 }, calendar)!),
    end: localMidnight(toGregorian({ ...next, day: 1 }, calendar)!),
  };
}

/** Whole minutes in a span of milliseconds, split into hours and minutes. */
export function hoursAndMinutes(millis: number): { hours: number; minutes: number } {
  const minutes = Math.floor(millis / 60_000);
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}
