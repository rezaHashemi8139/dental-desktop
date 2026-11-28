import { useMemo } from "react";
import { BellIcon, LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { Calendar } from "@/i18n/calendar";
import { useLanguage } from "@/i18n/use-language";
import { CALENDAR_EVENTS_SOURCE, type CalendarEvent, type MonthEvents } from "@/lib/calendar-events";
import type { Reminder } from "@/lib/reminders";
import { PartyHatIcon } from "@/components/party-hat-icon";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

type Row =
  | { iso: string; birthday: string; event?: never; reminder?: never }
  | { iso: string; reminder: Reminder; event?: never; birthday?: never }
  | { iso: string; event: CalendarEvent; birthday?: never; reminder?: never };

/**
 * The occasions, birthdays and the user's reminders of the month shown on the home page's calendar,
 * day by day, in a card of their own under it. Occasions (`events`) exist for the Solar Hijri calendar only;
 * pass null for other calendars.
 */
export function MonthEvents({
  calendar,
  days,
  month,
  year,
  events,
  birthdays,
  reminders,
  selected,
  onRetry,
}: {
  /** The calendar the month is in. */
  calendar: Calendar;
  /** The month's days, as Gregorian "YYYY-MM-DD". */
  days: string[];
  /** The month's name and its year, e.g. "Azar" and "1405". */
  month: string;
  year: string;
  events: MonthEvents | null;
  /** Names of the people whose birthday it is, per day (Gregorian "YYYY-MM-DD"). */
  birthdays: ReadonlyMap<string, string[]>;
  /** The user's reminders, per day (Gregorian "YYYY-MM-DD"). */
  reminders: ReadonlyMap<string, Reminder[]>;
  /** The day picked on the calendar: its rows stand out. */
  selected: string | null;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const label = useMemo(
    () => new Intl.DateTimeFormat(language.code, { calendar, day: "numeric", month: "long", timeZone: "UTC" }),
    [language.code, calendar],
  );
  // The source writes the day of an occasion on the Solar Hijri calendar like this; such dates are not repeated.
  const solarDate = useMemo(
    () => new Intl.DateTimeFormat("fa", { calendar: "persian", day: "numeric", month: "long", timeZone: "UTC" }),
    [],
  );

  const rows = useMemo(() => {
    const result: Row[] = [];
    days.forEach((iso, index) => {
      for (const name of birthdays.get(iso) ?? []) result.push({ iso, birthday: name });
      for (const reminder of reminders.get(iso) ?? []) result.push({ iso, reminder });
      if (events?.status !== "ready") return;
      for (const event of events.days.find((day) => day.day === index + 1)?.events ?? []) result.push({ iso, event });
    });
    return result;
  }, [days, birthdays, reminders, events]);

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>{t("calendarEvents.title", { month, year })}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">

      {events?.status === "loading" && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircleIcon className="size-3.5 animate-spin" />
          {t("calendarEvents.loading")}
        </p>
      )}
      {events?.status === "failed" && (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{t("calendarEvents.failed")}</span>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {t("calendarEvents.retry")}
          </Button>
        </div>
      )}
      {rows.length === 0 && events?.status !== "loading" && events?.status !== "failed" && (
        <p className="text-xs text-muted-foreground">{t("calendarEvents.none")}</p>
      )}

      {rows.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-sm">
          {rows.map((row, index) => {
            const date = new Date(row.iso);
            const holiday = row.event?.holiday ?? false;
            const ownDate = row.event && row.event.date !== solarDate.format(date) ? row.event.date : null;
            return (
              <li
                key={`${row.iso}-${index}`}
                className={cn(
                  "flex items-baseline gap-3 rounded-md px-2 py-1",
                  row.iso === selected && "bg-accent",
                  holiday && "text-destructive",
                )}
              >
                <span className="w-16 shrink-0 font-medium tabular-nums">{label.format(date)}</span>
                {row.birthday !== undefined ? (
                  <span className="flex items-center gap-1.5">
                    <PartyHatIcon className="size-3.5 shrink-0 self-center text-primary" />
                    {t("calendarEvents.birthday", { name: row.birthday })}
                  </span>
                ) : row.reminder ? (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <BellIcon className="size-3.5 shrink-0 self-center text-primary" />
                    <span className="min-w-0 wrap-break-word">{row.reminder.text}</span>
                  </span>
                ) : (
                  // Occasions are in Persian, as the source publishes them.
                  <span>
                    <bdi lang="fa">{row.event.title}</bdi>
                    {ownDate && (
                      <span className={cn("ms-1.5 text-xs", !holiday && "text-muted-foreground")}>
                        [<bdi lang="fa">{ownDate}</bdi>]
                      </span>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      </CardContent>
      {events && (
        <CardFooter className="text-[0.7rem] text-muted-foreground">
          {t("calendarEvents.source", { source: CALENDAR_EVENTS_SOURCE })}
        </CardFooter>
      )}
    </Card>
  );
}
