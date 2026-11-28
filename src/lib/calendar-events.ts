import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Occasions and public holidays of Solar Hijri months, for the home page's
 * calendar. They come from holidayapi.ir through Rust (src-tauri/src/calendar_events.rs),
 * in Persian as Iran's official calendar publishes them. Each month is fetched
 * once per run; a month that failed (no internet) is fetched again when asked.
 */
export interface CalendarEvent {
  title: string;
  /** The day in the occasion's own calendar, e.g. "13 Rajab" or "December 25" (Persian digits and names). */
  date: string;
  /** This occasion makes the day a public holiday. */
  holiday: boolean;
}

export interface CalendarDay {
  /** Day of the month, from 1. */
  day: number;
  /** A public holiday (Fridays included). */
  holiday: boolean;
  events: CalendarEvent[];
}

/** Shown as the source under the list. */
export const CALENDAR_EVENTS_SOURCE = "holidayapi.ir";

/** A Solar Hijri month and its days, as Gregorian "YYYY-MM-DD" (CalendarPicker's onMonthChange). */
export interface SolarMonth {
  year: number;
  month: number;
  days: string[];
}

const months = new Map<string, Promise<CalendarDay[] | null>>();

/** The days of a Solar Hijri month with `days` days; null if they could not be fetched. */
export function solarMonthEvents(year: number, month: number, days: number): Promise<CalendarDay[] | null> {
  const key = `${year}-${month}`;
  let pending = months.get(key);
  if (!pending) {
    pending = invoke<CalendarDay[] | null>("calendar_events", { year, month, days }).catch((e) => {
      console.warn("Could not get the calendar events:", e);
      return null;
    });
    months.set(key, pending);
    // Not kept when it failed, so the next attempt asks again.
    void pending.then((result) => result || months.delete(key));
  }
  return pending;
}

export type MonthEvents =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; days: CalendarDay[] };

/** The events of `month` (none asked while it is null), and a way to try again after a failure. */
export function useSolarMonthEvents(month: SolarMonth | null): { events: MonthEvents; retry: () => void } {
  const key = month ? `${month.year}-${month.month}` : "";
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; days: CalendarDay[] | null } | null>(null);

  useEffect(() => {
    if (!month) return;
    let current = true;
    solarMonthEvents(month.year, month.month, month.days.length).then(
      (days) => current && setResult({ key, days }),
    );
    return () => {
      current = false;
    };
    // `key` stands for `month`; a new attempt asks again.
  }, [key, attempt]);

  const events: MonthEvents =
    result?.key !== key ? { status: "loading" } : result.days ? { status: "ready", days: result.days } : { status: "failed" };
  return {
    events,
    retry: () => {
      setResult(null);
      setAttempt((count) => count + 1);
    },
  };
}
