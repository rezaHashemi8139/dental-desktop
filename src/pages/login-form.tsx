import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { login, PASSWORD_CHANGE_REQUIRED, type Session } from "@/auth/session";
import { loginSchema, type LoginValues } from "@/auth/schemas";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { fieldError } from "@/lib/form";
import { FormField } from "@/components/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface LoginFormProps {
  initialUsername?: string;
  notice?: string | null;
  /** Shown until the next attempt, e.g. why the server ended the last session. */
  initialError?: RustMessage | null;
  onLoggedIn: (session: Session) => void;
  /** The account still has a temporary password: a new one must be chosen first. */
  onPasswordChangeRequired: (username: string, password: string) => void;
}

export function LoginForm({
  initialUsername = "",
  notice,
  initialError = null,
  onLoggedIn,
  onPasswordChangeRequired,
}: LoginFormProps) {
  const { t } = useTranslation();
  const [error, setError] = useState<RustMessage | null>(initialError);
  const {
    register,
    handleSubmit,
    resetField,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: initialUsername, password: "" },
  });

  async function submit(values: LoginValues) {
    setError(null);
    try {
      onLoggedIn(await login(values.username, values.password));
    } catch (e) {
      const message = toRustMessage(e);
      if (message.key === PASSWORD_CHANGE_REQUIRED) {
        onPasswordChangeRequired(values.username, values.password);
        return;
      }
      setError(message);
      resetField("password");
      setFocus("password");
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit(submit)} noValidate>
      {notice && !error && (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{translateMessage(error)}</AlertDescription>
        </Alert>
      )}

      <FormField
        id="login-username"
        label={t("auth.fields.username")}
        error={fieldError(errors.username)}
        autoComplete="username"
        autoFocus={!initialUsername}
        latin
        {...register("username")}
      />
      <FormField
        id="login-password"
        type="password"
        label={t("auth.fields.password")}
        error={fieldError(errors.password)}
        autoComplete="current-password"
        autoFocus={!!initialUsername}
        latin
        {...register("password")}
      />

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting && <LoaderCircleIcon className="animate-spin" />}
        {isSubmitting ? t("auth.login.working") : t("auth.login.submit")}
      </Button>
    </form>
  );
}
