import { useState } from "react";
import { ClockAlertIcon, GlobeIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { localIsoDate, useCalendar, useFormatDate } from "@/i18n/calendar";
import { useLanguage } from "@/i18n/use-language";
import { isSystemClockWrong, useClock } from "@/lib/network-clock";
import { CalendarPicker } from "@/components/calendar-picker";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The home page's clock and month calendar, from the correct time
 * (src/lib/network-clock.ts) in the current language and calendar.
 */
export function ClockCard() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { calendar } = useCalendar();
  const formatDate = useFormatDate();
  const clock = useClock();
  const today = localIsoDate(clock.now);
  // Days can be picked to look at them; "Today" (or a new day) brings the calendar back to today.
  const [picked, setPicked] = useState<{ day: string | null; resets: number }>({ day: null, resets: 0 });

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-3xl font-semibold tabular-nums">
          {formatDate(clock.now, { timeStyle: "medium" })}
        </CardTitle>
        <CardDescription className="flex flex-col gap-0.5">
          <span className="text-foreground">{formatDate(clock.now, { dateStyle: "full" })}</span>
          {calendar !== "gregory" && (
            <span>{new Intl.DateTimeFormat(language.code, { calendar: "gregory", dateStyle: "long" }).format(clock.now)}</span>
          )}
          {/* Only when it differs from the system clock: then the user should know which one this is. */}
          {clock.network && isSystemClockWrong(clock) && (
            <span className="mt-1 flex items-center gap-1.5 text-xs">
              <GlobeIcon className="size-3.5" />
              {t("clock.fromNetwork", { source: clock.network.source })}
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <CalendarPicker
          key={`${today}/${picked.resets}`}
          value={picked.day ?? today}
          today={today}
          calendar={calendar}
          onSelect={(day) =>
            setPicked((current) =>
              day === today ? { day: null, resets: current.resets + 1 } : { day, resets: current.resets },
            )
          }
        />
      </CardContent>
    </Card>
  );
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
