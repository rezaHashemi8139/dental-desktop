import { useEffect, useState, type ComponentProps } from "react";
import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ClockIcon, LoaderCircleIcon, PlusIcon, XIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { workHoursSchema, type WorkHoursFormValues, type WorkHoursValues } from "@/auth/schemas";
import { localIsoDate } from "@/i18n/calendar";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { fieldError } from "@/lib/form";
import { listWorkHours, localMidnight, nextDay, replaceWorkDay, type EntryTimes } from "@/lib/work-hours";
import { DateField } from "@/components/date-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/**
 * One day of a user's entries and exits: picking a date loads what that day
 * already has as rows, which can be changed, removed or added to, then saved
 * together in place of the day's old ones (all or none). Each time can be typed,
 * or filled with "now" on today. Rows may not overlap (checked here, and by Rust
 * against the other days too). Saved on this computer only. Opened from the work
 * hours page.
 */
export function WorkHoursDialog({
  open,
  onOpenChange,
  userId,
  userName,
  day,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whose hours these are. */
  userId: string;
  userName: string;
  /** The day to open on (Gregorian "YYYY-MM-DD"). */
  day: string;
  onSaved: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
        {/* A new form each time the dialog opens. */}
        {open && (
          <DayForm userId={userId} userName={userName} day={day} onSaved={onSaved} onCancel={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DayForm({
  userId,
  userName,
  day: initialDay,
  onSaved,
  onCancel,
}: {
  userId: string;
  userName: string;
  day: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<RustMessage | null>(null);
  // The day whose rows are shown; null while they load.
  const [loadedDay, setLoadedDay] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    control,
    getValues,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<WorkHoursFormValues, unknown, WorkHoursValues>({
    resolver: zodResolver(workHoursSchema),
    defaultValues: { day: initialDay, rows: [] },
  });
  const rows = useFieldArray({ control, name: "rows" });
  const { replace } = rows;
  const day = useWatch({ control, name: "day" });

  // A (complete) date picked: its rows are what the day already has.
  useEffect(() => {
    if (!day) return;
    let current = true;
    setLoadedDay(null);
    setError(null);
    listWorkHours(userId, { start: localMidnight(day), end: localMidnight(nextDay(day)) }).then(
      (found) => {
        if (!current) return;
        replace(
          found.entries.map((entry) => ({
            start: timeOfDay(entry.startedAt),
            end: entry.endedAt ? timeOfDay(entry.endedAt) : "",
          })),
        );
        setLoadedDay(day);
      },
      (e) => current && setError(toRustMessage(e)),
    );
    return () => {
      current = false;
    };
  }, [day, userId, replace]);

  const isToday = !!day && day === localIsoDate(Date.now());

  function fillNow(index: number, field: "start" | "end") {
    setValue(`rows.${index}.${field}`, timeOfDay(Date.now()), { shouldValidate: true });
  }

  /** Another row, starting where the last one ended. */
  function addRow() {
    const current = getValues("rows");
    rows.append({ start: current[current.length - 1]?.end ?? "", end: "" });
  }

  // `values` are already checked by the schema.
  async function submit(values: WorkHoursValues) {
    if (!loadedDay) return;
    setError(null);
    const midnight = localMidnight(nextDay(loadedDay));
    const entries: EntryTimes[] = values.rows.map((row) => ({
      startedAt: atTime(loadedDay, row.start),
      // "00:00" is midnight at the day's end.
      endedAt: row.end === "" ? null : row.end === "00:00" ? midnight : atTime(loadedDay, row.end),
    }));
    try {
      await replaceWorkDay(userId, loadedDay, entries);
      onSaved();
    } catch (e) {
      setError(toRustMessage(e));
    }
  }

  // A refusal of one of several rows says which one.
  const row = rows.fields.length > 1 && typeof error?.params?.row === "number" ? error.params.row : null;

  return (
    <form className="flex flex-col gap-5" onSubmit={handleSubmit(submit)} noValidate>
      <DialogHeader>
        <DialogTitle>{t("workHours.dialog.title")}</DialogTitle>
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

      {loadedDay === null ? (
        !error && (
          <p className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
            <LoaderCircleIcon className="size-4 animate-spin" />
            {t("workHours.dialog.loading")}
          </p>
        )
      ) : (
        <div className="flex flex-col gap-2">
          {rows.fields.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
              {t("workHours.dialog.empty")}
            </p>
          ) : (
            <>
              <div className="grid grid-cols-[1fr_1fr_2rem] gap-2 text-sm font-medium" aria-hidden>
                <span>{t("workHours.fields.start")}</span>
                <span>{t("workHours.fields.end")}</span>
              </div>
              {rows.fields.map((field, index) => {
                const rowErrors = errors.rows?.[index];
                const rowError = fieldError(rowErrors?.start) ?? fieldError(rowErrors?.end);
                return (
                  <div key={field.id} className="flex flex-col gap-1">
                    <div className="grid grid-cols-[1fr_1fr_2rem] items-center gap-2">
                      <TimeInput
                        label={`${t("workHours.fields.start")} ${index + 1}`}
                        invalid={!!rowErrors?.start}
                        onNow={isToday ? () => fillNow(index, "start") : undefined}
                        {...register(`rows.${index}.start`)}
                      />
                      <TimeInput
                        label={`${t("workHours.fields.end")} ${index + 1}`}
                        invalid={!!rowErrors?.end}
                        onNow={isToday ? () => fillNow(index, "end") : undefined}
                        {...register(`rows.${index}.end`)}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground hover:text-destructive"
                        aria-label={t("workHours.dialog.removeRow")}
                        title={t("workHours.dialog.removeRow")}
                        onClick={() => rows.remove(index)}
                      >
                        <XIcon />
                      </Button>
                    </div>
                    {rowError && <p className="text-xs text-destructive">{rowError}</p>}
                  </div>
                );
              })}
            </>
          )}
          <Button type="button" variant="outline" size="sm" className="self-start border-dashed" onClick={addRow}>
            <PlusIcon data-icon="inline-start" />
            {t("workHours.dialog.addRow")}
          </Button>
          <p className="text-xs text-muted-foreground">{t("workHours.hints.end")}</p>
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            {row !== null ? t("workHours.rowError", { row, message: translateMessage(error) }) : translateMessage(error)}
          </AlertDescription>
        </Alert>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          {t("workHours.dialog.cancel")}
        </Button>
        <Button type="submit" disabled={isSubmitting || loadedDay === null}>
          {isSubmitting && <LoaderCircleIcon className="animate-spin" />}
          {isSubmitting ? t("workHours.dialog.saving") : t("workHours.dialog.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** A time of day ("HH:MM", 24 hours), with a small button for the current time when `onNow` is given. */
function TimeInput({
  label,
  invalid,
  onNow,
  ...inputProps
}: ComponentProps<typeof Input> & { label: string; invalid: boolean; onNow?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1">
      <Input
        type="time"
        dir="ltr"
        className="min-w-0 flex-1 rtl:text-end"
        aria-label={label}
        aria-invalid={invalid}
        {...inputProps}
      />
      {onNow && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground"
          aria-label={`${t("workHours.now")}: ${label}`}
          title={t("workHours.now")}
          onClick={onNow}
        >
          <ClockIcon />
        </Button>
      )}
    </div>
  );
}

/** A timestamp's local time of day as "HH:MM" (midnight is "00:00"). */
function timeOfDay(time: number): string {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Local time `hhmm` on the Gregorian day `iso`. */
function atTime(iso: string, hhmm: string): number {
  const [year, month, day] = iso.split("-").map(Number);
  const [hours, minutes] = hhmm.split(":").map(Number);
  return new Date(year, month - 1, day, hours, minutes).getTime();
}
