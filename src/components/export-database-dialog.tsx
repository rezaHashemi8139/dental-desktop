import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { save } from "@tauri-apps/plugin-dialog";
import { CheckIcon, CopyIcon, DatabaseBackupIcon, KeyRoundIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { exportDatabaseSchema, type ExportDatabaseValues } from "@/auth/schemas";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { BACKUP_EXTENSION, defaultBackupFileName, exportDatabase, fileName } from "@/lib/backup";
import { fieldError } from "@/lib/form";
import { FormField } from "@/components/form-field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/** What the user must keep after a successful export. */
interface ExportResult {
  recoveryKey: string;
  file: string;
}

/**
 * Saves an encrypted backup of the clinic database (managers only). The user
 * picks a password; once the file is saved the app shows the recovery key, once.
 * Neither is stored, so the dialog can only be closed after the user confirms
 * they have kept both.
 */
export function ExportDatabaseDialog() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);

  function changeOpen(next: boolean) {
    // The recovery key is on screen: only the confirm button closes the dialog.
    if (!next && result) return;
    setOpen(next);
  }

  function finish() {
    setResult(null);
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <DatabaseBackupIcon data-icon="inline-start" />
          {t("backup.export.open")}
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={!result} className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-md">
        {result ? (
          <ExportDone result={result} onDone={finish} />
        ) : (
          // A new form each time the dialog opens, so no password stays behind.
          open && <ExportForm onExported={setResult} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ExportForm({ onExported }: { onExported: (result: ExportResult) => void }) {
  const { t } = useTranslation();
  const [error, setError] = useState<RustMessage | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ExportDatabaseValues>({
    resolver: zodResolver(exportDatabaseSchema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  async function submit(values: ExportDatabaseValues) {
    setError(null);
    try {
      const path = await save({
        title: t("backup.export.saveTitle"),
        defaultPath: defaultBackupFileName(),
        filters: [{ name: t("backup.fileType"), extensions: [BACKUP_EXTENSION] }],
      });
      if (!path) return; // Cancelled.
      onExported({ recoveryKey: await exportDatabase(path, values.password), file: fileName(path) });
    } catch (e) {
      setError(toRustMessage(e));
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit(submit)} noValidate>
      <DialogHeader>
        <DialogTitle>{t("backup.export.title")}</DialogTitle>
        <DialogDescription>{t("backup.export.description")}</DialogDescription>
      </DialogHeader>

      <Alert>
        <TriangleAlertIcon />
        <AlertTitle>{t("backup.secretsTitle")}</AlertTitle>
        <AlertDescription>{t("backup.export.warning")}</AlertDescription>
      </Alert>

      <FormField
        id="export-password"
        type="password"
        label={t("backup.fields.password")}
        hint={t("auth.hints.password")}
        error={fieldError(errors.password)}
        autoComplete="new-password"
        autoFocus
        latin
        {...register("password")}
      />
      <FormField
        id="export-confirm-password"
        type="password"
        label={t("backup.fields.confirmPassword")}
        error={fieldError(errors.confirmPassword)}
        autoComplete="new-password"
        latin
        {...register("confirmPassword")}
      />

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{translateMessage(error)}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting && <LoaderCircleIcon className="animate-spin" />}
        {isSubmitting ? t("backup.export.working") : t("backup.export.submit")}
      </Button>
    </form>
  );
}

/** Keeps the "copied" tick visible this long. */
const COPIED_MS = 2000;

function ExportDone({ result, onDone }: { result: ExportResult; onDone: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(result.recoveryKey);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    } catch (e) {
      console.warn("Could not copy the recovery key:", e);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{t("backup.export.doneTitle")}</DialogTitle>
        <DialogDescription>{t("backup.export.doneDescription", { file: result.file })}</DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="export-recovery-key" className="mb-1 flex items-center gap-1.5 text-sm font-medium">
          <KeyRoundIcon className="size-4" />
          {t("backup.fields.recoveryKey")}
        </label>
        <div className="flex gap-2">
          <Input
            id="export-recovery-key"
            readOnly
            value={result.recoveryKey}
            dir="ltr"
            spellCheck={false}
            className="font-mono"
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={copy}
            aria-label={t(copied ? "backup.export.copied" : "backup.export.copy")}
            title={t(copied ? "backup.export.copied" : "backup.export.copy")}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        </div>
      </div>

      <Alert variant="destructive">
        <TriangleAlertIcon />
        <AlertDescription>{t("backup.export.keepWarning")}</AlertDescription>
      </Alert>

      <DialogFooter>
        <Button onClick={onDone}>{t("backup.export.confirm")}</Button>
      </DialogFooter>
    </div>
  );
}
