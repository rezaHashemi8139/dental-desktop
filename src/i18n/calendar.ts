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
 * can pick a fixed calendar from the header instead. Saved on this computer.
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
