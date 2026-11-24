import type { ReactNode } from "react";
import { Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ConnectivityIndicator } from "@/components/connectivity-indicator";
import { SettingsDialog } from "@/components/settings-dialog";
import { ThemeSwitcher } from "@/components/theme-switcher";

/** Header around every page; the pages fill the rest of the window. */
export function RootLayout() {
  const { t } = useTranslation();
  return (
    <div className="flex h-svh flex-col">
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

      {/* Layouts fill it: a centered PageArea, plus the sidebar once logged in. */}
      <main className="flex min-h-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}

/**
 * Scrolls by itself and centers its content while it fits; taller content starts
 * at the top instead of being cut off.
 */
export function PageArea({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 overflow-y-auto p-6">
      <div className="m-auto flex w-full justify-center">{children}</div>
    </div>
  );
}
