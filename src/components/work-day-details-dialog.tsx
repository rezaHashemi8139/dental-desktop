import { NotebookPenIcon, PencilLineIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { WorkDay } from "@/lib/work-hours";
import { useWorkHoursFormat } from "@/components/work-hours-parts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * One user's day in full, read only: each entry and exit with how long it lasted,
 * the day's total and its notes. Whoever may change the day (their own, or anyone's
 * for a manager) gets buttons that open the editing dialogs. Opened from the work
 * hours report (src/pages/work-hours-report-page.tsx).
 */
export function WorkDayDetailsDialog({
  open,
  onOpenChange,
  day,
  userName,
  canChange,
  onEditEntries,
  onEditNotes,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The day shown; null keeps the dialog closed. */
  day: WorkDay | null;
  userName: string;
  canChange: boolean;
  onEditEntries: () => void;
  onEditNotes: () => void;
}) {
  const { t } = useTranslation();
  const { number, duration, time, longDay } = useWorkHoursFormat();
  return (
    <Dialog open={open && !!day} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
        {day && (
          <>
            <DialogHeader>
              <DialogTitle>{longDay(day.day)}</DialogTitle>
              <DialogDescription>{userName}</DialogDescription>
            </DialogHeader>

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{t("workHours.details.entries")}</h3>
              {day.entries.length === 0 ? (
                <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                  {t("workHours.dialog.empty")}
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="py-2 text-start font-normal">#</th>
                      <th className="py-2 text-start font-normal">{t("workHours.fields.start")}</th>
                      <th className="py-2 text-start font-normal">{t("workHours.fields.end")}</th>
                      <th className="py-2 text-end font-normal">{t("workHours.details.duration")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y tabular-nums">
                    {day.entries.map((entry, index) => (
                      <tr key={entry.id}>
                        <td className="py-2 text-muted-foreground">{number(index + 1)}</td>
                        <td className="py-2">{time(entry.startedAt)}</td>
                        <td className="py-2">
                          {entry.endedAt ? (
                            time(entry.endedAt)
                          ) : (
                            <span className="text-emerald-700 dark:text-emerald-400">{t("workHours.atWork")}</span>
                          )}
                        </td>
                        <td className="py-2 text-end">{entry.endedAt ? duration(entry.endedAt - entry.startedAt) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t font-medium">
                      <td className="py-2" colSpan={3}>
                        {t("workHours.details.total")}
                      </td>
                      <td className="py-2 text-end tabular-nums">{duration(day.totalMillis)}</td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{t("workHours.fields.notes")}</h3>
              {day.notes ? (
                <p className="rounded-lg bg-muted/50 p-3 text-sm whitespace-pre-wrap">{day.notes}</p>
              ) : (
                <p className="text-sm text-muted-foreground">{t("workHours.details.noNotes")}</p>
              )}
            </section>

            <DialogFooter>
              {canChange && (
                <>
                  <Button variant="outline" onClick={onEditNotes}>
                    <NotebookPenIcon data-icon="inline-start" />
                    {day.notes ? t("workHours.dayNote.edit") : t("workHours.dayNote.add")}
                  </Button>
                  <Button variant="outline" onClick={onEditEntries}>
                    <PencilLineIcon data-icon="inline-start" />
                    {t("workHours.details.editEntries")}
                  </Button>
                </>
              )}
              <Button onClick={() => onOpenChange(false)}>{t("workHours.details.close")}</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
