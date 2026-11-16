import type { MouseEvent, ReactNode } from "react";
import { SettingsIcon } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
// Kept up to date by `pnpm build` (scripts/build.mjs), together with tauri.conf.json and Cargo.toml.
import { version } from "../../package.json";
import { CalendarSwitcher } from "@/components/calendar-switcher";
import { CurrencySwitcher } from "@/components/currency-switcher";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

const CREATOR_NAME = "Reza Hashemi";
const CREATOR_URL = "https://www.linkedin.com/in/reza-hashemi-487b2566/";

/** Opens a link in the system browser; a plain target="_blank" would open another app window. */
function openInBrowser(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  const url = event.currentTarget.href;
  // Outside Tauri (plain browser) the plugin is missing: fall back to a new tab.
  openUrl(url).catch(() => window.open(url, "_blank", "noopener,noreferrer"));
}

/** Header gear button and the dialog with every setting except the theme, which stays in the header. */
export function SettingsDialog() {
  const { t } = useTranslation();

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon-sm" aria-label={t("settings.label")} title={t("settings.label")}>
          <SettingsIcon />
        </Button>
      </DialogTrigger>
      {/* No description: the title says it all. */}
      <DialogContent aria-describedby={undefined} className="max-h-[calc(100svh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("settings.title")}</DialogTitle>
        </DialogHeader>

        <SettingsSection title={t("settings.region")}>
          <SettingsRow label={t("language.label")}>
            <LanguageSwitcher />
          </SettingsRow>
          <SettingsRow label={t("calendar.label")}>
            <CalendarSwitcher />
          </SettingsRow>
          <SettingsRow label={t("currency.label")}>
            <CurrencySwitcher />
          </SettingsRow>
        </SettingsSection>

        <section className="flex flex-col gap-1 border-t pt-3 text-xs text-muted-foreground">
          <h3 className="font-medium">{t("settings.about.title")}</h3>
          <p>
            <bdi className="font-medium text-foreground">{t("app.title")}</bdi>{" "}
            {t("settings.about.version", { version })}
          </p>
          <p>{t("settings.about.description")}</p>
          <p>
            {t("settings.about.createdBy")}:{" "}
            <bdi>
              <a
                href={CREATOR_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={openInBrowser}
                className="underline underline-offset-3 hover:text-foreground"
              >
                {CREATOR_NAME}
              </a>
            </bdi>
          </p>
        </section>
      </DialogContent>
    </Dialog>
  );
}

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <div className="divide-y">{children}</div>
    </section>
  );
}

function SettingsRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="truncate">{label}</span>
      {children}
    </div>
  );
}
