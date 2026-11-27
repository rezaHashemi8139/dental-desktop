import { useCallback, useSyncExternalStore } from "react";
import { useLanguage } from "./use-language";

/**
 * Calendars for showing dates. Display only: dates are always stored, compared and
 * sent to Rust and the server as plain timestamps; they are turned into Solar Hijri,
 * Gregorian or Lunar Hijri only here, while rendering.
 */

/** Intl calendar ids: Solar Hijri, Gregorian, Lunar Hijri. */
export type Calendar = "persian" | "gregory" | "islamic";
export const CALENDARS: readonly Calendar[] = ["persian", "gregory", "islamic"];

/** Default calendar of a language; any language not listed uses Gregorian. */
const LANGUAGE_CALENDARS: Record<string, Calendar> = {
  fa: "persian",
};

export function languageCalendar(languageCode: string): Calendar {
  return LANGUAGE_CALENDARS[languageCode] ?? "gregory";
}

/**
 * "auto" (the default) follows the language (see LANGUAGE_CALENDARS); the user
 * can pick a fixed calendar in Settings instead. Saved on this computer.
 */
export type CalendarChoice = "auto" | Calendar;

export const CALENDAR_CHOICES: readonly CalendarChoice[] = ["auto", ...CALENDARS];

const STORAGE_KEY = "calendar";

let choice: CalendarChoice = readSavedChoice();
const listeners = new Set<() => void>();

function readSavedChoice(): CalendarChoice {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && (CALENDAR_CHOICES as readonly string[]).includes(saved)) return saved as CalendarChoice;
  } catch {
    // Storage unavailable: use the default.
  }
  return "auto";
}

export function setCalendarChoice(next: CalendarChoice) {
  choice = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage unavailable: the choice just won't be remembered.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The user's choice, the calendar actually in use, and a way to change the choice. */
export function useCalendar() {
  const { language } = useLanguage();
  const current = useSyncExternalStore(subscribe, () => choice);
  const fromLanguage = languageCalendar(language.code);
  return {
    choice: current,
    calendar: current === "auto" ? fromLanguage : current,
    /** The calendar "auto" stands for in the current language. */
    languageCalendar: fromLanguage,
    setChoice: setCalendarChoice,
  };
}

/** A day in some calendar. Months count from 1. */
export interface DateParts {
  year: number;
  month: number;
  day: number;
}

const partsFormats = new Map<Calendar, Intl.DateTimeFormat>();

/** The day `date` falls on (in UTC) in `calendar`. */
export function calendarParts(date: Date, calendar: Calendar): DateParts {
  let format = partsFormats.get(calendar);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US-u-nu-latn", {
      calendar,
      timeZone: "UTC",
      year: "numeric",
      month: "numeric",
      day: "numeric",
    });
    partsFormats.set(calendar, format);
  }
  const parts = format.formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

const DAY_MS = 86_400_000;

/** About when (UTC milliseconds) the year `year` of `calendar` starts. */
function approximateYearStart(year: number, calendar: Calendar): number {
  const gregorianYear =
    calendar === "persian" ? year + 621 : calendar === "islamic" ? Math.round(year * 0.970229 + 621.57) : year;
  return Date.UTC(gregorianYear, 0, 1);
}

const order = ({ year, month, day }: DateParts) => year * 10_000 + month * 100 + day;

/**
 * The Gregorian date ("YYYY-MM-DD") of a day given in `calendar`, or null if that
 * day does not exist (e.g. a 30th of a 29-day month).
 */
export function toGregorian(parts: DateParts, calendar: Calendar): string | null {
  const { year, month, day } = parts;
  if (![year, month, day].every(Number.isInteger) || year < 1 || month < 1 || month > 13 || day < 1 || day > 31) {
    return null;
  }
  // Days only move forward in every calendar: search for the first day not before `parts`.
  const target = order(parts);
  let low = Math.floor(approximateYearStart(year, calendar) / DAY_MS) - 400;
  let high = low + 1200;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (order(calendarParts(new Date(middle * DAY_MS), calendar)) < target) low = middle + 1;
    else high = middle;
  }
  const date = new Date(low * DAY_MS);
  return order(calendarParts(date, calendar)) === target ? date.toISOString().slice(0, 10) : null;
}

/** The day a Gregorian "YYYY-MM-DD" is in `calendar`; null if `iso` is not such a date. */
export function fromGregorian(iso: string, calendar: Calendar): DateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : calendarParts(date, calendar);
}

/** A timestamp's local day as a Gregorian "YYYY-MM-DD". */
export function localIsoDate(date: Date | number): string {
  const d = new Date(date);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Formats a timestamp in the current language and calendar, e.g.
 * `formatDate(date, { dateStyle: "medium", timeStyle: "short" })`.
 */
export function useFormatDate() {
  const { language } = useLanguage();
  const { calendar } = useCalendar();
  return useCallback(
    (date: Date | number, options: Intl.DateTimeFormatOptions = { dateStyle: "medium" }) =>
      new Intl.DateTimeFormat(language.code, { ...options, calendar }).format(date),
    [language.code, calendar],
  );
}
