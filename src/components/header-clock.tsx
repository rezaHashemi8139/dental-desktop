import { useFormatDate } from "@/i18n/calendar";
import { isSystemClockWrong, useClock } from "@/lib/network-clock";

/**
 * The date and time in the header, in the current language and calendar: the
 * network time when there is internet, otherwise the system clock
 * (src/lib/network-clock.ts). A small amber dot marks a wrong system clock.
 */
export function HeaderClock() {
  const formatDate = useFormatDate();
  const clock = useClock();

  return (
    <span className="inline-flex items-center gap-1.5 px-1.5 py-0.5 text-xs text-muted-foreground tabular-nums">
      {isSystemClockWrong(clock) && <span className="size-1.5 rounded-full bg-amber-500" />}
      <span>{formatDate(clock.now, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</span>
      <span className="font-medium text-foreground">{formatDate(clock.now, { timeStyle: "short" })}</span>
    </span>
  );
}
