import { Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { CalendarSwitcher } from "@/components/calendar-switcher";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ThemeSwitcher } from "@/components/theme-switcher";

/** Header and page area around every page. */
export function RootLayout() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex items-center justify-between gap-4 border-b px-4 py-2">
        <div>
          <h1 className="text-sm font-semibold" dir="ltr">
            {t("app.title")}
          </h1>
          <p className="text-xs text-muted-foreground">{t("app.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <ThemeSwitcher />
          <CalendarSwitcher />
          <LanguageSwitcher />
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center p-6">
        <Outlet />
      </main>
    </div>
  );
}
