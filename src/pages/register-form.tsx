import { useState, type FormEvent } from "react";
import { LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MIN_PASSWORD_LENGTH, signUp, USERNAME_PATTERN } from "@/auth/session";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { FormField } from "@/components/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface RegisterFormProps {
  onRegistered: (username: string) => void;
}

type Field = "fullName" | "username" | "password" | "confirmPassword";

export function RegisterForm({ onRegistered }: RegisterFormProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<Field, string>>({
    fullName: "",
    username: "",
    password: "",
    confirmPassword: "",
  });
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState<RustMessage | null>(null);
  const [busy, setBusy] = useState(false);

  // Same rules as the server, checked here so mistakes show before sending.
  const fieldErrors: Record<Field, string | null> = {
    fullName: values.fullName.trim() ? null : t("auth.validation.required"),
    username: USERNAME_PATTERN.test(values.username.trim()) ? null : t("auth.validation.usernameFormat"),
    password: [...values.password].length >= MIN_PASSWORD_LENGTH ? null : t("auth.validation.passwordLength"),
    confirmPassword: values.confirmPassword === values.password ? null : t("auth.validation.passwordMismatch"),
  };
  const valid = Object.values(fieldErrors).every((e) => e === null);

  function set(field: Field) {
    return (e: React.ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [field]: e.currentTarget.value }));
  }

  function fieldError(field: Field) {
    return showErrors ? fieldErrors[field] : null;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setShowErrors(true);
    if (!valid) return;

    setBusy(true);
    setError(null);
    try {
      await signUp(values.username.trim(), values.password, values.fullName.trim());
      onRegistered(values.username.trim());
    } catch (e) {
      setError(toRustMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{translateMessage(error)}</AlertDescription>
        </Alert>
      )}

      <FormField
        id="register-full-name"
        label={t("auth.fields.fullName")}
        value={values.fullName}
        onChange={set("fullName")}
        error={fieldError("fullName")}
        autoComplete="name"
        maxLength={100}
        autoFocus
      />
      <FormField
        id="register-username"
        label={t("auth.fields.username")}
        hint={t("auth.hints.username")}
        value={values.username}
        onChange={set("username")}
        error={fieldError("username")}
        autoComplete="username"
        maxLength={32}
        dir="ltr"
      />
      <FormField
        id="register-password"
        type="password"
        label={t("auth.fields.password")}
        hint={t("auth.hints.password")}
        value={values.password}
        onChange={set("password")}
        error={fieldError("password")}
        autoComplete="new-password"
        dir="ltr"
      />
      <FormField
        id="register-confirm-password"
        type="password"
        label={t("auth.fields.confirmPassword")}
        value={values.confirmPassword}
        onChange={set("confirmPassword")}
        error={fieldError("confirmPassword")}
        autoComplete="new-password"
        dir="ltr"
      />

      <Button type="submit" disabled={busy}>
        {busy && <LoaderCircleIcon className="animate-spin" />}
        {busy ? t("auth.register.working") : t("auth.register.submit")}
      </Button>
    </form>
  );
}
