import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { existingOwnerSetupSchema, newOwnerSetupSchema, type SetupValues } from "@/auth/schemas";
import { setupClinic, type OwnerInput } from "@/auth/setup";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { fieldError } from "@/lib/form";
import { FormField } from "@/components/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

/** The owner's fields are checked by the schema of the chosen kind (src/auth/schemas.ts). */
const resolvers = {
  new: zodResolver(newOwnerSetupSchema),
  existing: zodResolver(existingOwnerSetupSchema),
};

interface SetupFormProps {
  /** Called with the owner's username once the clinic is registered. */
  onDone: (username: string) => void;
}

/** First start: the clinic and the person responsible for it. */
export function SetupForm({ onDone }: SetupFormProps) {
  const { t } = useTranslation();
  const [error, setError] = useState<RustMessage | null>(null);
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    clearErrors,
    formState: { errors, isSubmitting },
  } = useForm<SetupValues>({
    resolver: (values, context, options) => resolvers[values.ownerKind](values, context, options),
    defaultValues: {
      clinicName: "",
      licenseNumber: "",
      clinicPhone: "",
      city: "",
      address: "",
      postalCode: "",
      ownerKind: "new",
      fullName: "",
      nationalId: "",
      ownerPhone: "",
      username: "",
      password: "",
      confirmPassword: "",
    },
  });
  const ownerKind = watch("ownerKind");

  function changeOwnerKind(kind: string) {
    if (kind !== "new" && kind !== "existing") return;
    setValue("ownerKind", kind);
    clearErrors();
    setError(null);
  }

  // `values` are already checked and trimmed by the schema.
  async function submit(values: SetupValues) {
    setError(null);
    const clinic = {
      name: values.clinicName,
      licenseNumber: values.licenseNumber,
      phone: values.clinicPhone,
      city: values.city,
      address: values.address,
      postalCode: values.postalCode,
    };
    const owner: OwnerInput =
      values.ownerKind === "new"
        ? {
            kind: "new",
            username: values.username,
            password: values.password,
            fullName: values.fullName,
            nationalId: values.nationalId,
            phone: values.ownerPhone,
          }
        : { kind: "existing", username: values.username, password: values.password, nationalId: values.nationalId };
    try {
      onDone(await setupClinic(clinic, owner));
    } catch (e) {
      setError(toRustMessage(e));
    }
  }

  return (
    <form className="flex flex-col gap-6" onSubmit={handleSubmit(submit)} noValidate>
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-4 text-sm font-semibold">{t("setup.clinic")}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            id="setup-clinic-name"
            label={t("setup.fields.clinicName")}
            error={fieldError(errors.clinicName)}
            maxLength={200}
            autoFocus
            {...register("clinicName")}
          />
          <FormField
            id="setup-license-number"
            label={t("setup.fields.licenseNumber")}
            hint={t("setup.hints.licenseNumber")}
            error={fieldError(errors.licenseNumber)}
            maxLength={32}
            latin
            {...register("licenseNumber")}
          />
          <FormField
            id="setup-clinic-phone"
            type="tel"
            label={t("setup.fields.clinicPhone")}
            error={fieldError(errors.clinicPhone)}
            autoComplete="tel"
            maxLength={16}
            latin
            {...register("clinicPhone")}
          />
          <FormField
            id="setup-city"
            label={t("setup.fields.city")}
            error={fieldError(errors.city)}
            autoComplete="address-level2"
            maxLength={100}
            {...register("city")}
          />
          <div className="sm:col-span-2">
            <FormField
              id="setup-address"
              label={t("setup.fields.address")}
              error={fieldError(errors.address)}
              autoComplete="street-address"
              maxLength={500}
              {...register("address")}
            />
          </div>
          <FormField
            id="setup-postal-code"
            label={t("setup.fields.postalCode")}
            error={fieldError(errors.postalCode)}
            autoComplete="postal-code"
            inputMode="numeric"
            maxLength={10}
            latin
            {...register("postalCode")}
          />
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-sm font-semibold">{t("setup.owner")}</legend>
        <p className="text-xs text-muted-foreground">{t("setup.ownerDescription")}</p>
        <Tabs value={ownerKind} onValueChange={changeOwnerKind}>
          <TabsList className="w-full">
            <TabsTrigger value="new">{t("setup.ownerKind.new")}</TabsTrigger>
            <TabsTrigger value="existing">{t("setup.ownerKind.existing")}</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="grid gap-4 sm:grid-cols-2">
          {ownerKind === "new" && (
            <FormField
              id="setup-full-name"
              label={t("auth.fields.fullName")}
              error={fieldError(errors.fullName)}
              autoComplete="name"
              maxLength={100}
              {...register("fullName")}
            />
          )}
          <FormField
            id="setup-national-id"
            label={t("setup.fields.nationalId")}
            hint={ownerKind === "existing" ? t("setup.hints.existingNationalId") : undefined}
            error={fieldError(errors.nationalId)}
            inputMode="numeric"
            maxLength={10}
            latin
            {...register("nationalId")}
          />
          {ownerKind === "new" && (
            <FormField
              id="setup-owner-phone"
              type="tel"
              label={t("setup.fields.ownerPhone")}
              error={fieldError(errors.ownerPhone)}
              autoComplete="tel"
              maxLength={16}
              latin
              {...register("ownerPhone")}
            />
          )}
          <FormField
            id="setup-username"
            label={t("auth.fields.username")}
            hint={ownerKind === "new" ? t("auth.hints.username") : undefined}
            error={fieldError(errors.username)}
            autoComplete="username"
            maxLength={ownerKind === "new" ? 32 : 64}
            latin
            {...register("username")}
          />
          <FormField
            id="setup-password"
            type="password"
            label={t("auth.fields.password")}
            hint={ownerKind === "new" ? t("auth.hints.password") : undefined}
            error={fieldError(errors.password)}
            autoComplete={ownerKind === "new" ? "new-password" : "current-password"}
            latin
            {...register("password")}
          />
          {ownerKind === "new" && (
            <FormField
              id="setup-confirm-password"
              type="password"
              label={t("auth.fields.confirmPassword")}
              error={fieldError(errors.confirmPassword)}
              autoComplete="new-password"
              latin
              {...register("confirmPassword")}
            />
          )}
        </div>
      </fieldset>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{translateMessage(error)}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting && <LoaderCircleIcon className="animate-spin" />}
        {isSubmitting ? t("setup.working") : t("setup.submit")}
      </Button>
    </form>
  );
}
