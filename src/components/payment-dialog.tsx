import { useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowDownLeftIcon, ArrowUpRightIcon, ClockIcon, LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { patientPaymentSchema, type PatientPaymentFormValues, type PatientPaymentValues } from "@/auth/schemas";
import { atLocalTime, localIsoDate, localTimeOfDay } from "@/i18n/calendar";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { fieldError } from "@/lib/form";
import { PAYMENT_METHODS, savePayment, type Payment, type PaymentKind } from "@/lib/payments";
import { DateField } from "@/components/date-field";
import { FormField } from "@/components/form-field";
import { MoneyInput } from "@/components/money-input";
import { SelectField } from "@/components/select-field";
import { TextareaField } from "@/components/textarea-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * Records money received from a patient or paid back to them (a refund), or
 * edits one (`payment`). The date and time start at now and can be changed.
 * Saved on this computer only. Opened from the patient page.
 */
export function PaymentDialog({
  open,
  onOpenChange,
  patientId,
  patientName,
  payment,
  kind,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  patientId: string;
  patientName: string;
  payment?: Payment;
  /** What a new one starts as. */
  kind: PaymentKind;
  onSaved: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
        {/* A new form each time the dialog opens, so a new one starts at the current time. */}
        {open && (
          <PaymentForm
            patientId={patientId}
            patientName={patientName}
            payment={payment}
            kind={kind}
            onSaved={onSaved}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PaymentForm({
  patientId,
  patientName,
  payment,
  kind,
  onSaved,
  onCancel,
}: {
  patientId: string;
  patientName: string;
  payment?: Payment;
  kind: PaymentKind;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<RustMessage | null>(null);
  const [now] = useState(() => Date.now());
  const paidAt = payment?.paidAt ?? now;
  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<PatientPaymentFormValues, unknown, PatientPaymentValues>({
    resolver: zodResolver(patientPaymentSchema),
    defaultValues: {
      kind: payment?.kind ?? kind,
      paidOn: localIsoDate(paidAt),
      paidTime: localTimeOfDay(paidAt),
      amount: payment?.amount ?? null,
      method: payment?.method ?? "cash",
      reference: payment?.reference ?? "",
      notes: payment?.notes ?? "",
    },
  });
  const currentKind = useWatch({ control, name: "kind" });
  const refund = currentKind === "refund";

  // `values` are already checked and trimmed by the schema.
  async function submit(values: PatientPaymentValues) {
    setError(null);
    try {
      const at = atLocalTime(values.paidOn!, values.paidTime);
      await savePayment(
        {
          patientId,
          kind: values.kind,
          amount: values.amount!,
          method: values.method,
          // An unchanged minute keeps the seconds it was saved with.
          paidAt: payment && Math.floor(payment.paidAt / 60_000) * 60_000 === at ? payment.paidAt : at,
          reference: values.reference,
          notes: values.notes,
        },
        payment?.id,
      );
      onSaved();
    } catch (e) {
      setError(toRustMessage(e));
    }
  }

  const methods = PAYMENT_METHODS.map((method) => ({ value: method, label: t(`payments.methods.${method}`) }));
  const title = payment
    ? refund
      ? t("payments.dialog.editRefundTitle")
      : t("payments.dialog.editTitle")
    : refund
      ? t("payments.dialog.refundTitle")
      : t("payments.dialog.addTitle");

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit(submit)} noValidate>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{patientName}</DialogDescription>
      </DialogHeader>

      <Controller
        control={control}
        name="kind"
        render={({ field }) => (
          <Tabs value={field.value} onValueChange={(value) => field.onChange(value as PaymentKind)}>
            <TabsList className="w-full">
              <TabsTrigger value="payment">
                <ArrowDownLeftIcon className="text-emerald-700 dark:text-emerald-400" />
                {t("payments.kinds.payment")}
              </TabsTrigger>
              <TabsTrigger value="refund">
                <ArrowUpRightIcon className="text-destructive" />
                {t("payments.kinds.refund")}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}
      />
      {refund && <p className="-mt-2 text-xs text-muted-foreground">{t("payments.hints.refund")}</p>}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="payment-amount" className="mb-1">
          {refund ? t("payments.fields.refundAmount") : t("payments.fields.amount")}
        </Label>
        <Controller
          control={control}
          name="amount"
          render={({ field, fieldState }) => (
            <MoneyInput
              id="payment-amount"
              ref={field.ref}
              autoFocus
              aria-invalid={!!fieldState.error}
              aria-describedby={fieldState.error ? "payment-amount-error" : undefined}
              value={field.value}
              onChange={field.onChange}
            />
          )}
        />
        {errors.amount && (
          <p id="payment-amount-error" className="text-xs text-destructive">
            {fieldError(errors.amount)}
          </p>
        )}
      </div>

      <Controller
        control={control}
        name="paidOn"
        render={({ field, fieldState }) => (
          <DateField
            id="payment-date"
            label={refund ? t("payments.fields.refundedOn") : t("payments.fields.paidOn")}
            error={fieldError(fieldState.error)}
            value={field.value}
            onChange={field.onChange}
          />
        )}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="payment-time" className="mb-1">
            {t("payments.fields.time")}
          </Label>
          <div className="flex items-center gap-1">
            <Input
              id="payment-time"
              type="time"
              dir="ltr"
              className="min-w-0 flex-1 rtl:text-end"
              aria-invalid={!!errors.paidTime}
              aria-describedby={errors.paidTime ? "payment-time-error" : undefined}
              {...register("paidTime")}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground"
              aria-label={t("payments.now")}
              title={t("payments.now")}
              onClick={() => {
                const at = Date.now();
                setValue("paidOn", localIsoDate(at), { shouldValidate: true });
                setValue("paidTime", localTimeOfDay(at), { shouldValidate: true });
              }}
            >
              <ClockIcon />
            </Button>
          </div>
          {errors.paidTime && (
            <p id="payment-time-error" className="text-xs text-destructive">
              {fieldError(errors.paidTime)}
            </p>
          )}
        </div>
        <Controller
          control={control}
          name="method"
          render={({ field }) => (
            <SelectField
              id="payment-method"
              label={t("payments.fields.method")}
              placeholder={t("payments.fields.method")}
              error={fieldError(errors.method)}
              options={methods}
              value={field.value}
              onValueChange={field.onChange}
              triggerRef={field.ref}
            />
          )}
        />
      </div>

      <FormField
        id="payment-reference"
        label={t("payments.fields.reference")}
        hint={t("payments.hints.reference")}
        error={fieldError(errors.reference)}
        maxLength={80}
        latin
        {...register("reference")}
      />
      <TextareaField
        id="payment-notes"
        label={t("payments.fields.notes")}
        error={fieldError(errors.notes)}
        maxLength={1000}
        rows={2}
        {...register("notes")}
      />

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{translateMessage(error)}</AlertDescription>
        </Alert>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          {t("patients.dialog.cancel")}
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <LoaderCircleIcon className="animate-spin" />}
          {isSubmitting ? t("patients.dialog.saving") : t("patients.dialog.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}
