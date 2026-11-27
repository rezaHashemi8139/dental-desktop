import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { treatmentSchema, type TreatmentValues } from "@/auth/schemas";
import { localIsoDate } from "@/i18n/calendar";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { fieldError } from "@/lib/form";
import { saveTreatment, type LocalUser, type Treatment } from "@/lib/patients";
import { DateField } from "@/components/date-field";
import { FormField } from "@/components/form-field";
import { SelectField } from "@/components/select-field";
import { TextareaField } from "@/components/textarea-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Select items cannot have an empty value: this one stands for "not given". */
const NO_PERFORMER = "none";

/**
 * Adds a treatment to a patient, or edits one (`treatment`). Saved on this
 * computer first and synced by Rust. Opened from the patient page.
 */
export function TreatmentDialog({
  open,
  onOpenChange,
  patientId,
  patientName,
  treatment,
  users,
  defaultPerformer,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  patientId: string;
  patientName: string;
  treatment?: Treatment;
  /** Who can be picked as having performed it. */
  users: LocalUser[];
  /** Picked for a new treatment: the user logged in. */
  defaultPerformer: string;
  onSaved: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
        {/* A new form each time the dialog opens. */}
        {open && (
          <TreatmentForm
            patientId={patientId}
            patientName={patientName}
            treatment={treatment}
            users={users}
            defaultPerformer={defaultPerformer}
            onSaved={onSaved}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function TreatmentForm({
  patientId,
  patientName,
  treatment,
  users,
  defaultPerformer,
  onSaved,
  onCancel,
}: {
  patientId: string;
  patientName: string;
  treatment?: Treatment;
  users: LocalUser[];
  defaultPerformer: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<RustMessage | null>(null);
  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
  } = useForm<TreatmentValues>({
    resolver: zodResolver(treatmentSchema),
    defaultValues: {
      performedOn: localIsoDate(treatment?.performedAt ?? Date.now()),
      tooth: treatment?.tooth ?? "",
      procedure: treatment?.procedure ?? "",
      notes: treatment?.notes ?? "",
      performedBy: treatment ? (treatment.performedBy ?? "") : defaultPerformer,
    },
  });

  // `values` are already checked and trimmed by the schema.
  async function submit(values: TreatmentValues) {
    setError(null);
    try {
      await saveTreatment(
        {
          patientId,
          performedBy: values.performedBy || null,
          performedAt: performedAt(values.performedOn!, treatment?.performedAt),
          tooth: values.tooth,
          procedure: values.procedure,
          notes: values.notes,
        },
        treatment?.id,
      );
      onSaved();
    } catch (e) {
      setError(toRustMessage(e));
    }
  }

  // Everyone who logged in here, plus whoever an older treatment names.
  const performers = [
    { value: NO_PERFORMER, label: t("treatments.performedByNone") },
    ...users.map((user) => ({ value: user.id, label: user.fullName || user.username })),
  ];
  if (treatment?.performedBy && !users.some((user) => user.id === treatment.performedBy)) {
    performers.push({ value: treatment.performedBy, label: t("treatments.performedByUnknown") });
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit(submit)} noValidate>
      <DialogHeader>
        <DialogTitle>{treatment ? t("treatments.dialog.editTitle") : t("treatments.dialog.addTitle")}</DialogTitle>
        <DialogDescription>{patientName}</DialogDescription>
      </DialogHeader>

      <Controller
        control={control}
        name="performedOn"
        render={({ field, fieldState }) => (
          <DateField
            id="treatment-date"
            label={t("treatments.fields.performedOn")}
            error={fieldError(fieldState.error)}
            value={field.value}
            onChange={field.onChange}
          />
        )}
      />
      <FormField
        id="treatment-procedure"
        label={t("treatments.fields.procedure")}
        error={fieldError(errors.procedure)}
        maxLength={200}
        autoFocus
        {...register("procedure")}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          id="treatment-tooth"
          label={t("treatments.fields.tooth")}
          hint={t("treatments.hints.tooth")}
          error={fieldError(errors.tooth)}
          maxLength={20}
          latin
          {...register("tooth")}
        />
        <Controller
          control={control}
          name="performedBy"
          render={({ field }) => (
            <SelectField
              id="treatment-performed-by"
              label={t("treatments.fields.performedBy")}
              placeholder={t("treatments.performedByNone")}
              error={null}
              options={performers}
              value={field.value || NO_PERFORMER}
              onValueChange={(value) => field.onChange(value === NO_PERFORMER ? "" : value)}
              triggerRef={field.ref}
            />
          )}
        />
      </div>
      <TextareaField
        id="treatment-notes"
        label={t("treatments.fields.notes")}
        error={fieldError(errors.notes)}
        maxLength={5000}
        rows={3}
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

/**
 * When a treatment picked for day `iso` took place: its earlier time if that day
 * did not change, now if it is today, otherwise noon of that day (local time).
 */
function performedAt(iso: string, previous?: number): number {
  if (previous !== undefined && localIsoDate(previous) === iso) return previous;
  if (localIsoDate(Date.now()) === iso) return Date.now();
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day, 12).getTime();
}
