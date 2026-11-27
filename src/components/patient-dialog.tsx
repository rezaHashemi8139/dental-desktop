import { useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { patientSchema, type PatientFormValues, type PatientValues } from "@/auth/schemas";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { fieldError } from "@/lib/form";
import { listPatients, patientHistory, savePatient, type Gender, type Patient } from "@/lib/patients";
import { DateField } from "@/components/date-field";
import { FormField } from "@/components/form-field";
import { SelectField } from "@/components/select-field";
import { TextareaField } from "@/components/textarea-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Select items cannot have an empty value: this one stands for "not given". */
const NO_GENDER = "unspecified";

/** The fields a lookup fills in. */
type LookedUpFields = Pick<
  Patient,
  "firstName" | "lastName" | "birthDate" | "gender" | "phone" | "address" | "medicalNotes"
>;

const EMPTY_FIELDS: LookedUpFields = {
  firstName: "",
  lastName: "",
  birthDate: "",
  gender: "",
  phone: "",
  address: "",
  medicalNotes: "",
};

/**
 * Lookup outcomes that are not shown: a new patient, no server, or a code still
 * being typed are normal while filling in the form.
 */
const QUIET_LOOKUP_ERRORS = new Set([
  "patients.errors.historyNotFound",
  "patients.errors.historyNeedsServer",
  "errors.network",
  "person.errors.invalidIdentityCode",
]);

/** Lookups that would fail the same way again for the same code. */
const FINAL_LOOKUP_ERRORS = new Set(["patients.errors.historyNotFound", "person.errors.invalidIdentityCode"]);

/** Roughly how Rust reads a code (person::normalize): enough to tell codes apart here. */
function lookupKey(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * Adds a patient, or edits one (`patient`). Saved on this computer first and
 * synced by Rust (src/lib/patients.ts). When the code field of a new patient is
 * left, the code is looked up among this computer's patients, then on the server,
 * to fill in what this or another clinic already recorded.
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
  // "local": found on this computer; "server": found on the server.
  const [lookup, setLookup] = useState<"idle" | "working" | "local" | "server">("idle");
  // The code last looked up: the server logs every lookup, so leaving the field
  // again with the same code does not repeat it.
  const lastLookup = useRef<string | null>(null);
  // The other fields hold a looked-up patient: cleared if the code then changes
  // to one that is not found, so one person's details never stay under another's code.
  const filled = useRef(false);
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

  function fillForm(found: LookedUpFields) {
    const options = { shouldValidate: true, shouldDirty: true } as const;
    setValue("firstName", found.firstName, options);
    setValue("lastName", found.lastName, options);
    setValue("birthDate", found.birthDate, options);
    setValue("gender", found.gender, options);
    setValue("phone", found.phone, options);
    setValue("address", found.address, options);
    setValue("medicalNotes", found.medicalNotes, options);
  }

  // Run on leaving the code field. A patient already on this computer is filled in
  // from here (saving then updates them, see savePatient); otherwise the server is
  // asked, which logs the lookup.
  async function lookUp() {
    const identity = getValues("identityCode");
    const key = lookupKey(identity);
    if (key === "" || key === lastLookup.current) return;
    lastLookup.current = key;
    // The code changed while waiting: that answer is for another patient.
    const stale = () => lastLookup.current !== key || lookupKey(getValues("identityCode")) !== key;
    setError(null);
    setLookup("working");
    try {
      const local = (await listPatients(key)).patients.find((p) => p.identity === key);
      if (stale()) return;
      if (local) {
        fillForm(local);
        filled.current = true;
        setLookup("local");
        return;
      }
      const found = await patientHistory({ identity });
      if (stale()) return;
      fillForm(found);
      filled.current = true;
      setLookup("server");
    } catch (e) {
      if (stale()) return;
      const message = toRustMessage(e);
      if (!FINAL_LOOKUP_ERRORS.has(message.key)) lastLookup.current = null; // try again next time
      if (!QUIET_LOOKUP_ERRORS.has(message.key)) setError(message);
      if (filled.current) {
        fillForm(EMPTY_FIELDS);
        filled.current = false;
      }
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

      <FormField
        id="patient-identity-code"
        label={t("patients.fields.identityCode")}
        hint={
          identityLocked
            ? t("patients.errors.identityLocked")
            : lookup === "working"
              ? t("patients.lookup.working")
              : t("patients.hints.identityCode")
        }
        error={fieldError(errors.identityCode)}
        maxLength={24}
        readOnly={identityLocked}
        autoFocus={!patient}
        latin
        {...register("identityCode", patient ? undefined : { onBlur: () => void lookUp() })}
      />
      {(lookup === "local" || lookup === "server") && (
        <Alert>
          <AlertDescription>
            {lookup === "local" ? t("patients.lookup.foundLocal") : t("patients.lookup.found")}
          </AlertDescription>
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
