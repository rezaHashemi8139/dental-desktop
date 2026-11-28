import { useCallback, useEffect, useState } from "react";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowDownLeftIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  HistoryIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlusIcon,
  StethoscopeIcon,
  Trash2Icon,
  Undo2Icon,
  WalletIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSession } from "@/auth/store";
import { useFormatDate } from "@/i18n/calendar";
import { useFormatMoney } from "@/i18n/currency";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import {
  deleteTreatment,
  getPatient,
  listLocalUsers,
  listTreatments,
  type LocalUser,
  type Patient,
  type Treatment,
} from "@/lib/patients";
import { deletePayment, listPayments, type Payment, type PaymentKind, type PaymentList } from "@/lib/payments";
import { useSyncStatus } from "@/lib/sync";
import { cn } from "@/lib/utils";
import { PatientDialog } from "@/components/patient-dialog";
import { PatientHistoryDialog } from "@/components/patient-history-dialog";
import { PaymentDialog } from "@/components/payment-dialog";
import { SyncBadge } from "@/components/sync-badge";
import { TreatmentDialog } from "@/components/treatment-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const patientRoute = getRouteApi("/app/patients/$patientId");

/** What is open over the page. */
type Open =
  | { kind: "edit" }
  | { kind: "history" }
  | { kind: "treatment"; treatment?: Treatment }
  | { kind: "delete"; treatment: Treatment }
  | { kind: "payment"; paymentKind: PaymentKind; payment?: Payment }
  | { kind: "deletePayment"; payment: Payment };

/**
 * /patients/$patientId: one patient's details, their treatments in this clinic
 * with their history in every clinic from the server, and the payments received
 * from them and refunded to them (on this computer only).
 */
