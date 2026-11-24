import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { KeyRoundIcon, LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { changePassword, login, type Session } from "@/auth/session";
import { changePasswordSchema, type ChangePasswordValues } from "@/auth/schemas";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { fieldError } from "@/lib/form";
import { FormField } from "@/components/form-field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface ChangePasswordFormProps {
  username: string;
  /** The temporary password, as just typed at login. Kept only while this form is shown. */
  currentPassword: string;
  onLoggedIn: (session: Session) => void;
  /**
   * Back to the login form: `changed` once the new password is saved (the login
   * with it may still fail, e.g. no subscription), with that login's error if any.
   */
  onBack: (changed: boolean, error?: RustMessage) => void;
}

/**
 * Shown in place of the login form when the account still has a temporary
 * password (created by a clinic admin): the user chooses their own, then is
 * logged in with it.
 */
export function ChangePasswordForm({ username, currentPassword, onLoggedIn, onBack }: ChangePasswordFormProps) {
  const { t } = useTranslation();
  const [error, setError] = useState<RustMessage | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<ChangePasswordValues>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  async function submit(values: ChangePasswordValues) {
    setError(null);
    try {
      await changePassword(username, currentPassword, values.password);
    } catch (e) {
      setError(toRustMessage(e));
      reset();
      setFocus("password");
      return;
    }
    try {
      onLoggedIn(await login(username, values.password));
    } catch (e) {
      // Saved, but logging in failed: the login form says why, and takes the new password.
      onBack(true, toRustMessage(e));
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit(submit)} noValidate>
      <Alert variant="info">
        <KeyRoundIcon />
        <AlertTitle>{t("auth.changePassword.title")}</AlertTitle>
        <AlertDescription>{t("auth.changePassword.description")}</AlertDescription>
      </Alert>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{translateMessage(error)}</AlertDescription>
        </Alert>
      )}

      <FormField
        id="change-password-username"
        label={t("auth.fields.username")}
        value={username}
        readOnly
        autoComplete="username"
        latin
      />
      <FormField
        id="change-password-new"
        type="password"
        label={t("auth.fields.newPassword")}
        hint={t("auth.hints.password")}
        error={fieldError(errors.password)}
        autoComplete="new-password"
        autoFocus
        latin
        {...register("password")}
      />
      <FormField
        id="change-password-confirm"
        type="password"
        label={t("auth.fields.confirmNewPassword")}
        error={fieldError(errors.confirmPassword)}
        autoComplete="new-password"
        latin
        {...register("confirmPassword")}
      />

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting && <LoaderCircleIcon className="animate-spin" />}
        {isSubmitting ? t("auth.changePassword.working") : t("auth.changePassword.submit")}
      </Button>
      <Button type="button" variant="ghost" onClick={() => onBack(false)} disabled={isSubmitting}>
        {t("auth.changePassword.back")}
      </Button>
    </form>
  );
}
