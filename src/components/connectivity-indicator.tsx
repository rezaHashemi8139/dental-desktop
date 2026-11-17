import { useTranslation } from "react-i18next";
import { useConnectivity, type ConnectivityState } from "@/auth/connectivity";
import { useFormatDate } from "@/i18n/calendar";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const DOT: Record<ConnectivityState, string> = {
  online: "bg-emerald-500",
  offline: "bg-red-500",
  serverUnavailable: "bg-amber-500",
  checking: "animate-pulse bg-muted-foreground/60",
};

/**
 * A tiny status light in the header: whether the app can work online, as the
 * connectivity watcher sees it (src/auth/connectivity.ts). Details on hover.
 */
export function ConnectivityIndicator() {
  const { t } = useTranslation();
  const formatDate = useFormatDate();
  const { status, checking } = useConnectivity();
  const state: ConnectivityState = checking ? "checking" : status.state;
  const label = t(`connectivity.${state}`);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          tabIndex={0}
          aria-label={label}
          className="inline-flex size-5 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className={cn("size-2 rounded-full transition-colors", DOT[state])} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end">
        <p className="font-medium">{label}</p>
        <p className="opacity-80">{t(`connectivity.details.${state}`)}</p>
        {status.checkedAt > 0 && (
          <p className="opacity-60">
            {t("connectivity.checkedAt", { time: formatDate(status.checkedAt * 1000, { timeStyle: "medium" }) })}
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