export function PatientPage() {
  const { t } = useTranslation();
  const session = useSession();
  const navigate = useNavigate();
  const { patientId } = patientRoute.useParams();
  // undefined while loading, null if there is no such patient here.
  const [patient, setPatient] = useState<Patient | null | undefined>(undefined);
  const [treatments, setTreatments] = useState<Treatment[]>([]);
  const [payments, setPayments] = useState<PaymentList | null>(null);
  const [users, setUsers] = useState<LocalUser[]>([]);
  const [error, setError] = useState<RustMessage | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  // Read again after each sync: other computers may have changed this patient.
  const { lastSyncedAt } = useSyncStatus();

  const load = useCallback(async () => {
    try {
      const [found, list, people, paid] = await Promise.all([
        getPatient(patientId),
        listTreatments(patientId),
        listLocalUsers(),
        listPayments(patientId),
      ]);
      setPatient(found);
      setTreatments(list);
      setPayments(paid);
      setUsers(people);
      setError(null);
    } catch (e) {
      setError(toRustMessage(e));
    }
  }, [patientId]);

  useEffect(() => {
    void load();
  }, [load, lastSyncedAt]);

  const close = () => setOpen(null);
  const back = (
    <Button asChild variant="ghost" size="sm" className="self-start">
      <Link to="/patients">
        <ArrowRightIcon data-icon="inline-start" className="ltr:rotate-180" />
        {t("patients.back")}
      </Link>
    </Button>
  );

  if (!session) return null;
  if (error) {
    return (
      <div className="flex w-full max-w-3xl flex-col gap-4">
        {back}
        <Alert variant="destructive">
          <AlertDescription>{translateMessage(error)}</AlertDescription>
        </Alert>
      </div>
    );
  }
  if (patient === undefined) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-4 animate-spin" />
        {t("patients.loading")}
      </p>
    );
  }
  if (patient === null) {
    return (
      <div className="flex w-full max-w-3xl flex-col gap-4">
        {back}
        <Alert>
          <AlertDescription>{t("patients.errors.notFound")}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const name = `${patient.firstName} ${patient.lastName}`;
  const userName = (id: string | null) => {
    const user = id ? users.find((candidate) => candidate.id === id) : undefined;
    return user ? user.fullName || user.username : null;
  };

  return (
    <div className="flex w-full max-w-3xl flex-col gap-4">
      {back}
      <PatientDetails
        patient={patient}
        online={session.online}
        onEdit={() => setOpen({ kind: "edit" })}
        onHistory={() => setOpen({ kind: "history" })}
      />

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle className="flex-1">{t("treatments.title")}</CardTitle>
            <Button onClick={() => setOpen({ kind: "treatment" })}>
              <PlusIcon data-icon="inline-start" />
              {t("treatments.add")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {treatments.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("treatments.empty")}</p>
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border">
              {treatments.map((treatment) => (
                <TreatmentRow
                  key={treatment.id}
                  treatment={treatment}
                  performer={userName(treatment.performedBy)}
                  onEdit={() => setOpen({ kind: "treatment", treatment })}
                  onDelete={() => setOpen({ kind: "delete", treatment })}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {payments && (
        <PaymentsCard
          list={payments}
          userName={userName}
          canChange={(payment) => payment.recordedBy === session.userId || session.role === "manager"}
          onAdd={(paymentKind) => setOpen({ kind: "payment", paymentKind })}
          onEdit={(payment) => setOpen({ kind: "payment", paymentKind: payment.kind, payment })}
          onDelete={(payment) => setOpen({ kind: "deletePayment", payment })}
        />
      )}

      <PatientDialog
        open={open?.kind === "edit"}
        onOpenChange={(next) => !next && close()}
        patient={patient}
        onSaved={(saved) => {
          close();
          // A corrected code gives the patient a new id.
          if (saved.id !== patient.id) navigate({ to: "/patients/$patientId", params: { patientId: saved.id }, replace: true });
          else void load();
        }}
      />
      <PatientHistoryDialog
        open={open?.kind === "history"}
        onOpenChange={(next) => !next && close()}
        identity={patient.identity}
      />
      <TreatmentDialog
        open={open?.kind === "treatment"}
        onOpenChange={(next) => !next && close()}
        patientId={patient.id}
        patientName={name}
        treatment={open?.kind === "treatment" ? open.treatment : undefined}
        users={users}
        defaultPerformer={session.userId}
        onSaved={() => {
          close();
          void load();
        }}
      />
      <PaymentDialog
        open={open?.kind === "payment"}
        onOpenChange={(next) => !next && close()}
        patientId={patient.id}
        patientName={name}
        payment={open?.kind === "payment" ? open.payment : undefined}
        kind={open?.kind === "payment" ? open.paymentKind : "payment"}
        onSaved={() => {
          close();
          void load();
        }}
      />
      <DeletePaymentDialog
        payment={open?.kind === "deletePayment" ? open.payment : null}
        onClose={close}
        onDeleted={() => {
          close();
          void load();
        }}
      />
      <DeleteTreatmentDialog
        treatment={open?.kind === "delete" ? open.treatment : null}
        onClose={close}
        onDeleted={() => {
          close();
          void load();
        }}
      />
    </div>
  );
}

function PatientDetails({
  patient,
  online,
  onEdit,
  onHistory,
}: {
  patient: Patient;
  online: boolean;
  onEdit: () => void;
  onHistory: () => void;
}) {
  const { t } = useTranslation();
  const formatDate = useFormatDate();
  const genderLabel = patient.gender ? t(`patients.gender.${patient.gender}`) : null;
  // A plain date: shown as that day wherever the computer is.
  const birthDate = patient.birthDate ? formatDate(new Date(patient.birthDate), { dateStyle: "long", timeZone: "UTC" }) : null;
  const rows: { label: string; value: string | null; latin?: boolean }[] = [
    { label: t("patients.fields.birthDate"), value: birthDate },
    { label: t("patients.fields.gender"), value: genderLabel },
    { label: t("patients.fields.phone"), value: patient.phone || null, latin: true },
    { label: t("patients.fields.email"), value: patient.email || null, latin: true },
    { label: t("patients.fields.address"), value: patient.address || null },
  ];

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <CardTitle className="flex flex-wrap items-center gap-2">
              {patient.firstName} {patient.lastName}
              <SyncBadge state={patient.syncState} />
            </CardTitle>
            <CardDescription>
              {t("patients.fields.identityCode")}: <span dir="ltr">{patient.identity}</span>
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {/* A disabled button shows no tooltip, so the reason sits on a wrapper. */}
            <span title={online ? undefined : t("patients.errors.historyNeedsServer")}>
              <Button variant="outline" onClick={onHistory} disabled={!online}>
                <HistoryIcon data-icon="inline-start" />
                {t("patients.history.button")}
              </Button>
            </span>
            <Button variant="outline" onClick={onEdit}>
              <PencilIcon data-icon="inline-start" />
              {t("patients.edit")}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {patient.syncState === "rejected" && (
          <Alert variant="destructive">
            <AlertDescription>{t("patients.sync.rejectedHint")}</AlertDescription>
          </Alert>
        )}
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          {rows.map((row) => (
            <div key={row.label} className="flex flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">{row.label}</dt>
              {/* Latin text keeps its own direction but lines up with the rest. */}
              <dd
                dir={row.latin && row.value ? "ltr" : undefined}
                className={row.latin && row.value ? "break-all rtl:text-end" : "whitespace-pre-wrap"}
              >
                {row.value ?? <span className="text-muted-foreground">{t("patients.notGiven")}</span>}
              </dd>
            </div>
          ))}
        </dl>
        {patient.medicalNotes && (
          <Alert>
            <StethoscopeIcon />
            <AlertTitle>{t("patients.fields.medicalNotes")}</AlertTitle>
            <AlertDescription className="whitespace-pre-wrap">{patient.medicalNotes}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

function TreatmentRow({
  treatment,
  performer,
  onEdit,
  onDelete,
}: {
  treatment: Treatment;
  performer: string | null;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const formatDate = useFormatDate();
  return (
    <li className="flex items-start gap-3 p-3 text-sm">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{treatment.procedure}</span>
          {treatment.tooth && <Badge variant="secondary">{t("treatments.toothLabel", { tooth: treatment.tooth })}</Badge>}
          <SyncBadge state={treatment.syncState} />
        </div>
        <div className="text-xs text-muted-foreground">
          {formatDate(treatment.performedAt)}
          {performer && <span> · {t("treatments.performedBy", { name: performer })}</span>}
        </div>
        {treatment.notes && <p className="text-xs whitespace-pre-wrap text-muted-foreground">{treatment.notes}</p>}
      </div>
      <Button variant="ghost" size="icon-sm" aria-label={t("treatments.edit")} title={t("treatments.edit")} onClick={onEdit}>
        <PencilIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-destructive"
        aria-label={t("treatments.delete")}
        title={t("treatments.delete")}
        onClick={onDelete}
      >
        <Trash2Icon />
      </Button>
    </li>
  );
}

/** Asks before deleting a treatment; the deletion syncs to the clinic's other computers. */
function DeleteTreatmentDialog({
  treatment,
  onClose,
  onDeleted,
}: {
  treatment: Treatment | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<RustMessage | null>(null);

  async function confirm() {
    if (!treatment) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteTreatment(treatment.id);
      onDeleted();
    } catch (e) {
      setError(toRustMessage(e));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog
      open={treatment !== null}
      onOpenChange={(next) => {
        if (next || deleting) return;
        setError(null);
        onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("treatments.deleteDialog.title")}</DialogTitle>
          <DialogDescription>{t("treatments.deleteDialog.description", { procedure: treatment?.procedure ?? "" })}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{translateMessage(error)}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={deleting}>
            {t("patients.dialog.cancel")}
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={deleting}>
            {deleting ? <LoaderCircleIcon className="animate-spin" /> : <Trash2Icon data-icon="inline-start" />}
            {deleting ? t("treatments.deleteDialog.working") : t("treatments.deleteDialog.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Payments received from the patient and refunds paid back, with the totals. */
function PaymentsCard({
  list,
  userName,
  canChange,
  onAdd,
  onEdit,
  onDelete,
}: {
  list: PaymentList;
  userName: (id: string | null) => string | null;
  canChange: (payment: Payment) => boolean;
  onAdd: (kind: PaymentKind) => void;
  onEdit: (payment: Payment) => void;
  onDelete: (payment: Payment) => void;
}) {
  const { t } = useTranslation();
  const formatMoney = useFormatMoney();
  const totals = [
    { label: t("payments.totals.received"), value: list.received, className: "text-emerald-700 dark:text-emerald-400" },
    { label: t("payments.totals.refunded"), value: list.refunded, className: list.refunded ? "text-destructive" : undefined },
    { label: t("payments.totals.balance"), value: list.balance, className: undefined },
  ];

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <CardTitle className="flex items-center gap-2">
              <WalletIcon className="size-4 text-muted-foreground" />
              {t("payments.title")}
            </CardTitle>
            <CardDescription>{t("payments.localOnly")}</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => onAdd("refund")}>
              <Undo2Icon data-icon="inline-start" />
              {t("payments.addRefund")}
            </Button>
            <Button onClick={() => onAdd("payment")}>
              <PlusIcon data-icon="inline-start" />
              {t("payments.add")}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-3 divide-x rounded-lg border bg-muted/30 rtl:divide-x-reverse">
          {totals.map((total) => (
            <div key={total.label} className="flex min-w-0 flex-col gap-1 p-3">
              <dt className="text-xs text-muted-foreground">{total.label}</dt>
              <dd className={cn("truncate text-sm font-semibold tabular-nums sm:text-base", total.className)}>
                {formatMoney(total.value)}
              </dd>
            </div>
          ))}
        </dl>
        {list.payments.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("payments.empty")}</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border">
            {list.payments.map((payment) => (
              <PaymentRow
                key={payment.id}
                payment={payment}
                recorder={userName(payment.recordedBy)}
                canChange={canChange(payment)}
                onEdit={() => onEdit(payment)}
                onDelete={() => onDelete(payment)}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function PaymentRow({
  payment,
  recorder,
  canChange,
  onEdit,
  onDelete,
}: {
  payment: Payment;
  recorder: string | null;
  canChange: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const formatDate = useFormatDate();
  const formatMoney = useFormatMoney();
  const refund = payment.kind === "refund";
  // A disabled button shows no tooltip, so the reason sits on a wrapper.
  const notAllowed = canChange ? undefined : t("payments.errors.notAllowed");
  return (
    <li className="flex items-start gap-3 p-3 text-sm">
      <span
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full",
          refund ? "bg-destructive/10 text-destructive" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        )}
        title={t(`payments.kinds.${payment.kind}`)}
      >
        {refund ? <ArrowUpRightIcon className="size-4" /> : <ArrowDownLeftIcon className="size-4" />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("font-semibold tabular-nums", refund && "text-destructive")}>
            {formatMoney(payment.amount)}
          </span>
          <Badge variant="secondary">{t(`payments.methods.${payment.method}`)}</Badge>
          {refund && <Badge variant="outline">{t("payments.kinds.refund")}</Badge>}
        </div>
        <div className="text-xs text-muted-foreground">
          {formatDate(payment.paidAt, { dateStyle: "medium", timeStyle: "short" })}
          {recorder && <span> · {t("payments.recordedBy", { name: recorder })}</span>}
        </div>
        {payment.reference && (
          <div className="text-xs text-muted-foreground">
            {t("payments.fields.reference")}:{" "}
            <span dir="ltr" className="font-mono">
              {payment.reference}
            </span>
          </div>
        )}
        {payment.notes && <p className="text-xs whitespace-pre-wrap text-muted-foreground">{payment.notes}</p>}
      </div>
      <span title={notAllowed}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("payments.edit")}
          title={canChange ? t("payments.edit") : undefined}
          disabled={!canChange}
          onClick={onEdit}
        >
          <PencilIcon />
        </Button>
      </span>
      <span title={notAllowed}>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-destructive"
          aria-label={t("payments.delete")}
          title={canChange ? t("payments.delete") : undefined}
          disabled={!canChange}
          onClick={onDelete}
        >
          <Trash2Icon />
        </Button>
      </span>
    </li>
  );
}

/** Asks before deleting a payment or refund for good. */
function DeletePaymentDialog({
  payment,
  onClose,
  onDeleted,
}: {
  payment: Payment | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const formatDate = useFormatDate();
  const formatMoney = useFormatMoney();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<RustMessage | null>(null);

  async function confirm() {
    if (!payment) return;
    setDeleting(true);
    setError(null);
    try {
      await deletePayment(payment.id);
      onDeleted();
    } catch (e) {
      setError(toRustMessage(e));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog
      open={payment !== null}
      onOpenChange={(next) => {
        if (next || deleting) return;
        setError(null);
        onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {payment?.kind === "refund" ? t("payments.deleteDialog.refundTitle") : t("payments.deleteDialog.title")}
          </DialogTitle>
          <DialogDescription>
            {payment &&
              t("payments.deleteDialog.description", {
                amount: formatMoney(payment.amount),
                date: formatDate(payment.paidAt, { dateStyle: "medium", timeStyle: "short" }),
              })}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{translateMessage(error)}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={deleting}>
            {t("patients.dialog.cancel")}
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={deleting}>
            {deleting ? <LoaderCircleIcon className="animate-spin" /> : <Trash2Icon data-icon="inline-start" />}
            {deleting ? t("payments.deleteDialog.working") : t("payments.deleteDialog.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
