import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, LoaderCircleIcon, SearchIcon, UserPlusIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { listPatients, PATIENT_LIST_LIMIT, type Patient } from "@/lib/patients";
import { useSyncStatus } from "@/lib/sync";
import { PatientDialog } from "@/components/patient-dialog";
import { SyncBadge } from "@/components/sync-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/** How long typing must pause before searching. */
const SEARCH_DELAY_MS = 250;

/**
 * /patients: the clinic's patients on this computer, searched by name or
 * identification code. Works offline; new ones are synced by Rust.
 */
export function PatientsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [patients, setPatients] = useState<Patient[] | null>(null);
  const [error, setError] = useState<RustMessage | null>(null);
  const [adding, setAdding] = useState(false);
  // Read again after each sync: other computers may have added or changed patients.
  const { lastSyncedAt } = useSyncStatus();

  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      listPatients(query).then(
        (result) => {
          if (!current) return;
          setPatients(result);
          setError(null);
        },
        (e) => current && setError(toRustMessage(e)),
      );
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, lastSyncedAt]);

  return (
    <Card className="w-full max-w-3xl">
      <CardHeader>
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <CardTitle>{t("patients.title")}</CardTitle>
            <CardDescription>{t("patients.description")}</CardDescription>
          </div>
          <Button onClick={() => setAdding(true)}>
            <UserPlusIcon data-icon="inline-start" />
            {t("patients.add")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="ps-8"
            type="search"
            placeholder={t("patients.search")}
            aria-label={t("patients.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{translateMessage(error)}</AlertDescription>
          </Alert>
        ) : patients === null ? (
          <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <LoaderCircleIcon className="size-4 animate-spin" />
            {t("patients.loading")}
          </p>
        ) : patients.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">{query.trim() ? t("patients.noResults") : t("patients.empty")}</p>
        ) : (
          <>
            <ul className="flex flex-col divide-y rounded-lg border">
              {patients.map((patient) => (
                <li key={patient.id}>
                  <Link
                    to="/patients/$patientId"
                    params={{ patientId: patient.id }}
                    className="flex items-center gap-3 p-3 transition-colors outline-none first:rounded-t-lg last:rounded-b-lg hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-sm font-medium">
                        {patient.firstName} {patient.lastName}
                      </span>
                      <span className="text-xs text-muted-foreground" dir="ltr">
                        {patient.identity}
                      </span>
                    </span>
                    <SyncBadge state={patient.syncState} />
                    <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" />
                  </Link>
                </li>
              ))}
            </ul>
            {patients.length >= PATIENT_LIST_LIMIT && (
              <p className="text-xs text-muted-foreground">{t("patients.limitNote", { count: PATIENT_LIST_LIMIT })}</p>
            )}
          </>
        )}
      </CardContent>

      <PatientDialog
        open={adding}
        onOpenChange={setAdding}
        onSaved={(saved) => {
          setAdding(false);
          navigate({ to: "/patients/$patientId", params: { patientId: saved.id } });
        }}
      />
    </Card>
  );
}
