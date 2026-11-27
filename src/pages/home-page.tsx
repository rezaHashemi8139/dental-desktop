import { getRouteApi } from "@tanstack/react-router";
import { CloudIcon, CloudOffIcon, GiftIcon, LoaderCircleIcon, LogOutIcon, ShieldCheckIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSession } from "@/auth/store";
import { useLogout } from "@/auth/use-logout";
import { useFormatDate } from "@/i18n/calendar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

const homeRoute = getRouteApi("/app/home");

export function HomePage() {
  const { t } = useTranslation();
  // Live: an offline session that reconnects shows as online right away.
  const session = useSession();
  // Right after a first clinic started a free trial (src/pages/auth-layout.tsx).
  const { trialPlan, trialEndsAt } = homeRoute.useSearch();
  const formatDate = useFormatDate();
  const { logOut, busy } = useLogout();
  // The app layout leaves for /login when there is no session.
  if (!session) return null;

  // In the language and calendar chosen in Settings.
  const offlineUntil = formatDate(session.offlineUntil * 1000, { dateStyle: "medium", timeStyle: "short" });
  const roleKey = `roles.${session.role}`;
  const role = (t as unknown as (key: string, options: object) => string)(roleKey, { defaultValue: session.role });

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>{t("home.welcome", { name: session.fullName || session.username })}</CardTitle>
        <CardDescription dir="ltr" className="text-start">
          {session.username}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {trialPlan && trialEndsAt && (
          <Alert variant="info">
            <GiftIcon />
            <AlertTitle>{t("home.trial.title")}</AlertTitle>
            <AlertDescription>
              {t("home.trial.description", { plan: trialPlan, date: formatDate(trialEndsAt * 1000) })}
            </AlertDescription>
          </Alert>
        )}
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
        <Button variant="outline" onClick={logOut} disabled={busy}>
          {busy ? <LoaderCircleIcon className="animate-spin" /> : <LogOutIcon data-icon="inline-start" />}
          {t("home.logout")}
        </Button>
      </CardFooter>
    </Card>
  );
}
