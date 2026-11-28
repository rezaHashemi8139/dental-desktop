import { invoke } from "@tauri-apps/api/core";
import { localIsoDate, toGregorian, fromGregorian, type Calendar } from "@/i18n/calendar";

/**
 * Working hours (src-tauri/src/work_hours.rs): when a user came in and left, and
 * notes per day. Kept on this computer only: never sent to the server. Everyone
 * can see everyone's hours, but changes only their own; a manager can change anyone's.
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

/** An entry's times, for `replaceWorkDay`. */
export type EntryTimes = Pick<WorkHoursInput, "startedAt" | "endedAt">;

/**
 * Replaces `userId`'s entries of the Gregorian `day` ("YYYY-MM-DD") with `entries`:
 * all or none. Each must lie within the day; an exit at the next midnight ends it.
 * A refusal names the entry it is about as `params.row`, counted from 1 in the order
 * given. No entries empties the day.
 */
export function replaceWorkDay(userId: string, day: string, entries: EntryTimes[]): Promise<WorkHours[]> {
  return invoke<WorkHours[]>("replace_work_day", {
    userId,
    from: localMidnight(day),
    to: localMidnight(nextDay(day)),
    entries,
  });
}

/**
 * Records `userId`'s exit at `at`. An entry from an earlier day ends at that day's
 * midnight, a new one starts at each midnight since, and the last ends at `at`.
 */
export function clockOut(userId: string, at: number, openSince: number): Promise<WorkHours[]> {
  return invoke<WorkHours[]>("clock_out", { userId, at, midnights: midnightsBetween(openSince, at) });
}

/** One user's hours in a month, for the overview of everyone. */
export interface UserTotal {
  /** A LocalUser id. */
  userId: string;
  /** Time worked in the finished entries, in milliseconds. */
  totalMillis: number;
  /** Days with an entry. */
  days: number;
  /** At work now (an entry without an exit). */
  atWork: boolean;
}

/** Every user's hours in `month`, everyone included even with none. */
export function workHoursSummary(month: CalendarMonth): Promise<UserTotal[]> {
  return invoke<UserTotal[]>("work_hours_summary", { from: month.start, to: month.end });
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

/** The Gregorian day after `iso` ("YYYY-MM-DD"). */
export function nextDay(iso: string): string {
  return addDays(iso, 1);
}

/** The Gregorian day `days` after `iso` ("YYYY-MM-DD"); negative goes back. */
export function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  return localIsoDate(new Date(year, month - 1, day + days));
}

/** One day of one user's hours: its entries, finished time and notes. */
export interface WorkDay {
  /** A LocalUser id. */
  userId: string;
  /** Gregorian "YYYY-MM-DD". */
  day: string;
  /** Entries that started on the day, oldest first. */
  entries: WorkHours[];
  /** Time worked in the finished entries, in milliseconds. */
  totalMillis: number;
  /** The day's notes, "" for none. */
  notes: string;
}

/**
 * `userId`'s days in `list` that have entries or notes, plus each day of `include`
 * even when empty; newest first.
 */
export function groupByDay(userId: string, list: WorkHoursList, include: string[] = []): WorkDay[] {
  const days = new Map<string, WorkDay>();
  const dayOf = (day: string) => {
    let found = days.get(day);
    if (!found) {
      found = { userId, day, entries: [], totalMillis: 0, notes: "" };
      days.set(day, found);
    }
    return found;
  };
  for (const day of include) dayOf(day);
  for (const entry of list.entries) {
    const day = dayOf(localIsoDate(entry.startedAt));
    day.entries.push(entry);
    if (entry.endedAt) day.totalMillis += entry.endedAt - entry.startedAt;
  }
  for (const note of list.dayNotes) dayOf(note.day).notes = note.notes;
  return [...days.values()].sort((a, b) => b.day.localeCompare(a.day));
}

/** The local midnights after `from` and before `to` (unix milliseconds), oldest first. */
function midnightsBetween(from: number, to: number): number[] {
  const midnights: number[] = [];
  for (let day = nextDay(localIsoDate(from)); localMidnight(day) < to; day = nextDay(day)) {
    midnights.push(localMidnight(day));
  }
  return midnights;
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
