import { useEffect } from "react";
import { CloudCheckIcon, CloudOffIcon, CloudUploadIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSession } from "@/auth/store";
import { useFormatDate } from "@/i18n/calendar";
import { translateMessage } from "@/i18n/message";
import { refreshSyncStatus, syncNow, useSyncStatus } from "@/lib/sync";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Header button showing whether the clinic's records are on the server: how many
 * changes wait to be sent, and any the server refused. Clicking syncs now.
 * Only while logged in.
 */
export function SyncIndicator() {
  const { t } = useTranslation();
  const formatDate = useFormatDate();
  const session = useSession();
  const status = useSyncStatus();

  // A new session has its own database and counts.
  useEffect(() => {
    if (session) refreshSyncStatus().catch((e) => console.warn("Could not read the sync status:", e));
  }, [session]);

  if (!session) return null;

  const Icon =
    status.state === "syncing"
      ? RefreshCwIcon
      : status.state === "error" || status.rejected > 0
        ? TriangleAlertIcon
        : status.state === "offline"
          ? CloudOffIcon
          : status.pending > 0
            ? CloudUploadIcon
            : CloudCheckIcon;
  const label = t(`sync.state.${status.state}`);
  // Not `disabled`: a disabled button shows no tooltip, and the tooltip explains why.
  const canSync = status.state !== "syncing" && status.state !== "offline";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={label}
          onClick={() => {
            if (canSync) syncNow().catch((e) => console.warn("Could not start syncing:", e));
          }}
        >
          <Icon className={status.state === "syncing" ? "animate-spin" : undefined} />
          {status.pending > 0 && <span className="tabular-nums">{status.pending}</span>}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end">
        <p className="font-medium">{label}</p>
        <p className="opacity-80">
          {status.pending > 0 ? t("sync.pending", { count: status.pending }) : t("sync.upToDate")}
        </p>
        {status.rejected > 0 && <p className="opacity-80">{t("sync.rejected", { count: status.rejected })}</p>}
        {status.error && <p className="opacity-80">{translateMessage(status.error)}</p>}
        {status.lastSyncedAt > 0 && (
          <p className="opacity-60">
            {t("sync.lastSyncedAt", { time: formatDate(status.lastSyncedAt * 1000, { timeStyle: "short" }) })}
          </p>
        )}
        <p className="opacity-60">{t("sync.financialLocal")}</p>
      </TooltipContent>
    </Tooltip>
  );
}
