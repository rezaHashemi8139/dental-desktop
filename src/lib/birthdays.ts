import { useEffect, useMemo, useSyncExternalStore } from "react";
import { fromGregorian, localIsoDate, useCalendar, type Calendar } from "@/i18n/calendar";
import { useSession } from "@/auth/store";
import { refreshBirthDates } from "@/lib/members";
import { useClock } from "@/lib/network-clock";
import { listLocalUsers } from "@/lib/patients";

/** Someone whose birthday may be shown: their name and Gregorian "YYYY-MM-DD" birth date ("" if unknown). */
export interface BirthdayPerson {
  /** Local user id (Session.userId), when the person is one of this computer's users. */
  id?: string;
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

/** The people whose birthday falls on one day (Gregorian "YYYY-MM-DD"), counted as `monthBirthdays` does. */
export function dayBirthdays<T extends BirthdayPerson>(people: readonly T[], iso: string, calendar: Calendar): T[] {
  const day = fromGregorian(iso, calendar);
  if (!day) return [];
  const next = fromGregorian(new Date(Date.parse(iso) + 86_400_000).toISOString().slice(0, 10), calendar);
  const lastOfMonth = next?.month !== day.month;
  return people.filter((person) => {
    const born = person.birthDate ? fromGregorian(person.birthDate, calendar) : null;
    return !!born && born.month === day.month && (born.day === day.day || (lastOfMonth && born.day > day.day));
  });
}

/**
 * Whose birthday it is today (in the calendar in use, by the correct clock), and
 * whether it is the logged-in user's own. No one while nobody can use the clinic
 * (logged out, locked or a billing-only login).
 */
export function useTodayBirthdays(): { today: string; people: BirthdayPerson[]; mine: boolean } {
  const session = useSession();
  const { calendar } = useCalendar();
  const today = localIsoDate(useClock().now);
  const all = useBirthdayPeople();
  const usable = !!session && !session.locked && !session.billing;
  const people = useMemo(() => (usable ? dayBirthdays(all, today, calendar) : []), [usable, all, today, calendar]);
  const mine = !!session && people.some((person) => person.id === session.userId);
  return { today, people, mine };
}

/** Everyone who has logged in on this computer, as people with birthdays: shared by the home page and the header. */
let people: BirthdayPerson[] = [];
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The read in progress: the header, sidebar and home page all ask at login, and share one. */
let loading: Promise<void> | null = null;

function loadPeople(): Promise<void> {
  loading ??= listLocalUsers()
    .then(
      (users) => {
        people = users.map((user) => ({ id: user.id, name: user.fullName || user.username, birthDate: user.birthDate }));
        listeners.forEach((listener) => listener());
      },
      (e) => console.warn("Could not list the users for birthdays:", e),
    )
    .finally(() => {
      loading = null;
    });
  return loading;
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
    if (refresh) {
      refreshBirthDates().then(
        // After a read still in progress, which would miss the new dates.
        () => (loading ?? Promise.resolve()).then(loadPeople),
        (e) => console.warn("Could not refresh the birth dates:", e),
      );
    }
  }, [session, usable, refresh]);
  return useSyncExternalStore(subscribe, () => people);
}
