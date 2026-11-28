import { useMemo, useRef, useState } from "react";
import { CalendarDaysIcon, XIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { calendarParts, fromGregorian, toGregorian, useCalendar, type Calendar } from "@/i18n/calendar";
import { useLanguage } from "@/i18n/use-language";
import { latinKeyDown, latinPaste } from "@/lib/latin-input";
import { CalendarPicker } from "@/components/calendar-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * A day typed in the calendar chosen in Settings (Solar Hijri, Gregorian or Lunar
 * Hijri), kept as a Gregorian "YYYY-MM-DD" (see src/i18n/calendar.ts). The day
 * can be picked from the lists or from a month grid (CalendarPicker).
 *
 * `value` is "" when nothing is entered, and `onChange` gets null while the day
 * is incomplete or does not exist, so a form can tell it apart from an empty one.
 */
export function DateField({
  id,
  label,
  error,
  value,
  onChange,
  clearable,
}: {
  id: string;
  label: string;
  error?: string | null;
  value: string | null;
  onChange: (value: string | null) => void;
  /** Offers a button that empties the field (for optional dates). */
  clearable?: boolean;
}) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { calendar } = useCalendar();
  const [parts, setParts] = useState(() => toText(value, calendar));
  const [picking, setPicking] = useState(false);
  // What this field last reported, to notice a value set from outside (e.g. filled in by the form).
  const reported = useRef(value);
  if (value !== reported.current && value !== null) {
    reported.current = value;
    setParts(toText(value, calendar));
  }

  function update(next: TextParts) {
    setParts(next);
    const empty = !next.year && !next.month && !next.day;
    const iso = empty
      ? ""
      : toGregorian({ year: Number(next.year), month: Number(next.month), day: Number(next.day) }, calendar);
    reported.current = iso;
    onChange(iso);
  }

  // Month names of the year being typed (or this year), in the current language.
  const months = useMemo(() => {
    const year = Number(parts.year) || calendarParts(new Date(), calendar).year;
    const format = new Intl.DateTimeFormat(language.code, { calendar, month: "long", timeZone: "UTC" });
    return Array.from({ length: 12 }, (_, index) => {
      const iso = toGregorian({ year, month: index + 1, day: 1 }, calendar);
      return { value: String(index + 1), label: iso ? format.format(new Date(iso)) : String(index + 1) };
    });
  }, [parts.year, calendar, language.code]);
  const days = Array.from({ length: 31 }, (_, index) => String(index + 1));
  const describedBy = error ? `${id}-error` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${id}-day`} className="mb-1">
        {label}
      </Label>
      <div className="flex gap-2">
        <Select value={parts.day} onValueChange={(day) => update({ ...parts, day })}>
          <SelectTrigger id={`${id}-day`} className="w-20" aria-label={t("dateField.day")} aria-invalid={!!error} aria-describedby={describedBy}>
            <SelectValue placeholder={t("dateField.day")} />
          </SelectTrigger>
          <SelectContent>
            {days.map((day) => (
              <SelectItem key={day} value={day}>
                {Number(day).toLocaleString(language.code)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={parts.month} onValueChange={(month) => update({ ...parts, month })}>
          <SelectTrigger className="min-w-28 flex-1" aria-label={t("dateField.month")} aria-invalid={!!error} aria-describedby={describedBy}>
            <SelectValue placeholder={t("dateField.month")} />
          </SelectTrigger>
          <SelectContent>
            {months.map((month) => (
              <SelectItem key={month.value} value={month.value}>
                {month.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          className="w-20"
          aria-label={t("dateField.year")}
          placeholder={t("dateField.year")}
          aria-invalid={!!error}
          aria-describedby={describedBy}
          inputMode="numeric"
          maxLength={4}
          dir="ltr"
          value={parts.year}
          onKeyDown={latinKeyDown}
          onPaste={latinPaste}
          onChange={(e) => update({ ...parts, year: e.target.value.replace(/[^0-9]/g, "") })}
        />
        <Popover open={picking} onOpenChange={setPicking}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="shrink-0 text-muted-foreground"
              aria-label={t("dateField.openCalendar")}
              title={t("dateField.openCalendar")}
            >
              <CalendarDaysIcon />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-auto p-3">
            <CalendarPicker
              value={value}
              calendar={calendar}
              onSelect={(iso) => {
                update(toText(iso, calendar));
                setPicking(false);
              }}
            />
          </PopoverContent>
        </Popover>
        {clearable && (parts.year || parts.month || parts.day) && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("dateField.clear")}
            onClick={() => update({ year: "", month: "", day: "" })}
          >
            <XIcon />
          </Button>
        )}
      </div>
      {error && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

interface TextParts {
  year: string;
  month: string;
  day: string;
}

function toText(value: string | null, calendar: Calendar): TextParts {
  const parts = value ? fromGregorian(value, calendar) : null;
  return parts
    ? { year: String(parts.year), month: String(parts.month), day: String(parts.day) }
    : { year: "", month: "", day: "" };
}
