import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  memberBirthDateSchema,
  type MemberBirthDateFormValues,
  type MemberBirthDateValues,
} from "@/auth/schemas";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { fieldError } from "@/lib/form";
import { setMemberBirthDate } from "@/lib/members";
import type { LocalUser } from "@/lib/patients";
import { DateField } from "@/components/date-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * A staff member's birth date, set by a clinic admin (src/lib/members.ts): it is
 * saved on their account on the server, so it needs the server. Their birthday
 * then shows on the home calendar. Opened from the work hours page.
 */
export function MemberBirthDateDialog({
  open,
  onOpenChange,
  user,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: LocalUser | null;
  onSaved: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* A new form each time the dialog opens. */}
        {open && user && <MemberBirthDateForm user={user} onSaved={onSaved} onCancel={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function MemberBirthDateForm({ user, onSaved, onCancel }: { user: LocalUser; onSaved: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [error, setError] = useState<RustMessage | null>(null);
  const {
    control,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<MemberBirthDateFormValues, unknown, MemberBirthDateValues>({
    resolver: zodResolver(memberBirthDateSchema),
    defaultValues: { birthDate: user.birthDate },
  });

  async function submit(values: MemberBirthDateValues) {
    setError(null);
    try {
      await setMemberBirthDate(user.id, values.birthDate ?? "");
      onSaved();
    } catch (e) {
      setError(toRustMessage(e));
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit(submit)} noValidate>
      <DialogHeader>
        <DialogTitle>{t("members.birthDate.title")}</DialogTitle>
        <DialogDescription>
          {t("members.birthDate.description", { name: user.fullName || user.username })}
        </DialogDescription>
      </DialogHeader>
      <Controller
        control={control}
        name="birthDate"
        render={({ field, fieldState }) => (
          <DateField
            id="member-birth-date"
            label={t("account.profile.birthDate")}
            error={fieldError(fieldState.error)}
            value={field.value}
            onChange={field.onChange}
            clearable
          />
        )}
      />
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{translateMessage(error)}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          {t("workHours.dialog.cancel")}
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <LoaderCircleIcon className="animate-spin" />}
          {isSubmitting ? t("workHours.dialog.saving") : t("workHours.dialog.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}
