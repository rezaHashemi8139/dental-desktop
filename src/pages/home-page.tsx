import { useState } from "react";
import { CloudIcon, CloudOffIcon, LogOutIcon, ShieldCheckIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { logout, type Session } from "@/auth/session";
import { useLanguage } from "@/i18n/use-language";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

export function HomePage({ session, onLoggedOut }: { session: Session; onLoggedOut: () => void }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const [busy, setBusy] = useState(false);

  // Dates follow the selected language (Persian uses the Persian calendar).
  const offlineUntil = new Intl.DateTimeFormat(language.code, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(session.offlineUntil * 1000),
  );
  const roleKey = `roles.${session.role}`;
  const role = (t as unknown as (key: string, options: object) => string)(roleKey, { defaultValue: session.role });

  async function handleLogout() {
    setBusy(true);
    try {
      await logout();
    } finally {
      onLoggedOut();
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>{t("home.welcome", { name: session.fullName || session.username })}</CardTitle>
        <CardDescription dir="ltr" className="text-start">
          {session.username}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{t("home.role")}:</span>
          <Badge variant="secondary">{role}</Badge>
          {session.isAdmin && (
            <Badge variant="outline">
              <ShieldCheckIcon />
              {t("home.admin")}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {session.online ? (
            <Badge>
              <CloudIcon />
              {t("home.online")}
            </Badge>
          ) : (
            <Badge variant="destructive">
              <CloudOffIcon />
              {t("home.offline")}
            </Badge>
          )}
          <span className="text-muted-foreground">{t("home.offlineUntil", { date: offlineUntil })}</span>
        </div>
      </CardContent>
      <CardFooter>
        <Button variant="outline" onClick={handleLogout} disabled={busy}>
          <LogOutIcon data-icon="inline-start" />
          {t("home.logout")}
        </Button>
      </CardFooter>
    </Card>
  );
}
