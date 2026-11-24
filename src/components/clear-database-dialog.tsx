import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { clearDatabaseSchema, type ClearDatabaseValues } from "@/auth/schemas";
import { sessionClosed } from "@/auth/store";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { clearDatabase } from "@/lib/backup";
import { fieldError } from "@/lib/form";
import { AccountPasswordField } from "@/components/account-password-field";
import { FormField } from "@/components/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * Deletes all clinic data on this computer (managers only). The user confirms by
 * typing their own username and account password. Rust then logs out, and the
 * app goes to the login screen, which says why; the manager keeps their role.
 * Opened from the Database page (src/pages/database-page.tsx).
 */
export function ClearDatabaseDialog({
  open,
  onOpenChange,
  username,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  username: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-md">
        {/* A new form each time the dialog opens, so the confirmation is typed again. */}
        {open && <ClearForm username={username} />}
      </DialogContent>
    </Dialog>
  );
}

function ClearForm({ username }: { username: string }) {
  const { t } = useTranslation();
  const [error, setError] = useState<RustMessage | null>(null);
  const {
    register,
    handleSubmit,
    resetField,
    formState: { errors, isSubmitting },
  } = useForm<ClearDatabaseValues>({
    resolver: zodResolver(clearDatabaseSchema(username)),
    defaultValues: { confirmation: "", accountPassword: "" },
  });

  async function submit(values: ClearDatabaseValues) {
    setError(null);
    try {
      await clearDatabase(values.accountPassword);
      // Rust has logged out: the app layout now goes to the login screen.
      sessionClosed("database.clear.loggedOut");
    } catch (e) {
      setError(toRustMessage(e));
      resetField("accountPassword");
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit(submit)} noValidate>
      <DialogHeader>
        <DialogTitle>{t("database.clear.title")}</DialogTitle>
        <DialogDescription>{t("database.clear.description")}</DialogDescription>
      </DialogHeader>

      <Alert variant="destructive">
        <TriangleAlertIcon />
        <AlertDescription>{t("database.clear.warning")}</AlertDescription>
      </Alert>

      <FormField
        id="clear-confirmation"
        label={t("database.clear.confirmLabel", { username })}
        error={fieldError(errors.confirmation)}
        autoComplete="off"
        spellCheck={false}
        autoFocus
        latin
        {...register("confirmation")}
      />
      <AccountPasswordField
        id="clear-account-password"
        error={fieldError(errors.accountPassword)}
        {...register("accountPassword")}
      />

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{translateMessage(error)}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" variant="destructive" disabled={isSubmitting}>
        {isSubmitting && <LoaderCircleIcon className="animate-spin" />}
        {isSubmitting ? t("database.clear.working") : t("database.clear.submit")}
      </Button>
    </form>
  );
}
