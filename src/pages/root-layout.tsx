import { Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ConnectivityIndicator } from "@/components/connectivity-indicator";
import { SettingsDialog } from "@/components/settings-dialog";
import { ThemeSwitcher } from "@/components/theme-switcher";

/** Header and page area around every page. */
export function RootLayout() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex items-center justify-between gap-4 border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <img src="/logo.svg" alt="" className="size-6" />
          <h1 className="text-sm font-semibold">{t("app.title")}</h1>
        </div>
        <div className="flex items-center gap-2">
          <ConnectivityIndicator />
          <ThemeSwitcher />
          <SettingsDialog />
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center p-6">
        <Outlet />
      </main>
    </div>
  );
}
