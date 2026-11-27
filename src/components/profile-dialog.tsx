import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { profileSchema, type ProfileValues } from "@/auth/schemas";
import { getProfile, updateProfile, type Profile } from "@/auth/session";
import { setSession } from "@/auth/store";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { fieldError } from "@/lib/form";
import { FormField } from "@/components/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
 * The logged-in user's own account, from the server: the full name and mobile
 * number can be changed; the username and identification code are shown but
 * fixed. Opened from the user menu (src/components/user-menu.tsx).
 */
export function ProfileDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-md">
        {/* Loaded again each time the dialog opens. */}
        {open && <ProfileLoader onSaved={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function ProfileLoader({ onSaved }: { onSaved: () => void }) {
  const { t } = useTranslation();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<RustMessage | null>(null);

  useEffect(() => {
    let current = true;
    getProfile().then(
      (loaded) => current && setProfile(loaded),
      (e) => current && setError(toRustMessage(e)),
    );
    return () => {
      current = false;
    };
  }, []);

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("account.profile.title")}</DialogTitle>
        <DialogDescription>{t("account.profile.description")}</DialogDescription>
      </DialogHeader>
      {profile ? (
        <ProfileForm profile={profile} onSaved={onSaved} />
      ) : error ? (
        <Alert variant="destructive">
          <AlertDescription>{translateMessage(error)}</AlertDescription>
        </Alert>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" />
          {t("account.profile.loading")}
        </p>
      )}
    </>
  );
}

function ProfileForm({ profile, onSaved }: { profile: Profile; onSaved: () => void }) {
  const { t } = useTranslation();
  const [error, setError] = useState<RustMessage | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ProfileValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: { fullName: profile.fullName, phone: profile.phone },
  });

  // `values` are already checked and trimmed by the schema.
  async function submit(values: ProfileValues) {
    setError(null);
    try {
      setSession(await updateProfile(values));
      onSaved();
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

      <FormField id="profile-username" label={t("auth.fields.username")} value={profile.username} readOnly latin />
      {profile.identity && (
        <FormField
          id="profile-identity-code"
          label={t("setup.fields.identityCode")}
          value={profile.identity}
          readOnly
          latin
        />
      )}
      <FormField
        id="profile-full-name"
        label={t("auth.fields.fullName")}
        error={fieldError(errors.fullName)}
        autoComplete="name"
        maxLength={100}
        autoFocus
        {...register("fullName")}
      />
      <FormField
        id="profile-phone"
        type="tel"
        label={t("setup.fields.ownerPhone")}
        error={fieldError(errors.phone)}
        autoComplete="tel"
        maxLength={16}
        latin
        {...register("phone")}
      />

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            {t("account.profile.cancel")}
          </Button>
        </DialogClose>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <LoaderCircleIcon className="animate-spin" />}
          {isSubmitting ? t("account.profile.saving") : t("account.profile.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}
