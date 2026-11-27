import { useEffect, useState } from "react";
import { Building2Icon, LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useFormatDate } from "@/i18n/calendar";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { patientHistory, type PatientHistory } from "@/lib/patients";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * A patient's treatments in every clinic, read from the server each time it opens
 * (never stored here). The server records who looked. Needs an online session.
 */
export function PatientHistoryDialog({
  open,
  onOpenChange,
  identity,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  identity: string;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("patients.history.title")}</DialogTitle>
          <DialogDescription>{t("patients.history.description")}</DialogDescription>
        </DialogHeader>
        {open && <HistoryList identity={identity} />}
      </DialogContent>
    </Dialog>
  );
}

function HistoryList({ identity }: { identity: string }) {
  const { t } = useTranslation();
  const formatDate = useFormatDate();
  const [history, setHistory] = useState<PatientHistory | null>(null);
  const [error, setError] = useState<RustMessage | null>(null);

  useEffect(() => {
    let current = true;
    patientHistory({ identity }).then(
      (result) => current && setHistory(result),
      (e) => current && setError(toRustMessage(e)),
    );
    return () => {
      current = false;
    };
  }, [identity]);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{translateMessage(error)}</AlertDescription>
      </Alert>
    );
  }
  if (!history) {
    return (
      <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-4 animate-spin" />
        {t("patients.history.loading")}
      </p>
    );
  }
  if (history.treatments.length === 0) {
    return <p className="py-2 text-sm text-muted-foreground">{t("patients.history.empty")}</p>;
  }
  return (
    <ul className="flex flex-col divide-y rounded-lg border">
      {history.treatments.map((entry, index) => (
        <li key={index} className="flex flex-col gap-1 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{entry.procedure}</span>
            {entry.tooth && <Badge variant="secondary">{t("treatments.toothLabel", { tooth: entry.tooth })}</Badge>}
            <span className="ms-auto text-xs text-muted-foreground">{formatDate(entry.performedAt)}</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Building2Icon className="size-3.5" />
            {entry.clinicCity
              ? t("patients.history.clinic", { name: entry.clinicName, city: entry.clinicCity })
              : entry.clinicName}
            {entry.performedByName && <span>· {t("treatments.performedBy", { name: entry.performedByName })}</span>}
          </div>
          {entry.notes && <p className="text-xs whitespace-pre-wrap text-muted-foreground">{entry.notes}</p>}
        </li>
      ))}
    </ul>
  );
}
