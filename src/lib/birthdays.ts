import { fromGregorian, type Calendar } from "@/i18n/calendar";

/**
 * Whose birthday falls on each day of `days` (the Gregorian "YYYY-MM-DD" days of
 * one month of `calendar`). Birthdays count in that calendar: someone born on
 * 10 Mordad has it on 10 Mordad every Solar Hijri year. A birthday on a day the
 * month does not have this year (30 Esfand, 29 February) falls on its last day.
 */
export function monthBirthdays(
  people: readonly { name: string; birthDate: string }[],
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
