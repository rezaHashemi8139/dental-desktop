import { useState, type ComponentProps } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ClockIcon, LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { workHoursSchema, type WorkHoursFormValues, type WorkHoursValues } from "@/auth/schemas";
import { localIsoDate } from "@/i18n/calendar";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { fieldError } from "@/lib/form";
import { saveWorkHours, type WorkHours } from "@/lib/work-hours";
import { DateField } from "@/components/date-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Adds an entry of working hours, or edits one (`entry`): the day, when the user
 * came in and, once they have left, when. Each time can be typed or filled with
 * "now". A new entry may be added only once the previous one has its exit (Rust
 * checks it). Saved on this computer only. Opened from the work hours page.
 */
export function WorkHoursDialog({
  open,
  onOpenChange,
  userId,
  userName,
  entry,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whose hours these are. */
  userId: string;
  userName: string;
  entry?: WorkHours;
  onSaved: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-md">
        {/* A new form each time the dialog opens. */}
        {open && (
          <WorkHoursForm
            userId={userId}
            userName={userName}
            entry={entry}
            onSaved={onSaved}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function WorkHoursForm({
  userId,
  userName,
  entry,
  onSaved,
  onCancel,
}: {
  userId: string;
  userName: string;
  entry?: WorkHours;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<RustMessage | null>(null);
  const {
    register,
    handleSubmit,
    control,
    getValues,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<WorkHoursFormValues, unknown, WorkHoursValues>({
    resolver: zodResolver(workHoursSchema),
    defaultValues: {
      day: entry ? localIsoDate(entry.startedAt) : localIsoDate(Date.now()),
      start: entry ? timeOfDay(entry.startedAt) : "",
      end: entry?.endedAt ? timeOfDay(entry.endedAt) : "",
    },
  });

  /** Fills a time with now; a new or empty day becomes today. */
  function fillNow(field: "start" | "end") {
    const now = Date.now();
    const today = localIsoDate(now);
    // The end of a shift that started yesterday stays on yesterday's day.
    if (!getValues("day") || (field === "start" && !entry)) setValue("day", today, { shouldValidate: true });
    setValue(field, timeOfDay(now), { shouldValidate: true });
  }

  // `values` are already checked and trimmed by the schema.
  async function submit(values: WorkHoursValues) {
    setError(null);
    const startedAt = atTime(values.day!, values.start);
    let endedAt: number | null = null;
    if (values.end) {
      endedAt = atTime(values.day!, values.end);
      // An end earlier than the start is on the next day (a shift past midnight).
      if (endedAt <= startedAt) endedAt = atTime(values.day!, values.end, 1);
    }
    try {
      await saveWorkHours({ userId, startedAt, endedAt }, entry?.id);
      onSaved();
    } catch (e) {
      setError(toRustMessage(e));
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit(submit)} noValidate>
      <DialogHeader>
        <DialogTitle>{entry ? t("workHours.dialog.editTitle") : t("workHours.dialog.addTitle")}</DialogTitle>
        <DialogDescription>{userName}</DialogDescription>
      </DialogHeader>

      <Controller
        control={control}
        name="day"
        render={({ field, fieldState }) => (
          <DateField
            id="work-hours-day"
            label={t("workHours.fields.day")}
            error={fieldError(fieldState.error)}
            value={field.value}
            onChange={field.onChange}
          />
        )}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TimeField
          id="work-hours-start"
          label={t("workHours.fields.start")}
          error={fieldError(errors.start)}
          onNow={() => fillNow("start")}
          {...register("start")}
        />
        <TimeField
          id="work-hours-end"
          label={t("workHours.fields.end")}
          error={fieldError(errors.end)}
          onNow={() => fillNow("end")}
          {...register("end")}
        />
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">{t("workHours.hints.end")}</p>

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

/** A time of day ("HH:MM", 24 hours) with a button that fills in the current time. */
function TimeField({
  id,
  label,
  error,
  onNow,
  ...inputProps
}: ComponentProps<typeof Input> & { id: string; label: string; error: string | null; onNow: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="mb-1">
        {label}
      </Label>
      <div className="flex gap-2">
        <Input
          id={id}
          type="time"
          dir="ltr"
          className="flex-1 rtl:text-end"
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          {...inputProps}
        />
        <Button type="button" variant="outline" onClick={onNow}>
          <ClockIcon data-icon="inline-start" />
          {t("workHours.now")}
        </Button>
      </div>
      {error && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** A timestamp's local time of day as "HH:MM". */
function timeOfDay(time: number): string {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Local time `hhmm` on the Gregorian day `iso`, `addDays` later. */
function atTime(iso: string, hhmm: string, addDays = 0): number {
  const [year, month, day] = iso.split("-").map(Number);
  const [hours, minutes] = hhmm.split(":").map(Number);
  return new Date(year, month - 1, day + addDays, hours, minutes).getTime();
}
