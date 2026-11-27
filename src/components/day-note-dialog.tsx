import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { dayNoteSchema, type DayNoteValues } from "@/auth/schemas";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { fieldError } from "@/lib/form";
import { saveWorkDayNote } from "@/lib/work-hours";
import { TextareaField } from "@/components/textarea-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * A user's notes for one day of working hours; saving them empty removes them.
 * Saved on this computer only. Opened from the work hours page.
 */
export function DayNoteDialog({
  open,
  onOpenChange,
  userId,
  day,
  dayLabel,
  notes,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  /** Gregorian "YYYY-MM-DD". */
  day: string;
  /** The day as shown to the user. */
  dayLabel: string;
  /** The notes so far ("" for none). */
  notes: string;
  onSaved: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* A new form each time the dialog opens. */}
        {open && (
          <DayNoteForm
            userId={userId}
            day={day}
            dayLabel={dayLabel}
            notes={notes}
            onSaved={onSaved}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DayNoteForm({
  userId,
  day,
  dayLabel,
  notes,
  onSaved,
  onCancel,
}: {
  userId: string;
  day: string;
  dayLabel: string;
  notes: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<RustMessage | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<DayNoteValues>({ resolver: zodResolver(dayNoteSchema), defaultValues: { notes } });

  async function submit(values: DayNoteValues) {
    setError(null);
    try {
      await saveWorkDayNote(userId, day, values.notes);
      onSaved();
    } catch (e) {
      setError(toRustMessage(e));
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit(submit)} noValidate>
      <DialogHeader>
        <DialogTitle>{t("workHours.dayNote.title")}</DialogTitle>
        <DialogDescription>{dayLabel}</DialogDescription>
      </DialogHeader>
      <TextareaField
        id="day-note"
        label={t("workHours.fields.notes")}
        hint={t("workHours.dayNote.hint")}
        error={fieldError(errors.notes)}
        maxLength={1000}
        rows={4}
        autoFocus
        {...register("notes")}
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
