import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { signUp } from "@/auth/session";
import { registerSchema, type RegisterValues } from "@/auth/schemas";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { fieldError } from "@/lib/form";
import { FormField } from "@/components/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface RegisterFormProps {
  onRegistered: (username: string) => void;
}

export function RegisterForm({ onRegistered }: RegisterFormProps) {
  const { t } = useTranslation();
  const [error, setError] = useState<RustMessage | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { fullName: "", username: "", password: "", confirmPassword: "" },
  });

  // `values` are already checked and trimmed by the schema.
  async function submit(values: RegisterValues) {
    setError(null);
    try {
      await signUp(values.username, values.password, values.fullName);
      onRegistered(values.username);
    } catch (e) {
      setError(toRustMessage(e));
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit(submit)} noValidate>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{translateMessage(error)}</AlertDescription>
        </Alert>
      )}

      <FormField
        id="register-full-name"
        label={t("auth.fields.fullName")}
        error={fieldError(errors.fullName)}
        autoComplete="name"
        maxLength={100}
        autoFocus
        {...register("fullName")}
      />
      <FormField
        id="register-username"
        label={t("auth.fields.username")}
        hint={t("auth.hints.username")}
        error={fieldError(errors.username)}
        autoComplete="username"
        maxLength={32}
        latin
        {...register("username")}
      />
      <FormField
        id="register-password"
        type="password"
        label={t("auth.fields.password")}
        hint={t("auth.hints.password")}
        error={fieldError(errors.password)}
        autoComplete="new-password"
        latin
        {...register("password")}
      />
      <FormField
        id="register-confirm-password"
        type="password"
        label={t("auth.fields.confirmPassword")}
        error={fieldError(errors.confirmPassword)}
        autoComplete="new-password"
        latin
        {...register("confirmPassword")}
      />

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting && <LoaderCircleIcon className="animate-spin" />}
        {isSubmitting ? t("auth.register.working") : t("auth.register.submit")}
      </Button>
    </form>
  );
}
