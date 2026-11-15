import { useCallback, useSyncExternalStore } from "react";
import { CALENDARS, type Calendar } from "./index";
import { useLanguage } from "./use-language";

/**
 * Which calendar dates are shown in. "auto" (the default) follows the language
 * (`_meta.calendar` in its file: Persian → Solar Hijri, English → Gregorian, ...); the user
 * can pick a fixed one from the header instead. Saved on this computer.
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
  return {
    choice: current,
    calendar: current === "auto" ? language.calendar : current,
    /** The calendar "auto" stands for in the current language. */
    languageCalendar: language.calendar,
    setChoice: setCalendarChoice,
  };
}

/**
 * Formats dates in the current language and calendar, e.g.
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
