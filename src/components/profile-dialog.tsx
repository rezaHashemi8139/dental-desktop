import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CircleCheckIcon, KeyRoundIcon, LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  changeOwnPasswordSchema,
  profileSchema,
  type ChangeOwnPasswordValues,
  type ProfileFormValues,
  type ProfileValues,
} from "@/auth/schemas";
import { changeOwnPassword, getProfile, updateProfile, type Profile } from "@/auth/session";
import { setSession } from "@/auth/store";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { fieldError } from "@/lib/form";
import { DateField } from "@/components/date-field";
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
 * The logged-in user's own account, from the server: the full name, mobile
 * number, email and birth date (birthdays on the home calendar) can be changed; the username and identification code are shown but
 * fixed. The password can be changed too, in a second view of the dialog.
 * Everything here needs the server. Opened from the user menu (src/components/user-menu.tsx).
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
  const [view, setView] = useState<"profile" | "password">("profile");
  const [passwordChanged, setPasswordChanged] = useState(false);

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
        <DialogTitle>{view === "password" ? t("account.password.title") : t("account.profile.title")}</DialogTitle>
        <DialogDescription>
          {view === "password" ? t("account.password.description") : t("account.profile.description")}
        </DialogDescription>
      </DialogHeader>
      {profile && view === "password" ? (
        <PasswordForm
          onBack={() => setView("profile")}
          onChanged={() => {
            setPasswordChanged(true);
            setView("profile");
          }}
        />
      ) : profile ? (
        <ProfileForm
          profile={profile}
          passwordChanged={passwordChanged}
          onChangePassword={() => {
            setPasswordChanged(false);
            setView("password");
          }}
          onSaved={onSaved}
        />
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

interface ProfileFormProps {
  profile: Profile;
  /** The password was just changed: says so above the form. */
  passwordChanged: boolean;
  onChangePassword: () => void;
  onSaved: () => void;
}

function ProfileForm({ profile, passwordChanged, onChangePassword, onSaved }: ProfileFormProps) {
  const { t } = useTranslation();
  const [error, setError] = useState<RustMessage | null>(null);
  const {
    register,
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ProfileFormValues, unknown, ProfileValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: { fullName: profile.fullName, phone: profile.phone, email: profile.email, birthDate: profile.birthDate },
  });

  // `values` are already checked and trimmed by the schema.
  async function submit(values: ProfileValues) {
    setError(null);
    try {
      setSession(await updateProfile({ ...values, birthDate: values.birthDate ?? "" }));
      onSaved();
    } catch (e) {
      setError(toRustMessage(e));
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit(submit)} noValidate>
      {passwordChanged && (
        <Alert variant="info">
          <CircleCheckIcon />
          <AlertDescription>{t("account.password.changed")}</AlertDescription>
        </Alert>
      )}
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
      <FormField
        id="profile-email"
        type="email"
        label={t("setup.fields.ownerEmail")}
        error={fieldError(errors.email)}
        autoComplete="email"
        maxLength={254}
        latin
        {...register("email")}
      />
      <Controller
        control={control}
        name="birthDate"
        render={({ field, fieldState }) => (
          <DateField
            id="profile-birth-date"
            label={t("account.profile.birthDate")}
            error={fieldError(fieldState.error)}
            value={field.value}
            onChange={field.onChange}
            clearable
          />
        )}
      />
      <Button type="button" variant="outline" className="self-start" onClick={onChangePassword}>
        <KeyRoundIcon />
        {t("account.password.open")}
      </Button>

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

/**
 * The user's own password: the current one, then the new one twice. Rust changes it
 * on the server and logs in again with it, so the session goes on. If that login
 * fails, the session ends and the login screen asks for the new password.
 */
function PasswordForm({ onBack, onChanged }: { onBack: () => void; onChanged: () => void }) {
  const { t } = useTranslation();
  const [error, setError] = useState<RustMessage | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<ChangeOwnPasswordValues>({
    resolver: zodResolver(changeOwnPasswordSchema),
    defaultValues: { currentPassword: "", password: "", confirmPassword: "" },
  });

  async function submit(values: ChangeOwnPasswordValues) {
    setError(null);
    try {
      setSession(await changeOwnPassword(values.currentPassword, values.password));
      onChanged();
    } catch (e) {
      setError(toRustMessage(e));
      reset();
      setFocus("currentPassword");
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
        id="profile-current-password"
        type="password"
        label={t("account.password.currentPassword")}
        error={fieldError(errors.currentPassword)}
        autoComplete="current-password"
        autoFocus
        latin
        {...register("currentPassword")}
      />
      <FormField
        id="profile-new-password"
        type="password"
        label={t("auth.fields.newPassword")}
        hint={t("auth.hints.password")}
        error={fieldError(errors.password)}
        autoComplete="new-password"
        latin
        {...register("password")}
      />
      <FormField
        id="profile-confirm-password"
        type="password"
        label={t("auth.fields.confirmNewPassword")}
        error={fieldError(errors.confirmPassword)}
        autoComplete="new-password"
        latin
        {...register("confirmPassword")}
      />

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onBack} disabled={isSubmitting}>
          {t("account.password.back")}
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <LoaderCircleIcon className="animate-spin" />}
          {isSubmitting ? t("account.password.saving") : t("account.password.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}
