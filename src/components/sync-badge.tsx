import { CloudUploadIcon, TriangleAlertIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SyncState } from "@/lib/patients";
import { Badge } from "@/components/ui/badge";

/**
 * Whether a record has reached the server: nothing once it has, "waiting" while
 * it has not, and "refused" when the server would not take it (it waits for a fix).
 */
export function SyncBadge({ state }: { state: SyncState }) {
  const { t } = useTranslation();
  if (state === "synced") return null;
  if (state === "rejected") {
    return (
      <Badge variant="destructive" title={t("patients.sync.rejectedHint")}>
        <TriangleAlertIcon data-icon="inline-start" />
        {t("patients.sync.rejected")}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" title={t("patients.sync.waitingHint")}>
      <CloudUploadIcon data-icon="inline-start" />
      {t("patients.sync.waiting")}
    </Badge>
  );
}
