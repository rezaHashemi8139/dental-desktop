import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CircleCheckIcon, LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { memberSchema, type MemberValues } from "@/auth/schemas";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { fieldError } from "@/lib/form";
import { createMember, type CreatedMember } from "@/lib/members";
import { FormField } from "@/components/form-field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Adds a user to the clinic: an account on the server (only this person's own
 * details go there) with a temporary password they change at their first login,
 * and access to this clinic. Clinic admins only, online only. Opened from the
 * work hours page.
 */
export function MemberDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (member: CreatedMember) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-md">
        {/* A new form each time the dialog opens. */}
        {open && <MemberForm onCreated={onCreated} />}
      </DialogContent>
    </Dialog>
  );
}

function MemberForm({ onCreated }: { onCreated: (member: CreatedMember) => void }) {
  const { t } = useTranslation();
  const [error, setError] = useState<RustMessage | null>(null);
  // Shown once created, with what to tell the new user.
  const [created, setCreated] = useState<{ member: CreatedMember; temporaryPassword: string } | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<MemberValues>({
    resolver: zodResolver(memberSchema),
    defaultValues: { fullName: "", identityCode: "", phone: "", email: "", username: "", temporaryPassword: "" },
  });

  // `values` are already checked and trimmed by the schema.
  async function submit(values: MemberValues) {
    setError(null);
    try {
      const member = await createMember({
        fullName: values.fullName,
        identity: values.identityCode,
        phone: values.phone,
        email: values.email,
        username: values.username,
        temporaryPassword: values.temporaryPassword,
      });
      setCreated({ member, temporaryPassword: values.temporaryPassword });
      onCreated(member);
    } catch (e) {
      setError(toRustMessage(e));
    }
  }

  if (created) {
    const { member, temporaryPassword } = created;
    return (
      <>
        <DialogHeader>
          <DialogTitle>{t("members.created.title")}</DialogTitle>
          <DialogDescription>{member.fullName}</DialogDescription>
        </DialogHeader>
        <Alert>
          <CircleCheckIcon />
          <AlertTitle>{member.created ? t("members.created.newAccount") : t("members.created.existingAccount")}</AlertTitle>
          <AlertDescription>
            {member.created
              ? t("members.created.newAccountHint")
              : t("members.created.existingAccountHint", { username: member.username })}
          </AlertDescription>
        </Alert>
        {member.created && (
          <div className="flex flex-col gap-3">
            <FormField id="member-created-username" label={t("auth.fields.username")} value={member.username} readOnly latin />
            <FormField
              id="member-created-password"
              label={t("members.fields.temporaryPassword")}
              value={temporaryPassword}
              readOnly
              latin
            />
          </div>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button">{t("members.created.close")}</Button>
          </DialogClose>
        </DialogFooter>
      </>
    );
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit(submit)} noValidate>
      <DialogHeader>
        <DialogTitle>{t("members.dialog.title")}</DialogTitle>
        <DialogDescription>{t("members.dialog.description")}</DialogDescription>
      </DialogHeader>

      <FormField
        id="member-full-name"
        label={t("auth.fields.fullName")}
        error={fieldError(errors.fullName)}
        autoComplete="off"
        maxLength={100}
        autoFocus
        {...register("fullName")}
      />
      <FormField
        id="member-identity-code"
        label={t("setup.fields.identityCode")}
        hint={t("setup.hints.identityCode")}
        error={fieldError(errors.identityCode)}
        maxLength={24}
        latin
        {...register("identityCode")}
      />
      <FormField
        id="member-phone"
        type="tel"
        label={t("setup.fields.ownerPhone")}
        error={fieldError(errors.phone)}
        autoComplete="off"
        maxLength={16}
        latin
        {...register("phone")}
      />
      <FormField
        id="member-email"
        type="email"
        label={t("setup.fields.ownerEmail")}
        error={fieldError(errors.email)}
        autoComplete="off"
        maxLength={254}
        latin
        {...register("email")}
      />
      <FormField
        id="member-username"
        label={t("auth.fields.username")}
        hint={t("auth.hints.username")}
        error={fieldError(errors.username)}
        autoComplete="off"
        maxLength={32}
        latin
        {...register("username")}
      />
      {/* Shown as typed: the admin passes it on to the new user. */}
      <FormField
        id="member-temporary-password"
        label={t("members.fields.temporaryPassword")}
        hint={t("members.hints.temporaryPassword")}
        error={fieldError(errors.temporaryPassword)}
        autoComplete="off"
        latin
        {...register("temporaryPassword")}
      />

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{translateMessage(error)}</AlertDescription>
        </Alert>
      )}

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={isSubmitting}>
            {t("workHours.dialog.cancel")}
          </Button>
        </DialogClose>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <LoaderCircleIcon className="animate-spin" />}
          {isSubmitting ? t("members.dialog.working") : t("members.dialog.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
