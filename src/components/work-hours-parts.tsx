import { useCallback, useEffect, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSession } from "@/auth/store";
import { useFormatDate } from "@/i18n/calendar";
import { toRustMessage, type RustMessage } from "@/i18n/message";
import { useLanguage } from "@/i18n/use-language";
import { listLocalUsers, type LocalUser } from "@/lib/patients";
import { cn } from "@/lib/utils";
import { hoursAndMinutes, localMidnight, type CalendarMonth, type WorkHours } from "@/lib/work-hours";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * Pieces shared by the working hours pages (src/pages/work-hours-page.tsx, where
 * hours are recorded, and src/pages/work-hours-report-page.tsx, where they are
 * listed month by month).
 */

/** How numbers, spans and times of working hours are shown in the language in use. */
export function useWorkHoursFormat() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const formatDate = useFormatDate();
  const number = (value: number) => value.toLocaleString(language.code);
  const duration = (millis: number) => {
    const { hours, minutes } = hoursAndMinutes(millis);
    return t("workHours.duration", { hours: number(hours), minutes: number(minutes) });
  };
  const time = (at: number) => formatDate(at, { timeStyle: "short" });
  const range = (entry: WorkHours) => `${time(entry.startedAt)} – ${entry.endedAt ? time(entry.endedAt) : "…"}`;
  /** A Gregorian "YYYY-MM-DD" as a full date, e.g. for a dialog title. */
  const longDay = (day: string) =>
    formatDate(localMidnight(day), { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return { number, duration, time, range, longDay, formatDate };
}

/** This computer's users, and the name to show for one of them. */
export function useWorkHoursUsers(onError: (error: RustMessage) => void) {
  const session = useSession();
  const [users, setUsers] = useState<LocalUser[]>([]);
  const reload = useCallback(() => {
    listLocalUsers().then(setUsers, (e) => onError(toRustMessage(e)));
  }, [onError]);
  useEffect(reload, [reload]);
  const userName = (id: string) => {
    const user = users.find((u) => u.id === id);
    return user ? user.fullName || user.username : id === session?.userId ? session.fullName : "";
  };
  return { users, userName, reload };
}

/** The value of `UserSelect` that stands for everyone. */
export const ALL_USERS = "all";

/** Picks one of `users`, or everyone (`ALL_USERS`) when `allLabel` is given. */
export function UserSelect({
  users,
  value,
  onChange,
  allLabel,
  className,
}: {
  users: LocalUser[];
  value: string;
  onChange: (value: string) => void;
  allLabel?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const session = useSession();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={cn("w-full max-w-64 bg-background", className)} aria-label={t("workHours.user")}>
        <SelectValue placeholder={t("workHours.user")} />
      </SelectTrigger>
      <SelectContent>
        {allLabel && <SelectItem value={ALL_USERS}>{allLabel}</SelectItem>}
        {users.map((user) => (
          <SelectItem key={user.id} value={user.id}>
            {user.fullName || user.username}
            {user.id === session?.userId && ` ${t("workHours.me")}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The month shown, with buttons for the one before and after (not past the current one). */
export function MonthNav({ month, onChange }: { month: CalendarMonth; onChange: (anchor: number) => void }) {
  const { t } = useTranslation();
  const formatDate = useFormatDate();
  return (
    <div className="flex items-center">
      <Button variant="ghost" size="icon-sm" aria-label={t("workHours.previousMonth")} onClick={() => onChange(month.start - 1)}>
        <ChevronRightIcon className="ltr:rotate-180" />
      </Button>
      <span className="min-w-28 text-center text-sm font-medium">{formatDate(month.start, { year: "numeric", month: "long" })}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("workHours.nextMonth")}
        disabled={month.end > Date.now()}
        onClick={() => onChange(month.end)}
      >
        <ChevronLeftIcon className="ltr:rotate-180" />
      </Button>
    </div>
  );
}

/** A day as a narrow column: short weekday over the day of the month. */
export function DayBadge({ day }: { day: string }) {
  const formatDate = useFormatDate();
  const at = localMidnight(day);
  return (
    <div className="flex w-10 shrink-0 flex-col items-center">
      <span className="text-xs text-muted-foreground">{formatDate(at, { weekday: "short" })}</span>
      <span className="text-lg leading-tight font-semibold tabular-nums">{formatDate(at, { day: "numeric" })}</span>
    </div>
  );
}

/** The look of one entry–exit; an entry still without an exit is green. */
export function entryChipClass(entry: WorkHours): string {
  return cn(
    "inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs tabular-nums",
    !entry.endedAt && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  );
}

/** What goes inside an entry chip: its range, with a dot while still open. */
export function EntryChipContent({ entry, range }: { entry: WorkHours; range: string }) {
  return (
    <>
      {!entry.endedAt && <span className="size-1.5 rounded-full bg-emerald-500" />}
      <span dir="ltr">{range}</span>
    </>
  );
}

export function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("text-sm font-medium tabular-nums", strong && "text-base font-semibold")}>{value}</dd>
    </div>
  );
}

export function StatusDot({ active }: { active: boolean }) {
  return (
    <span className="relative flex size-3 shrink-0">
      {active && <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/60" />}
      <span className={cn("relative inline-flex size-3 rounded-full", active ? "bg-emerald-500" : "bg-muted-foreground/40")} />
    </span>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
      <LoaderCircleIcon className="size-4 animate-spin" />
      {label}
    </p>
  );
}

/** The first letter of a name, for its avatar. */
export function initial(name: string): string {
  return [...name.trim()][0]?.toUpperCase() ?? "?";
}
