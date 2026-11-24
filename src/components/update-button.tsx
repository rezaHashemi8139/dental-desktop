import { useState } from "react";
import { CircleArrowUpIcon, DownloadIcon, LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { installUpdate, useUpdate } from "@/lib/update";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * Header button shown while a new version is available and not forced (a forced
 * one takes over the whole window, see UpdateRequiredScreen). Opens a dialog with
 * the release notes and the install button.
 */
export function UpdateButton() {
  const { t } = useTranslation();
  const { status, progress } = useUpdate();
  const [error, setError] = useState<RustMessage | null>(null);
  const available = status.available;
  if (!available || status.required) return null;

  async function install() {
    setError(null);
    try {
      await installUpdate();
    } catch (e) {
      setError(toRustMessage(e));
    }
  }

  const percent = progress?.total ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : null;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <CircleArrowUpIcon data-icon="inline-start" />
          {t("update.button")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("update.available", { version: available.version })}</DialogTitle>
          <DialogDescription>{t("update.description", { current: status.currentVersion })}</DialogDescription>
        </DialogHeader>
        {available.notes && <p className="whitespace-pre-line text-sm">{available.notes}</p>}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{translateMessage(error)}</AlertDescription>
          </Alert>
        )}
        {status.installing && (
          <p className="text-sm text-muted-foreground">
            {percent === null ? t("update.downloading") : t("update.downloadingPercent", { percent })}
          </p>
        )}
        <DialogFooter>
          <Button onClick={install} disabled={status.installing}>
            {status.installing ? <LoaderCircleIcon className="animate-spin" /> : <DownloadIcon data-icon="inline-start" />}
            {status.installing ? t("update.installing") : t("update.install")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
