import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { calendarParts, fromGregorian, localIsoDate, toGregorian, type Calendar } from "@/i18n/calendar";
import { useLanguage } from "@/i18n/use-language";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Years on one page of the "years" view. */
const YEARS_PER_PAGE = 20;

/** A small icon on a day of the calendar, with a tooltip. */
export interface DayMark {
  icon: ReactNode;
  label: string;
}

/** A small button shown on a day while it is hovered or focused, e.g. to add a reminder to it. */
export interface DayAction {
  icon: ReactNode;
  label: string;
  onClick: (iso: string) => void;
}

/**
 * A month grid to pick a day from, in `calendar` (Solar Hijri, Gregorian or Lunar
 * Hijri) and the current language. Works with Gregorian "YYYY-MM-DD" days like
 * the rest of src/i18n/calendar.ts. The title switches to a grid of months, whose
 * year switches to a grid of years.
 * Days can be shown as holidays and carry marks with a tooltip (the home page's
 * birthdays and reminders), and offer an action while hovered (adding a reminder).
 */
export function CalendarPicker({
  value,
  calendar,
  onSelect,
  today = localIsoDate(Date.now()),
  holidays,
  marks,
  dayAction,
  onMonthChange,
}: {
  /** The picked day (Gregorian "YYYY-MM-DD"), or "" / null for none. */
  value: string | null;
  calendar: Calendar;
  onSelect: (iso: string) => void;
  /** Today (Gregorian "YYYY-MM-DD"); the system clock's day by default. */
  today?: string;
  /** Days (Gregorian "YYYY-MM-DD") shown as holidays, like the weekend. */
  holidays?: ReadonlySet<string>;
  /** Small icons in the corner of these days (Gregorian "YYYY-MM-DD"), with their labels as a tooltip (may have several lines). */
  marks?: ReadonlyMap<string, readonly DayMark[]>;
  /** A small button on the other corner of the day under the pointer (or focused). */
  dayAction?: DayAction;
  /** Called with the month shown (numbered in `calendar`) and its days, at first and whenever it changes. */
  onMonthChange?: (month: { year: number; month: number; days: string[] }) => void;
}) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const [shown, setShown] = useState(() => {
    const parts = fromGregorian(value || today, calendar) ?? fromGregorian(today, calendar)!;
    return { year: parts.year, month: parts.month };
  });
  const [view, setView] = useState<"days" | "months" | "years">("days");
  // The first year of the page of years shown in the "years" view.
  const [yearPage, setYearPage] = useState(0);

  const week = useMemo(() => weekInfo(language.code, calendar), [language.code, calendar]);
  const formats = useMemo(
    () => ({
      title: new Intl.DateTimeFormat(language.code, { calendar, month: "long", year: "numeric", timeZone: "UTC" }),
      month: new Intl.DateTimeFormat(language.code, { calendar, month: "long", timeZone: "UTC" }),
      year: new Intl.DateTimeFormat(language.code, { calendar, year: "numeric", timeZone: "UTC" }),
      full: new Intl.DateTimeFormat(language.code, { calendar, dateStyle: "full", timeZone: "UTC" }),
      weekday: new Intl.DateTimeFormat(language.code, { weekday: "narrow", timeZone: "UTC" }),
      weekdayLong: new Intl.DateTimeFormat(language.code, { weekday: "long", timeZone: "UTC" }),
      number: new Intl.NumberFormat(language.code, { useGrouping: false }),
    }),
    [language.code, calendar],
  );

  const days = useMemo(() => monthDays(shown.year, shown.month, calendar), [shown, calendar]);
  const first = days[0] ? new Date(days[0]) : null;
  // Empty cells before the 1st, so it falls under its weekday.
  const lead = first ? (first.getUTCDay() - week.firstDay + 7) % 7 : 0;

  useEffect(() => {
    onMonthChange?.({ year: shown.year, month: shown.month, days });
    // Only a new month is news: the callback may be a new function on every render.
  }, [days]);
  const weekdays = Array.from({ length: 7 }, (_, i) => (week.firstDay + i) % 7);

  function move(months: number) {
    const index = shown.year * 12 + (shown.month - 1) + months;
    setShown({ year: Math.floor(index / 12), month: (index % 12) + 1 });
  }

  const navButton = (label: string, onClick: () => void, next: boolean) => (
    <Button type="button" variant="ghost" size="icon-sm" aria-label={label} title={label} onClick={onClick}>
      {next ? <ChevronRightIcon className="rtl:rotate-180" /> : <ChevronLeftIcon className="rtl:rotate-180" />}
    </Button>
  );

  if (view === "years") {
    const years = Array.from({ length: YEARS_PER_PAGE }, (_, i) => yearPage + i);
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-1">
          {navButton(t("dateField.previousYears"), () => setYearPage(yearPage - YEARS_PER_PAGE), false)}
          <div className="flex-1 text-center text-sm font-semibold tabular-nums">
            {formats.number.format(years[0])} – {formats.number.format(years[years.length - 1])}
          </div>
          {navButton(t("dateField.nextYears"), () => setYearPage(yearPage + YEARS_PER_PAGE), true)}
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {years.map((year) => {
            const current = year === shown.year;
            return (
              <Button
                key={year}
                type="button"
                variant={current ? "default" : "ghost"}
                size="sm"
                className={cn("h-9 font-normal tabular-nums", current && "font-medium")}
                onClick={() => {
                  setShown({ year, month: shown.month });
                  setView("months");
                }}
              >
                {formats.number.format(year)}
              </Button>
            );
          })}
        </div>
      </div>
    );
  }

  if (view === "months") {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-1">
          {navButton(t("dateField.previousYear"), () => move(-12), false)}
          {/* Far-off years (e.g. a birth year) are picked from a list, not by stepping. */}
          <button
            type="button"
            className="flex-1 rounded-md px-2 py-1 text-center text-sm font-semibold transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            title={t("dateField.chooseYear")}
            onClick={() => {
              // The page that has the year shown, about in its middle.
              setYearPage(shown.year - Math.floor(YEARS_PER_PAGE / 2) + 1);
              setView("years");
            }}
          >
            {first ? formats.year.format(first) : formats.number.format(shown.year)}
          </button>
          {navButton(t("dateField.nextYear"), () => move(12), true)}
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {Array.from({ length: 12 }, (_, i) => i + 1).map((month) => {
            const iso = toGregorian({ year: shown.year, month, day: 1 }, calendar);
            const current = month === shown.month;
            return (
              <Button
                key={month}
                type="button"
                variant={current ? "default" : "ghost"}
                size="sm"
                className={cn("h-9 font-normal", current && "font-medium")}
                onClick={() => {
                  setShown({ year: shown.year, month });
                  setView("days");
                }}
              >
                {iso ? formats.month.format(new Date(iso)) : formats.number.format(month)}
              </Button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1">
        {navButton(t("dateField.previousMonth"), () => move(-1), false)}
        <button
          type="button"
          className="flex-1 rounded-md px-2 py-1 text-center text-sm font-semibold transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          title={t("dateField.chooseMonth")}
          onClick={() => setView("months")}
        >
          {first ? formats.title.format(first) : ""}
        </button>
        {navButton(t("dateField.nextMonth"), () => move(1), true)}
      </div>

      <div className="grid grid-cols-7 gap-y-1 text-center" role="grid">
        {weekdays.map((weekday) => {
          // 2024-01-07 was a Sunday (weekday 0).
          const sample = Date.UTC(2024, 0, 7 + weekday);
          return (
            <abbr
              key={weekday}
              title={formats.weekdayLong.format(sample)}
              className={cn(
                "pb-1 text-xs font-medium text-muted-foreground no-underline",
                week.weekend.includes(weekday) && "text-destructive/70",
              )}
            >
              {formats.weekday.format(sample)}
            </abbr>
          );
        })}
        {Array.from({ length: lead }, (_, i) => (
          <span key={`lead-${i}`} />
        ))}
        {days.map((iso, index) => {
          const selected = iso === value;
          const isToday = iso === today;
          const weekend = week.weekend.includes(new Date(iso).getUTCDay());
          const holiday = holidays?.has(iso) ?? false;
          const dayMarks = marks?.get(iso) ?? [];
          const markLabel = dayMarks.map((mark) => mark.label).join("\n");
          const label = [formats.full.format(new Date(iso)), holiday && t("calendarEvents.holiday"), markLabel]
            .filter(Boolean)
            .join(" – ");
          const button = (
            <button
              type="button"
              aria-label={label}
              aria-pressed={selected}
              aria-current={isToday ? "date" : undefined}
              onClick={() => onSelect(iso)}
              className={cn(
                "relative flex size-9 items-center justify-center rounded-md text-sm tabular-nums transition-colors",
                "hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                (weekend || holiday) && "text-destructive/80",
                holiday && "font-medium text-destructive",
                isToday && !selected && "font-semibold text-primary ring-1 ring-primary/40",
                selected && "bg-primary font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 hover:text-primary-foreground",
              )}
            >
              {formats.number.format(index + 1)}
              {dayMarks.length > 0 && (
                <span
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute -inset-e-0.5 -top-0.5 flex text-primary",
                    dayMarks.length > 1 ? "[&_svg]:size-3" : "[&_svg]:size-3.5",
                  )}
                >
                  {dayMarks.map((mark, i) => (
                    <span key={i}>{mark.icon}</span>
                  ))}
                </span>
              )}
            </button>
          );
          return (
            <div key={iso} className="flex justify-center">
              <div className="group relative">
                {dayMarks.length > 0 ? (
                  <Tooltip>
                    <TooltipTrigger asChild>{button}</TooltipTrigger>
                    <TooltipContent className="whitespace-pre-line">{markLabel}</TooltipContent>
                  </Tooltip>
                ) : (
                  button
                )}
                {dayAction && (
                  // Beside the day's button, not in it: a button cannot hold another.
                  <button
                    type="button"
                    aria-label={dayAction.label}
                    title={dayAction.label}
                    onClick={() => dayAction.onClick(iso)}
                    className={cn(
                      "absolute -inset-s-1 -top-1 flex size-4 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-xs transition-opacity [&_svg]:size-2.5",
                      "hover:bg-primary hover:text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                      "pointer-events-none opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100",
                    )}
                  >
                    {dayAction.icon}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between border-t pt-3">
        <span className="text-xs text-muted-foreground">{formats.full.format(new Date(today))}</span>
        <Button type="button" variant="outline" size="sm" onClick={() => onSelect(today)}>
          {t("dateField.today")}
        </Button>
      </div>
    </div>
  );
}

/** The Gregorian days ("YYYY-MM-DD") of month `month` of `year` in `calendar`, in order. */
function monthDays(year: number, month: number, calendar: Calendar): string[] {
  const start = toGregorian({ year, month, day: 1 }, calendar);
  if (!start) return [];
  const days: string[] = [];
  for (let time = Date.parse(start); days.length < 31; time += 86_400_000) {
    if (calendarParts(new Date(time), calendar).month !== month) break;
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Where the week starts and which days are the weekend, as Date.getUTCDay()
 * numbers (0 is Sunday). The Hijri calendars follow Iran's week (Saturday to
 * Friday); the Gregorian one follows the language's region, when the browser knows it.
 */
function weekInfo(languageCode: string, calendar: Calendar): { firstDay: number; weekend: number[] } {
  if (calendar !== "gregory") return { firstDay: 6, weekend: [5] };
  try {
    const locale = new Intl.Locale(languageCode) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number; weekend: number[] };
      weekInfo?: { firstDay: number; weekend: number[] };
    };
    const info = locale.getWeekInfo?.() ?? locale.weekInfo;
    // Intl counts 1 (Monday) to 7 (Sunday).
    if (info) return { firstDay: info.firstDay % 7, weekend: info.weekend.map((day) => day % 7) };
  } catch {
    // Unknown language code: the default below.
  }
  return { firstDay: 1, weekend: [6, 0] };
}
