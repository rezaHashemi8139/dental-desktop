import { useMemo, type ReactNode } from "react";
import { BellIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { localIsoDate, useCalendar } from "@/i18n/calendar";
import { useSession } from "@/auth/store";
import { dayBirthdays, useBirthdayPeople } from "@/lib/birthdays";
import { useClock } from "@/lib/network-clock";
import { nextIsoDay, useReminders } from "@/lib/reminders";
import { PartyHatIcon } from "@/components/party-hat-icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Small icons in the header while someone is logged in: a bell when the user has
 * reminders today and a party hat when it is someone's birthday, each listing
 * them in a tooltip. Nothing when there are neither.
 */
export function TodayIndicators() {
  const { t } = useTranslation();
  const session = useSession();
  const { calendar } = useCalendar();
  const clock = useClock();
  const today = localIsoDate(clock.now);
  const usable = !!session && !session.locked && !session.billing;

  const range = useMemo(() => (usable ? { fromDay: today, toDay: nextIsoDay(today) } : null), [usable, today]);
  const reminders = useReminders(range).get(today) ?? [];
  const people = useBirthdayPeople();
  const birthdays = useMemo(
    () => (usable ? dayBirthdays(people, today, calendar) : []),
    [usable, people, today, calendar],
  );

  if (!usable) return null;
  return (
    <>
      {reminders.length > 0 && (
        <Indicator
          icon={<BellIcon />}
          title={t("reminders.today")}
          lines={reminders.map((reminder) => reminder.text)}
        />
      )}
      {birthdays.length > 0 && (
        <Indicator
          icon={<PartyHatIcon />}
          title={t("reminders.birthdaysToday")}
          lines={birthdays.map((name) => t("calendarEvents.birthday", { name }))}
        />
      )}
    </>
  );
}

function Indicator({ icon, title, lines }: { icon: ReactNode; title: string; lines: string[] }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          tabIndex={0}
          aria-label={[title, ...lines].join(" – ")}
          className="inline-flex size-6 items-center justify-center rounded-md text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4"
        >
          {icon}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end">
        <p className="font-medium">{title}</p>
        <ul className="mt-0.5 flex flex-col gap-0.5 opacity-90">
          {lines.map((line, index) => (
            <li key={index} className="wrap-break-word whitespace-pre-line">
              {line}
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
