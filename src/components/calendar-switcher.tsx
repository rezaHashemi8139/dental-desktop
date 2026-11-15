import { CalendarDaysIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CALENDAR_CHOICES, useCalendar, type CalendarChoice } from "@/i18n/calendar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Picks the calendar dates are shown in; "auto" follows the language. */
export function CalendarSwitcher() {
  const { t } = useTranslation();
  const { choice, calendar, languageCalendar, setChoice } = useCalendar();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label={t("calendar.label")} title={t("calendar.label")}>
          <CalendarDaysIcon data-icon="inline-start" />
          {t(`calendar.${calendar}`)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t("calendar.label")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={choice} onValueChange={(value) => setChoice(value as CalendarChoice)}>
          {CALENDAR_CHOICES.map((item) => (
            <DropdownMenuRadioItem key={item} value={item}>
              {item === "auto" ? (
                <>
                  {t("calendar.auto")}
                  <span className="ms-4 text-xs text-muted-foreground">{t(`calendar.${languageCalendar}`)}</span>
                </>
              ) : (
                t(`calendar.${item}`)
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
