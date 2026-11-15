import { useState } from "react";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { CloudIcon, CloudOffIcon, LogOutIcon, ShieldCheckIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { logout } from "@/auth/session";
import { setSession } from "@/auth/store";
import { useLanguage } from "@/i18n/use-language";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

const appRoute = getRouteApi("/app");

export function HomePage() {
  const { t } = useTranslation();
  const { session } = appRoute.useRouteContext();
  const navigate = useNavigate();
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
      // Clear first: the /login guard sends logged-in users back to /home.
      setSession(null);
      navigate({ to: "/login", replace: true });
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
