import { useState } from "react";
import { DownloadIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useConnectivity } from "@/auth/connectivity";
import { checkForUpdate, installUpdate, useUpdate } from "@/lib/update";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Shown instead of every page while this version may not be used any more (a
 * forced update, see src/lib/update.ts): the only thing left to do is updating.
 */
export function UpdateRequiredScreen() {
  const { t } = useTranslation();
  const { status, progress } = useUpdate();
  const { status: connectivity } = useConnectivity();
  const [error, setError] = useState<RustMessage | null>(null);
  const [checking, setChecking] = useState(false);
  const online = connectivity.state === "online";
  const shownError = error ?? status.error;

  async function install() {
    setError(null);
    try {
      await installUpdate();
    } catch (e) {
      setError(toRustMessage(e));
    }
  }

  async function check() {
    setError(null);
    setChecking(true);
    try {
      await checkForUpdate();
    } catch (e) {
      setError(toRustMessage(e));
    } finally {
      setChecking(false);
    }
  }

  const percent = progress?.total ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : null;

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>{t("update.required.title")}</CardTitle>
        <CardDescription>
          {status.minimumVersion
            ? t("update.required.description", { current: status.currentVersion, minimum: status.minimumVersion })
            : t("update.required.descriptionNoVersion", { current: status.currentVersion })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {shownError && (
          <Alert variant="destructive">
            <AlertDescription>{translateMessage(shownError)}</AlertDescription>
          </Alert>
        )}
        {!online && <p className="text-muted-foreground">{t("update.required.offline")}</p>}
        {online && !status.available && !checking && <p className="text-muted-foreground">{t("update.required.notFound")}</p>}
        {status.available && <p>{t("update.available", { version: status.available.version })}</p>}
        {status.installing && (
          <p className="text-muted-foreground">
            {percent === null ? t("update.downloading") : t("update.downloadingPercent", { percent })}
          </p>
        )}
        <p className="text-muted-foreground">{t("update.required.dataSafe")}</p>
      </CardContent>
      <CardFooter className="flex gap-2">
        {status.available ? (
          <Button onClick={install} disabled={status.installing}>
            {status.installing ? <LoaderCircleIcon className="animate-spin" /> : <DownloadIcon data-icon="inline-start" />}
            {status.installing ? t("update.installing") : t("update.install")}
          </Button>
        ) : (
          <Button variant="outline" onClick={check} disabled={checking || !online}>
            {checking ? <LoaderCircleIcon className="animate-spin" /> : <RefreshCwIcon data-icon="inline-start" />}
            {t("update.checkAgain")}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
