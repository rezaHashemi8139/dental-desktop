import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { BellIcon, LoaderCircleIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { reminderSchema, type ReminderValues } from "@/auth/schemas";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { fieldError } from "@/lib/form";
import { addReminder, deleteReminder, nextIsoDay, REMINDER_MAX_LENGTH, useReminders } from "@/lib/reminders";
import { TextareaField } from "@/components/textarea-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * The logged-in user's reminders of one day, opened from a day of the home
 * calendar: lists them, each can be deleted, and adds any number more.
 * Saved on this computer only (src/lib/reminders.ts).
 */
export function ReminderDialog({
  day,
  dayLabel,
  onOpenChange,
}: {
  /** Gregorian "YYYY-MM-DD"; null while closed. */
  day: string | null;
  /** The day as shown to the user. */
  dayLabel: string;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={day !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* A new form for each day opened. */}
        {day && <ReminderForm key={day} day={day} dayLabel={dayLabel} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function ReminderForm({ day, dayLabel, onClose }: { day: string; dayLabel: string; onClose: () => void }) {
  const { t } = useTranslation();
  const reminders = useReminders({ fromDay: day, toDay: nextIsoDay(day) }).get(day) ?? [];
  const [error, setError] = useState<RustMessage | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ReminderValues>({ resolver: zodResolver(reminderSchema), defaultValues: { text: "" } });

  async function submit(values: ReminderValues) {
    setError(null);
    try {
      await addReminder(day, values.text);
      // Ready for the next one.
      reset({ text: "" });
    } catch (e) {
      setError(toRustMessage(e));
    }
  }

  async function remove(id: string) {
    setError(null);
    setDeleting(id);
    try {
      await deleteReminder(id);
    } catch (e) {
      setError(toRustMessage(e));
    } finally {
      setDeleting(null);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit(submit)} noValidate>
      <DialogHeader>
        <DialogTitle>{t("reminders.dialog.title")}</DialogTitle>
        <DialogDescription>{dayLabel}</DialogDescription>
      </DialogHeader>

      {reminders.length > 0 ? (
        <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto">
          {reminders.map((reminder) => (
            <li key={reminder.id} className="flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-sm">
              <BellIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 wrap-break-word whitespace-pre-line">{reminder.text}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t("reminders.dialog.delete")}
                title={t("reminders.dialog.delete")}
                disabled={deleting !== null}
                onClick={() => remove(reminder.id)}
              >
                {deleting === reminder.id ? <LoaderCircleIcon className="animate-spin" /> : <Trash2Icon />}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t("reminders.dialog.none")}</p>
      )}

      <TextareaField
        id="reminder-text"
        label={t("reminders.dialog.new")}
        error={fieldError(errors.text)}
        maxLength={REMINDER_MAX_LENGTH}
        rows={3}
        autoFocus
        {...register("text")}
      />
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{translateMessage(error)}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
          {t("reminders.dialog.close")}
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? <LoaderCircleIcon className="animate-spin" /> : <PlusIcon />}
          {t("reminders.dialog.add")}
        </Button>
      </DialogFooter>
    </form>
  );
}
