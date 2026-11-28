import { useMemo, useState } from "react";
import { BellIcon, BellPlusIcon, ClockAlertIcon, GlobeIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { localIsoDate, useCalendar, useFormatDate, type Calendar } from "@/i18n/calendar";
import { useLanguage } from "@/i18n/use-language";
import { monthBirthdays, useBirthdayPeople } from "@/lib/birthdays";
import { useSolarMonthEvents, type SolarMonth } from "@/lib/calendar-events";
import { isSystemClockWrong, useClock } from "@/lib/network-clock";
import { nextIsoDay, useReminders } from "@/lib/reminders";
import { CalendarPicker, type DayMark } from "@/components/calendar-picker";
import { MonthEvents } from "@/components/month-events";
import { PartyHatIcon } from "@/components/party-hat-icon";
import { ReminderDialog } from "@/components/reminder-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The home page's calendar state, shared by its two cards: the month shown and the
 * day picked (ClockCard), and that month's holidays, occasions (Solar Hijri only),
 * the birthdays of the clinic's staff and the user's reminders (HomeMonthEvents).
 */
export function useHomeCalendar() {
  const { t } = useTranslation();
  const { calendar } = useCalendar();
  const clock = useClock();
  const today = localIsoDate(clock.now);
  // Days can be picked to look at them; "Today" (or a new day) brings the calendar back to today.
  const [picked, setPicked] = useState<{ day: string | null; resets: number }>({ day: null, resets: 0 });

  // The month on the calendar, and in which calendar (just after a switch it is still the old one's).
  const [shown, setShown] = useState<(SolarMonth & { calendar: Calendar }) | null>(null);
  const current = shown?.calendar === calendar ? shown : null;
  // Occasions and holidays exist for the Solar Hijri calendar only.
  const solar = calendar === "persian";
  const { events, retry } = useSolarMonthEvents(solar ? current : null);
  const holidays = useMemo(() => {
    if (!current || events.status !== "ready") return undefined;
    return new Set(events.days.filter((day) => day.holiday).map((day) => current.days[day.day - 1]));
  }, [current, events]);

  // Birthdays of everyone who has logged in on this computer, with the server's latest birth dates.
  const people = useBirthdayPeople(true);
  const birthdays = useMemo(
    () => (current ? monthBirthdays(people, current.days, calendar) : new Map<string, string[]>()),
    [people, current, calendar],
  );
  // The user's own reminders of the month.
  const reminderRange = useMemo(
    () =>
      current?.days.length
        ? { fromDay: current.days[0], toDay: nextIsoDay(current.days[current.days.length - 1]) }
        : null,
    [current],
  );
  const reminders = useReminders(reminderRange);
  const marks = useMemo(() => {
    const result = new Map<string, DayMark[]>();
    const add = (iso: string, mark: DayMark) => result.set(iso, [...(result.get(iso) ?? []), mark]);
    // One line per person, and per reminder.
    for (const [iso, names] of birthdays) {
      add(iso, { icon: <PartyHatIcon />, label: names.map((name) => t("calendarEvents.birthday", { name })).join("\n") });
    }
    for (const [iso, list] of reminders) {
      add(iso, { icon: <BellIcon />, label: list.map((reminder) => t("reminders.item", { text: reminder.text })).join("\n") });
    }
    return result;
  }, [birthdays, reminders, t]);

  return {
    calendar,
    today,
    picked,
    setPicked,
    setShown,
    current,
    solar,
    events,
    retry,
    holidays,
    birthdays,
    reminders,
    marks,
  };
}

export type HomeCalendar = ReturnType<typeof useHomeCalendar>;

/**
 * The home page's clock and month calendar, from the correct time
 * (src/lib/network-clock.ts) in the current language and calendar. Holidays and
 * birthdays are marked on the calendar.
 */
export function ClockCard({ home }: { home: HomeCalendar }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const formatDate = useFormatDate();
  const clock = useClock();
  const { calendar, today, picked, setPicked } = home;
  // The day whose reminders are open in the dialog.
  const [reminderDay, setReminderDay] = useState<string | null>(null);
  const reminderDayLabel = useMemo(
    () =>
      reminderDay
        ? new Intl.DateTimeFormat(language.code, { calendar, dateStyle: "full", timeZone: "UTC" }).format(new Date(reminderDay))
        : "",
    [reminderDay, language.code, calendar],
  );

  return (
    <Card className="w-full">
      {/* Dates on the start side, the clock and weekday beside them: a shorter card than stacking them. */}
      <CardHeader className="flex items-start justify-between gap-4">
        <CardDescription className="flex flex-col gap-0.5">
          <span className="text-foreground">{longDate(clock.now, language.code, calendar)}</span>
          {calendar !== "gregory" && <span>{longDate(clock.now, language.code, "gregory")}</span>}
          {/* With Solar Hijri, the Lunar Hijri date too (as in Iranian calendars). */}
          {calendar === "persian" && <span>{longDate(clock.now, language.code, "islamic")}</span>}
          {/* Only when it differs from the system clock: then the user should know which one this is. */}
          {clock.network && isSystemClockWrong(clock) && (
            <span className="mt-1 flex items-center gap-1.5 text-xs">
              <GlobeIcon className="size-3.5" />
              {t("clock.fromNetwork", { source: clock.network.source })}
            </span>
          )}
        </CardDescription>
        <div className="flex shrink-0 flex-col items-end text-end">
          <CardTitle className="text-3xl font-semibold tabular-nums">
            {formatDate(clock.now, { timeStyle: "medium" })}
          </CardTitle>
          <div className="text-lg font-medium">{formatDate(clock.now, { weekday: "long" })}</div>
        </div>
      </CardHeader>
      <CardContent>
        <CalendarPicker
          // A new calendar starts over too: the month shown is numbered in the old one.
          key={`${today}/${picked.resets}/${calendar}`}
          value={picked.day ?? today}
          today={today}
          calendar={calendar}
          holidays={home.holidays}
          marks={home.marks}
          dayAction={{ icon: <BellPlusIcon />, label: t("reminders.add"), onClick: setReminderDay }}
          onMonthChange={(month) => home.setShown({ ...month, calendar })}
          onSelect={(day) =>
            setPicked((current) =>
              day === today ? { day: null, resets: current.resets + 1 } : { day, resets: current.resets },
            )
          }
        />
      </CardContent>
      <ReminderDialog
        day={reminderDay}
        dayLabel={reminderDayLabel}
        onOpenChange={(open) => !open && setReminderDay(null)}
      />
    </Card>
  );
}

/** The occasions, birthdays and reminders of the month on the home page's calendar, in a card of their own. */
export function HomeMonthEvents({ home }: { home: HomeCalendar }) {
  const { language } = useLanguage();
  const { calendar, current, solar, birthdays, reminders } = home;
  if (!current || (!solar && birthdays.size === 0 && reminders.size === 0)) return null;
  return (
    <MonthEvents
      calendar={calendar}
      days={current.days}
      {...monthTitle(current.days[0], language.code, calendar)}
      events={solar ? home.events : null}
      birthdays={birthdays}
      reminders={reminders}
      selected={home.picked.day ?? home.today}
      onRetry={home.retry}
    />
  );
}

/** The month a day ("YYYY-MM-DD") is in and its year, e.g. "Azar" and "1405" (without an era such as "AP"). */
function monthTitle(iso: string, languageCode: string, calendar: Calendar): { month: string; year: string } {
  const date = new Date(iso);
  const month = new Intl.DateTimeFormat(languageCode, { calendar, month: "long", timeZone: "UTC" }).format(date);
  const year =
    new Intl.DateTimeFormat(languageCode, { calendar, year: "numeric", timeZone: "UTC" })
      .formatToParts(date)
      .find((part) => part.type === "year")?.value ?? "";
  return { month, year };
}

/** A day like "7 Azar 1405" in `calendar`, without the era (e.g. "AH") Intl adds to Hijri dates. */
function longDate(time: number, languageCode: string, calendar: Calendar): string {
  return new Intl.DateTimeFormat(languageCode, { calendar, dateStyle: "long" })
    .formatToParts(time)
    .filter((part, index, parts) => part.type !== "era" && parts[index + 1]?.type !== "era")
    .map((part) => part.value)
    .join("")
    .trim();
}

/** Warns, with both times, while the system clock differs from the network time. */
export function SystemClockWarning() {
  const { t } = useTranslation();
  const formatDate = useFormatDate();
  const clock = useClock();
  if (!isSystemClockWrong(clock)) return null;

  const format = (time: number) => formatDate(time, { dateStyle: "medium", timeStyle: "short" });
  return (
    <Alert variant="warning">
      <ClockAlertIcon />
      <AlertTitle>{t("clock.wrong.title")}</AlertTitle>
      <AlertDescription>
        {t("clock.wrong.description", { system: format(clock.systemNow), actual: format(clock.now) })}
      </AlertDescription>
    </Alert>
  );
}
