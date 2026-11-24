import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { open as openFile } from "@tauri-apps/plugin-dialog";
import { ArchiveRestoreIcon, CircleCheckIcon, FileIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { restoreDatabaseSchema, type RestoreDatabaseValues } from "@/auth/schemas";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { BACKUP_EXTENSION, fileName, restoreDatabase } from "@/lib/backup";
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
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * Replaces all clinic data on this computer with a backup (managers only).
 * Needs the backup's password and recovery key, which only the user has.
 */
export function RestoreDatabaseDialog() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [restored, setRestored] = useState(false);

  function changeOpen(next: boolean) {
    setOpen(next);
    if (!next) setRestored(false);
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <ArchiveRestoreIcon data-icon="inline-start" />
          {t("backup.restore.open")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-md">
        {restored ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{t("backup.restore.title")}</DialogTitle>
            </DialogHeader>
            <Alert>
              <CircleCheckIcon />
              <AlertDescription>{t("backup.restore.success")}</AlertDescription>
            </Alert>
            <DialogFooter>
              <DialogClose asChild>
                <Button>{t("backup.restore.close")}</Button>
              </DialogClose>
            </DialogFooter>
          </div>
        ) : (
          // A new form each time the dialog opens, so no secret stays behind.
          open && <RestoreForm onRestored={() => setRestored(true)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RestoreForm({ onRestored }: { onRestored: () => void }) {
  const { t } = useTranslation();
  const [error, setError] = useState<RustMessage | null>(null);
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    resetField,
    formState: { errors, isSubmitting },
  } = useForm<RestoreDatabaseValues>({
    resolver: zodResolver(restoreDatabaseSchema),
    defaultValues: { path: "", recoveryKey: "", password: "" },
  });
  const path = watch("path");

  async function chooseFile() {
    try {
      const chosen = await openFile({
        title: t("backup.restore.openTitle"),
        multiple: false,
        directory: false,
        filters: [{ name: t("backup.fileType"), extensions: [BACKUP_EXTENSION] }],
      });
      if (chosen) setValue("path", chosen, { shouldValidate: true });
    } catch (e) {
      setError(toRustMessage(e));
    }
  }

  async function submit(values: RestoreDatabaseValues) {
    setError(null);
    try {
      await restoreDatabase(values.path, values.password, values.recoveryKey);
      onRestored();
    } catch (e) {
      setError(toRustMessage(e));
      resetField("password");
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit(submit)} noValidate>
      <DialogHeader>
        <DialogTitle>{t("backup.restore.title")}</DialogTitle>
        <DialogDescription>{t("backup.restore.description")}</DialogDescription>
      </DialogHeader>

      <Alert variant="destructive">
        <TriangleAlertIcon />
        <AlertDescription>{t("backup.restore.warning")}</AlertDescription>
      </Alert>

      <div className="flex flex-col gap-1.5">
        <span className="mb-1 text-sm font-medium">{t("backup.fields.file")}</span>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={chooseFile} disabled={isSubmitting}>
            <FileIcon data-icon="inline-start" />
            {t("backup.restore.chooseFile")}
          </Button>
          <bdi className="truncate text-xs text-muted-foreground" title={path || undefined}>
            {path ? fileName(path) : t("backup.restore.noFile")}
          </bdi>
        </div>
        {errors.path && <p className="text-xs text-destructive">{fieldError(errors.path)}</p>}
      </div>

      <FormField
        id="restore-recovery-key"
        label={t("backup.fields.recoveryKey")}
        hint={t("backup.hints.recoveryKey")}
        error={fieldError(errors.recoveryKey)}
        autoComplete="off"
        className="font-mono"
        latin
        {...register("recoveryKey")}
      />
      <FormField
        id="restore-password"
        type="password"
        label={t("backup.fields.password")}
        error={fieldError(errors.password)}
        autoComplete="off"
        latin
        {...register("password")}
      />

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{translateMessage(error)}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" variant="destructive" disabled={isSubmitting}>
        {isSubmitting && <LoaderCircleIcon className="animate-spin" />}
        {isSubmitting ? t("backup.restore.working") : t("backup.restore.submit")}
      </Button>
    </form>
  );
}
