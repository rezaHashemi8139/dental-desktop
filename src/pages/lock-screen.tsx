import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircleIcon, LockOpenIcon, UsersIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { unlockSchema, type UnlockValues } from "@/auth/schemas";
import { unlockSession, type Session } from "@/auth/session";
import { setSession } from "@/auth/store";
import { useLogout } from "@/auth/use-logout";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { fieldError } from "@/lib/form";
import { AuthBackdrop } from "@/components/auth-backdrop";
import { FormField } from "@/components/form-field";
import { UserAvatar } from "@/components/user-menu";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { PageArea } from "@/pages/root-layout";
import { AUTH_CARD } from "./auth-layout";

/**
 * Shown in place of the sidebar and the page while the session is locked (user
 * menu → Lock): the user's name is shown, only the password is asked for, and
 * another user can log in instead (which logs this one out). Rust keeps clinic
 * data closed until it is unlocked, and logs out after too many wrong passwords
 * (the app layout then goes to the login screen, which says why).
 */
export function LockScreen({ session }: { session: Session }) {
  const { t } = useTranslation();
  const { logOut, busy: switching } = useLogout();
  const [error, setError] = useState<RustMessage | null>(null);
  const {
    register,
    handleSubmit,
    resetField,
    formState: { errors, isSubmitting },
  } = useForm<UnlockValues>({
    resolver: zodResolver(unlockSchema),
    defaultValues: { password: "" },
  });

  async function submit(values: UnlockValues) {
    setError(null);
    try {
      setSession(await unlockSession(values.password));
    } catch (e) {
      setError(toRustMessage(e));
      resetField("password");
    }
  }

  return (
    // Like the login screen (src/pages/auth-layout.tsx): its own stacking context for the backdrop.
    <div className="relative isolate flex min-w-0 flex-1">
      <AuthBackdrop />
      <PageArea>
        <Card className={cn("w-full max-w-sm", AUTH_CARD)}>
          <CardHeader className="justify-items-center text-center">
            <h2 className="sr-only">{t("account.lock.title")}</h2>
            <UserAvatar session={session} className="mb-2 size-16 text-2xl" />
            <CardTitle>{session.fullName || session.username}</CardTitle>
            <CardDescription dir="ltr">{session.username}</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="flex flex-col gap-4" onSubmit={handleSubmit(submit)} noValidate>
              <p className="text-center text-sm text-muted-foreground">{t("account.lock.description")}</p>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{translateMessage(error)}</AlertDescription>
                </Alert>
              )}
              <FormField
                id="unlock-password"
                type="password"
                label={t("auth.fields.password")}
                error={fieldError(errors.password)}
                autoComplete="current-password"
                autoFocus
                latin
                {...register("password")}
              />
              <Button type="submit" disabled={isSubmitting || switching}>
                {isSubmitting ? <LoaderCircleIcon className="animate-spin" /> : <LockOpenIcon data-icon="inline-start" />}
                {isSubmitting ? t("account.lock.unlocking") : t("account.lock.unlock")}
              </Button>
              <Button type="button" variant="ghost" onClick={logOut} disabled={isSubmitting || switching}>
                {switching ? <LoaderCircleIcon className="animate-spin" /> : <UsersIcon data-icon="inline-start" />}
                {t("account.lock.switchUser")}
              </Button>
            </form>
          </CardContent>
        </Card>
      </PageArea>
    </div>
  );
}
