import { useMemo, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { calendarParts, fromGregorian, localIsoDate, toGregorian, type Calendar } from "@/i18n/calendar";
import { useLanguage } from "@/i18n/use-language";
import { Button } from "@/components/ui/button";

/**
 * A month grid to pick a day from, in `calendar` (Solar Hijri, Gregorian or Lunar
 * Hijri) and the current language. Works with Gregorian "YYYY-MM-DD" days like
 * the rest of src/i18n/calendar.ts. The title switches to a grid of months.
 */
export function CalendarPicker({
  value,
  calendar,
  onSelect,
}: {
  /** The picked day (Gregorian "YYYY-MM-DD"), or "" / null for none. */
  value: string | null;
  calendar: Calendar;
  onSelect: (iso: string) => void;
}) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const today = localIsoDate(Date.now());
  const [shown, setShown] = useState(() => {
    const parts = fromGregorian(value || today, calendar) ?? fromGregorian(today, calendar)!;
    return { year: parts.year, month: parts.month };
  });
  const [view, setView] = useState<"days" | "months">("days");

  const week = useMemo(() => weekInfo(language.code, calendar), [language.code, calendar]);
  const formats = useMemo(
    () => ({
      title: new Intl.DateTimeFormat(language.code, { calendar, month: "long", year: "numeric", timeZone: "UTC" }),
      month: new Intl.DateTimeFormat(language.code, { calendar, month: "long", timeZone: "UTC" }),
      year: new Intl.DateTimeFormat(language.code, { calendar, year: "numeric", timeZone: "UTC" }),
      full: new Intl.DateTimeFormat(language.code, { calendar, dateStyle: "full", timeZone: "UTC" }),
      weekday: new Intl.DateTimeFormat(language.code, { weekday: "narrow", timeZone: "UTC" }),
      weekdayLong: new Intl.DateTimeFormat(language.code, { weekday: "long", timeZone: "UTC" }),
      gregorian: new Intl.DateTimeFormat(language.code, { calendar: "gregory", month: "long", year: "numeric", timeZone: "UTC" }),
      gregorianMonth: new Intl.DateTimeFormat(language.code, { calendar: "gregory", month: "long", timeZone: "UTC" }),
      number: new Intl.NumberFormat(language.code, { useGrouping: false }),
    }),
    [language.code, calendar],
  );

  const days = useMemo(() => monthDays(shown.year, shown.month, calendar), [shown, calendar]);
  const first = days[0] ? new Date(days[0]) : null;
  const last = days.length ? new Date(days[days.length - 1]) : null;
  // Empty cells before the 1st, so it falls under its weekday.
  const lead = first ? (first.getUTCDay() - week.firstDay + 7) % 7 : 0;
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

  if (view === "months") {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-1">
          {navButton(t("dateField.previousYear"), () => move(-12), false)}
          <div className="flex-1 text-center text-sm font-semibold">
            {first ? formats.year.format(first) : formats.number.format(shown.year)}
          </div>
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
          className="flex flex-1 flex-col items-center rounded-md px-2 py-1 transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          title={t("dateField.chooseMonth")}
          onClick={() => setView("months")}
        >
          <span className="text-sm font-semibold">{first ? formats.title.format(first) : ""}</span>
          {/* The same days in the Gregorian calendar, when another one is shown. */}
          {calendar !== "gregory" && first && last && (
            <span className="text-[0.7rem] text-muted-foreground">
              {first.getUTCMonth() === last.getUTCMonth()
                ? formats.gregorian.format(first)
                : `${(first.getUTCFullYear() === last.getUTCFullYear() ? formats.gregorianMonth : formats.gregorian).format(first)} – ${formats.gregorian.format(last)}`}
            </span>
          )}
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
          return (
            <div key={iso} className="flex justify-center">
              <button
                type="button"
                aria-label={formats.full.format(new Date(iso))}
                aria-pressed={selected}
                aria-current={isToday ? "date" : undefined}
                onClick={() => onSelect(iso)}
                className={cn(
                  "relative flex size-9 items-center justify-center rounded-md text-sm tabular-nums transition-colors",
                  "hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                  weekend && "text-destructive/80",
                  isToday && !selected && "font-semibold text-primary ring-1 ring-primary/40",
                  selected && "bg-primary font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 hover:text-primary-foreground",
                )}
              >
                {formats.number.format(index + 1)}
              </button>
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
