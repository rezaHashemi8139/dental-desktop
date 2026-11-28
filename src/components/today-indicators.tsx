import { useMemo, type ReactNode } from "react";
import { BellIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSession } from "@/auth/store";
import { useTodayBirthdays } from "@/lib/birthdays";
import { nextIsoDay, useReminders } from "@/lib/reminders";
import { ColorfulPartyHat, PartyHatIcon } from "@/components/party-hat-icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Small icons in the header while someone is logged in: a bell when the user has
 * reminders today and a party hat when it is someone's birthday, each listing
 * them in a tooltip; on the user's own birthday, a "Happy birthday" too.
 * Nothing when there are none.
 */
export function TodayIndicators() {
  const { t } = useTranslation();
  const session = useSession();
  const usable = !!session && !session.locked && !session.billing;
  const birthdays = useTodayBirthdays();
  const { today } = birthdays;

  const range = useMemo(() => (usable ? { fromDay: today, toDay: nextIsoDay(today) } : null), [usable, today]);
  const reminders = useReminders(range).get(today) ?? [];

  if (!usable) return null;
  return (
    <>
      {birthdays.mine && (
        <span className="inline-flex items-center gap-1 text-xs font-semibold">
          <ColorfulPartyHat className="size-4" />
          <span className="bg-linear-to-r from-pink-500 via-amber-500 to-sky-500 bg-clip-text text-transparent">
            {t("calendarEvents.happyBirthday")}
          </span>
        </span>
      )}
      {reminders.length > 0 && (
        <Indicator
          icon={<BellIcon />}
          title={t("reminders.today")}
          lines={reminders.map((reminder) => reminder.text)}
        />
      )}
      {birthdays.people.length > 0 && (
        <Indicator
          icon={<PartyHatIcon />}
          title={t("reminders.birthdaysToday")}
          lines={birthdays.people.map((person) => t("calendarEvents.birthday", { name: person.name }))}
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
