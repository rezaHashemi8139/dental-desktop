import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CloudDownloadIcon, LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { patientSchema, type PatientFormValues, type PatientValues } from "@/auth/schemas";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { fieldError } from "@/lib/form";
import { patientHistory, savePatient, type Gender, type Patient } from "@/lib/patients";
import { DateField } from "@/components/date-field";
import { FormField } from "@/components/form-field";
import { SelectField } from "@/components/select-field";
import { TextareaField } from "@/components/textarea-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Select items cannot have an empty value: this one stands for "not given". */
const NO_GENDER = "unspecified";

/**
 * Adds a patient, or edits one (`patient`). Saved on this computer first and
 * synced by Rust (src/lib/patients.ts). A new patient can be looked up on the
 * server by identification code, to fill in what another clinic already recorded.
 */
export function PatientDialog({
  open,
  onOpenChange,
  patient,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  patient?: Patient;
  onSaved: (patient: Patient) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
        {/* A new form each time the dialog opens. */}
        {open && <PatientForm patient={patient} onSaved={onSaved} onCancel={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function PatientForm({
  patient,
  onSaved,
  onCancel,
}: {
  patient?: Patient;
  onSaved: (patient: Patient) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<RustMessage | null>(null);
  const [lookup, setLookup] = useState<"idle" | "working" | "found">("idle");
  // The server has this patient: their code is fixed (patients::save_patient).
  const identityLocked = !!patient && (patient.syncState === "synced" || patient.syncState === "changed");
  const {
    register,
    handleSubmit,
    control,
    getValues,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<PatientFormValues, unknown, PatientValues>({
    resolver: zodResolver(patientSchema),
    defaultValues: {
      identityCode: patient?.identity ?? "",
      firstName: patient?.firstName ?? "",
      lastName: patient?.lastName ?? "",
      birthDate: patient?.birthDate ?? "",
      gender: patient?.gender ?? "",
      phone: patient?.phone ?? "",
      address: patient?.address ?? "",
      medicalNotes: patient?.medicalNotes ?? "",
    },
  });

  // Fills the form with what the server has for this code. The server logs the lookup.
  async function lookUp() {
    setError(null);
    setLookup("working");
    try {
      const found = await patientHistory({ identity: getValues("identityCode") });
      const fill = { shouldValidate: true, shouldDirty: true } as const;
      setValue("firstName", found.firstName, fill);
      setValue("lastName", found.lastName, fill);
      setValue("birthDate", found.birthDate, fill);
      setValue("gender", found.gender, fill);
      setValue("phone", found.phone, fill);
      setValue("address", found.address, fill);
      setValue("medicalNotes", found.medicalNotes, fill);
      setLookup("found");
    } catch (e) {
      setError(toRustMessage(e));
      setLookup("idle");
    }
  }

  // `values` are already checked and trimmed by the schema.
  async function submit(values: PatientValues) {
    setError(null);
    try {
      const saved = await savePatient(
        {
          identity: values.identityCode,
          firstName: values.firstName,
          lastName: values.lastName,
          birthDate: values.birthDate,
          gender: values.gender,
          phone: values.phone,
          address: values.address,
          medicalNotes: values.medicalNotes,
        },
        patient?.id,
      );
      onSaved(saved);
    } catch (e) {
      setError(toRustMessage(e));
    }
  }

  const genders: { value: string; label: string }[] = [
    { value: NO_GENDER, label: t("patients.gender.unspecified") },
    { value: "male", label: t("patients.gender.male") },
    { value: "female", label: t("patients.gender.female") },
  ];

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit(submit)} noValidate>
      <DialogHeader>
        <DialogTitle>{patient ? t("patients.dialog.editTitle") : t("patients.dialog.addTitle")}</DialogTitle>
        <DialogDescription>
          {patient ? t("patients.dialog.editDescription") : t("patients.dialog.addDescription")}
        </DialogDescription>
      </DialogHeader>

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <FormField
            id="patient-identity-code"
            label={t("patients.fields.identityCode")}
            hint={identityLocked ? t("patients.errors.identityLocked") : t("patients.hints.identityCode")}
            error={fieldError(errors.identityCode)}
            maxLength={24}
            readOnly={identityLocked}
            autoFocus={!patient}
            latin
            {...register("identityCode")}
          />
        </div>
        {!patient && (
          // Lined up with the input, above its hint.
          <Button type="button" variant="outline" className="mb-5.5" onClick={lookUp} disabled={lookup === "working"}>
            {lookup === "working" ? <LoaderCircleIcon className="animate-spin" /> : <CloudDownloadIcon data-icon="inline-start" />}
            {lookup === "working" ? t("patients.lookup.working") : t("patients.lookup.button")}
          </Button>
        )}
      </div>
      {lookup === "found" && (
        <Alert>
          <AlertDescription>{t("patients.lookup.found")}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          id="patient-first-name"
          label={t("patients.fields.firstName")}
          error={fieldError(errors.firstName)}
          maxLength={100}
          autoFocus={!!patient}
          {...register("firstName")}
        />
        <FormField
          id="patient-last-name"
          label={t("patients.fields.lastName")}
          error={fieldError(errors.lastName)}
          maxLength={100}
          {...register("lastName")}
        />
        <Controller
          control={control}
          name="gender"
          render={({ field }) => (
            <SelectField
              id="patient-gender"
              label={t("patients.fields.gender")}
              placeholder={t("patients.gender.unspecified")}
              error={null}
              options={genders}
              value={field.value || NO_GENDER}
              onValueChange={(value) => field.onChange((value === NO_GENDER ? "" : value) as Gender)}
              triggerRef={field.ref}
            />
          )}
        />
        <FormField
          id="patient-phone"
          type="tel"
          label={t("patients.fields.phone")}
          error={fieldError(errors.phone)}
          maxLength={16}
          latin
          {...register("phone")}
        />
      </div>
      <Controller
        control={control}
        name="birthDate"
        render={({ field, fieldState }) => (
          <DateField
            id="patient-birth-date"
            label={t("patients.fields.birthDate")}
            error={fieldError(fieldState.error)}
            value={field.value}
            onChange={field.onChange}
            clearable
          />
        )}
      />
      <TextareaField
        id="patient-address"
        label={t("patients.fields.address")}
        error={fieldError(errors.address)}
        maxLength={500}
        rows={2}
        {...register("address")}
      />
      <TextareaField
        id="patient-medical-notes"
        label={t("patients.fields.medicalNotes")}
        hint={t("patients.hints.medicalNotes")}
        error={fieldError(errors.medicalNotes)}
        maxLength={5000}
        rows={3}
        {...register("medicalNotes")}
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
