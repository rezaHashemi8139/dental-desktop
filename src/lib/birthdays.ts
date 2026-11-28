import { useEffect, useSyncExternalStore } from "react";
import { fromGregorian, type Calendar } from "@/i18n/calendar";
import { useSession } from "@/auth/store";
import { refreshBirthDates } from "@/lib/members";
import { listLocalUsers } from "@/lib/patients";

/** Someone whose birthday may be shown: their name and Gregorian "YYYY-MM-DD" birth date ("" if unknown). */
export interface BirthdayPerson {
  name: string;
  birthDate: string;
}

/**
 * Whose birthday falls on each day of `days` (the Gregorian "YYYY-MM-DD" days of
 * one month of `calendar`). Birthdays count in that calendar: someone born on
 * 10 Mordad has it on 10 Mordad every Solar Hijri year. A birthday on a day the
 * month does not have this year (30 Esfand, 29 February) falls on its last day.
 */
export function monthBirthdays(
  people: readonly BirthdayPerson[],
  days: readonly string[],
  calendar: Calendar,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const month = days.length ? fromGregorian(days[0], calendar)?.month : undefined;
  if (month === undefined) return result;
  for (const person of people) {
    const born = person.birthDate ? fromGregorian(person.birthDate, calendar) : null;
    if (!born || born.month !== month) continue;
    const iso = days[Math.min(born.day, days.length) - 1];
    result.set(iso, [...(result.get(iso) ?? []), person.name]);
  }
  return result;
}

/** Whose birthday falls on one day (Gregorian "YYYY-MM-DD"), counted as `monthBirthdays` does. */
export function dayBirthdays(people: readonly BirthdayPerson[], iso: string, calendar: Calendar): string[] {
  const day = fromGregorian(iso, calendar);
  if (!day) return [];
  const next = fromGregorian(new Date(Date.parse(iso) + 86_400_000).toISOString().slice(0, 10), calendar);
  const lastOfMonth = next?.month !== day.month;
  return people
    .filter((person) => {
      const born = person.birthDate ? fromGregorian(person.birthDate, calendar) : null;
      return !!born && born.month === day.month && (born.day === day.day || (lastOfMonth && born.day > day.day));
    })
    .map((person) => person.name);
}

/** Everyone who has logged in on this computer, as people with birthdays: shared by the home page and the header. */
let people: BirthdayPerson[] = [];
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function loadPeople(): Promise<void> {
  try {
    const users = await listLocalUsers();
    people = users.map((user) => ({ name: user.fullName || user.username, birthDate: user.birthDate }));
    listeners.forEach((listener) => listener());
  } catch (e) {
    console.warn("Could not list the users for birthdays:", e);
  }
}

/**
 * The birthdays of everyone who has logged in on this computer, read again when
 * the session changes (e.g. after the user saved their birth date in the profile).
 * With `refresh`, also copies the server's latest birth dates first (online only).
 */
export function useBirthdayPeople(refresh = false): BirthdayPerson[] {
  const session = useSession();
  const usable = !!session && !session.locked && !session.billing;
  useEffect(() => {
    if (!usable) return;
    // This computer's copy at once, then again with the server's latest.
    void loadPeople();
    if (refresh) refreshBirthDates().then(loadPeople, (e) => console.warn("Could not refresh the birth dates:", e));
  }, [session, usable, refresh]);
  return useSyncExternalStore(subscribe, () => people);
}
