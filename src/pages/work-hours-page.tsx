import { useCallback, useEffect, useState } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  LoaderCircleIcon,
  LogInIcon,
  LogOutIcon,
  NotebookPenIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  UserPlusIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSession } from "@/auth/store";
import { localIsoDate, useCalendar, useFormatDate } from "@/i18n/calendar";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { useLanguage } from "@/i18n/use-language";
import { listLocalUsers, type LocalUser } from "@/lib/patients";
import {
  calendarMonth,
  deleteWorkHours,
  hoursAndMinutes,
  listWorkHours,
  localMidnight,
  saveWorkHours,
  workHoursSummary,
  type UserTotal,
  type WorkHours,
  type WorkHoursList,
} from "@/lib/work-hours";
import { DayNoteDialog } from "@/components/day-note-dialog";
import { MemberDialog } from "@/components/member-dialog";
import { WorkHoursDialog } from "@/components/work-hours-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** What is open over the page. */
type Open =
  | { kind: "entry"; entry?: WorkHours }
  | { kind: "delete"; entry: WorkHours }
  | { kind: "note"; day: string }
  | { kind: "member" };

/** One day of the month shown: its entries, finished time and notes. */
interface Day {
  /** Gregorian "YYYY-MM-DD". */
  day: string;
  entries: WorkHours[];
  totalMillis: number;
  notes: string;
}

/**
 * /work-hours: when a user came in and left, a month (of the calendar in use) at
 * a time, by day, with each day's notes and the month's total. Entries and exits
 * are recorded with one click at the current time or typed in, any number a day
 * but in order: no new entry until the last one has its exit. Everything here
 * stays on this computer: it is never sent to the server. Everyone sees everyone's
 * month totals and can open anyone's entries, but changes only their own; a
 * manager can change anyone's (src-tauri/src/work_hours.rs checks it again). A clinic admin can also add a new user here,
 * which does go to the server (only that user's own details).
 */
export function WorkHoursPage() {
  const { t } = useTranslation();
  const session = useSession();
  const { calendar } = useCalendar();
  const { language } = useLanguage();
  const formatDate = useFormatDate();
  const [users, setUsers] = useState<LocalUser[]>([]);
  const [userId, setUserId] = useState(session?.userId ?? "");
  // Any moment in the month shown: the month itself follows the calendar.
  const [anchor, setAnchor] = useState(() => Date.now());
  const [list, setList] = useState<WorkHoursList | null>(null);
  // Everyone's totals of the month.
  const [summary, setSummary] = useState<UserTotal[] | null>(null);
  const [error, setError] = useState<RustMessage | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [busy, setBusy] = useState(false);

  const month = calendarMonth(anchor, calendar);
  const isManager = session?.role === "manager";
  // Whether the hours shown may be changed here: one's own, or anyone's for a manager.
  const canChange = isManager || userId === session?.userId;

  const loadUsers = useCallback(() => {
    listLocalUsers().then(setUsers, (e) => setError(toRustMessage(e)));
  }, []);
  useEffect(loadUsers, [loadUsers]);

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      const period = { start: month.start, end: month.end };
      const [found, totals] = await Promise.all([listWorkHours(userId, period), workHoursSummary(period)]);
      setList(found);
      setSummary(totals);
      setError(null);
    } catch (e) {
      setError(toRustMessage(e));
    }
  }, [userId, month.start, month.end]);

  useEffect(() => {
    setList(null);
    void load();
  }, [load]);

  // The app layout leaves for /login when there is no session.
  if (!session) return null;

  const userName = (id: string) => {
    const user = users.find((u) => u.id === id);
    return user ? user.fullName || user.username : id === session.userId ? session.fullName : "";
  };
  const number = (value: number) => value.toLocaleString(language.code);
  const duration = (millis: number) => {
    const { hours, minutes } = hoursAndMinutes(millis);
    return t("workHours.duration", { hours: number(hours), minutes: number(minutes) });
  };
  const time = (at: number) => formatDate(at, { timeStyle: "short" });
  const dayLabel = (day: string) => formatDate(localMidnight(day), { weekday: "long", day: "numeric", month: "long" });

  /** "Record entry" / "record exit": no form, the current time. */
  async function clock() {
    setBusy(true);
    try {
      const now = Date.now();
      const current = list?.open;
      await saveWorkHours(
        current ? { userId, startedAt: current.startedAt, endedAt: now } : { userId, startedAt: now, endedAt: null },
        current?.id,
      );
      // Back to the month of today, where the change shows.
      setAnchor(now);
      await load();
    } catch (e) {
      setError(toRustMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const days = list ? groupByDay(list) : [];
  const isCurrentMonth = month.end > Date.now();
  const noteDay = open?.kind === "note" ? open.day : "";
  const reload = () => {
    setOpen(null);
    void load();
  };

  return (
    <Card className="w-full max-w-3xl">
      <CardHeader>
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <CardTitle>{t("workHours.title")}</CardTitle>
            <CardDescription>{t("workHours.description")}</CardDescription>
          </div>
          {session.isAdmin && (
            <Button variant="outline" onClick={() => setOpen({ kind: "member" })}>
              <UserPlusIcon data-icon="inline-start" />
              {t("members.add")}
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Select value={userId} onValueChange={setUserId}>
            <SelectTrigger className="min-w-48" aria-label={t("workHours.user")}>
              <SelectValue placeholder={t("workHours.user")} />
            </SelectTrigger>
            <SelectContent>
              {users.map((user) => (
                <SelectItem key={user.id} value={user.id}>
                  {user.fullName || user.username}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="ms-auto flex items-center gap-1">
            <Button variant="ghost" size="icon" aria-label={t("workHours.previousMonth")} onClick={() => setAnchor(month.start - 1)}>
              <ChevronRightIcon className="ltr:rotate-180" />
            </Button>
            <span className="min-w-32 text-center text-sm font-medium">
              {formatDate(month.start, { year: "numeric", month: "long" })}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("workHours.nextMonth")}
              disabled={isCurrentMonth}
              onClick={() => setAnchor(month.end)}
            >
              <ChevronLeftIcon className="ltr:rotate-180" />
            </Button>
          </div>
        </div>

        {summary && summary.length > 0 && (
          <section className="flex flex-col gap-2" aria-labelledby="work-hours-everyone">
            <h3 id="work-hours-everyone" className="text-sm font-medium">
              {t("workHours.everyone")}
            </h3>
            <ul className="flex flex-col divide-y rounded-lg border">
              {summary.map((total) => (
                <li key={total.userId}>
                  <button
                    type="button"
                    aria-current={total.userId === userId ? "true" : undefined}
                    onClick={() => setUserId(total.userId)}
                    className="flex w-full items-center gap-3 px-3 py-2 text-start transition-colors outline-none first:rounded-t-lg last:rounded-b-lg hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 aria-current:bg-accent"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{userName(total.userId)}</span>
                    {total.atWork && <Badge variant="secondary">{t("workHours.ongoing")}</Badge>}
                    <span className="text-xs text-muted-foreground">{t("workHours.days", { days: number(total.days) })}</span>
                    <span className="min-w-28 text-end text-sm font-semibold whitespace-nowrap">{duration(total.totalMillis)}</span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">{t("workHours.everyoneHint")}</p>
          </section>
        )}

        {list && (
          <h3 className="-mb-2 text-sm font-medium">{t("workHours.entriesOf", { name: userName(userId) })}</h3>
        )}

        {list && (
          <div className="flex flex-col gap-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex-1 text-sm">
                {list.open
                  ? t("workHours.atWorkSince", {
                      time: formatDate(list.open.startedAt, { dateStyle: "medium", timeStyle: "short" }),
                    })
                  : t("workHours.notAtWork")}
              </span>
              {canChange && (
                <>
                  {list.open ? (
                    <Button variant="outline" onClick={() => setOpen({ kind: "entry", entry: list.open! })}>
                      <PencilIcon data-icon="inline-start" />
                      {t("workHours.typeExit")}
                    </Button>
                  ) : (
                    <Button variant="outline" onClick={() => setOpen({ kind: "entry" })}>
                      <PlusIcon data-icon="inline-start" />
                      {t("workHours.add")}
                    </Button>
                  )}
                  <Button onClick={clock} disabled={busy} variant={list.open ? "destructive" : "default"}>
                    {busy ? (
                      <LoaderCircleIcon className="animate-spin" />
                    ) : list.open ? (
                      <LogOutIcon data-icon="inline-start" />
                    ) : (
                      <LogInIcon data-icon="inline-start" />
                    )}
                    {list.open ? t("workHours.endNow") : t("workHours.startNow")}
                  </Button>
                </>
              )}
            </div>
            {canChange && list.open && <p className="text-xs text-muted-foreground">{t("workHours.exitFirstHint")}</p>}
            {!canChange && <p className="text-xs text-muted-foreground">{t("workHours.viewOnly")}</p>}
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{translateMessage(error)}</AlertDescription>
          </Alert>
        )}

        {list === null ? (
          !error && (
            <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <LoaderCircleIcon className="size-4 animate-spin" />
              {t("workHours.loading")}
            </p>
          )
        ) : days.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">{t("workHours.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {days.map((day) => (
              <li key={day.day} className="flex flex-col rounded-lg border">
                <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 first:rounded-t-lg">
                  <span className="flex-1 text-sm font-medium">{dayLabel(day.day)}</span>
                  {day.entries.length > 0 && (
                    <span className="text-sm whitespace-nowrap">
                      <span className="text-muted-foreground">{t("workHours.dayTotal")}:</span>{" "}
                      <span className="font-semibold">{duration(day.totalMillis)}</span>
                    </span>
                  )}
                  {canChange && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={day.notes ? t("workHours.dayNote.edit") : t("workHours.dayNote.add")}
                      title={day.notes ? t("workHours.dayNote.edit") : t("workHours.dayNote.add")}
                      onClick={() => setOpen({ kind: "note", day: day.day })}
                    >
                      <NotebookPenIcon />
                    </Button>
                  )}
                </div>
                {day.entries.length > 0 && (
                  <ul className="flex flex-col divide-y">
                    {day.entries.map((entry) => (
                      <li key={entry.id} className="flex items-center gap-3 px-3 py-2">
                        <span className="flex flex-1 flex-wrap gap-x-4 gap-y-0.5 text-sm">
                          <span>
                            <span className="text-muted-foreground">{t("workHours.entry")}</span> {time(entry.startedAt)}
                          </span>
                          <span>
                            <span className="text-muted-foreground">{t("workHours.exit")}</span>{" "}
                            {entry.endedAt ? time(entry.endedAt) : "—"}
                          </span>
                        </span>
                        {entry.endedAt ? (
                          <span className="text-xs whitespace-nowrap text-muted-foreground">
                            {duration(entry.endedAt - entry.startedAt)}
                          </span>
                        ) : (
                          <Badge variant="secondary">{t("workHours.ongoing")}</Badge>
                        )}
                        {canChange && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={t("workHours.edit")}
                              onClick={() => setOpen({ kind: "entry", entry })}
                            >
                              <PencilIcon />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={t("workHours.delete")}
                              onClick={() => setOpen({ kind: "delete", entry })}
                            >
                              <Trash2Icon />
                            </Button>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {day.notes && (
                  <p className="border-t px-3 py-2 text-sm whitespace-pre-wrap text-muted-foreground">{day.notes}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {list && (
        <CardFooter className="flex flex-wrap items-center justify-between gap-2 border-t">
          <span>
            {t("workHours.monthTotal", { month: formatDate(month.start, { year: "numeric", month: "long" }) })}:{" "}
            <span className="text-lg font-semibold">{duration(list.totalMillis)}</span>
          </span>
          <span className="text-muted-foreground">
            {t("workHours.days", { days: number(days.filter((day) => day.entries.length > 0).length) })}
          </span>
        </CardFooter>
      )}

      <WorkHoursDialog
        open={open?.kind === "entry"}
        onOpenChange={(next) => !next && setOpen(null)}
        userId={userId}
        userName={userName(userId)}
        entry={open?.kind === "entry" ? open.entry : undefined}
        onSaved={reload}
      />
      <DayNoteDialog
        open={open?.kind === "note"}
        onOpenChange={(next) => !next && setOpen(null)}
        userId={userId}
        day={noteDay}
        dayLabel={noteDay ? dayLabel(noteDay) : ""}
        notes={list?.dayNotes.find((note) => note.day === noteDay)?.notes ?? ""}
        onSaved={reload}
      />
      <DeleteDialog
        entry={open?.kind === "delete" ? open.entry : null}
        describe={(entry) =>
          `${formatDate(entry.startedAt, { dateStyle: "medium" })} ${time(entry.startedAt)} – ${entry.endedAt ? time(entry.endedAt) : t("workHours.ongoing")}`
        }
        onClose={() => setOpen(null)}
        onDeleted={reload}
      />
      <MemberDialog
        open={open?.kind === "member"}
        onOpenChange={(next) => !next && setOpen(null)}
        onCreated={(member) => {
          loadUsers();
          // Straight to the new user's hours.
          setUserId(member.id);
        }}
      />
    </Card>
  );
}

/** The days of `list` that have entries or notes, newest first; today's notes can be added even before an entry. */
function groupByDay(list: WorkHoursList): Day[] {
  const days = new Map<string, Day>();
  const dayOf = (day: string) => {
    let found = days.get(day);
    if (!found) {
      found = { day, entries: [], totalMillis: 0, notes: "" };
      days.set(day, found);
    }
    return found;
  };
  for (const entry of list.entries) {
    const day = dayOf(localIsoDate(entry.startedAt));
    day.entries.push(entry);
    if (entry.endedAt) day.totalMillis += entry.endedAt - entry.startedAt;
  }
  for (const note of list.dayNotes) dayOf(note.day).notes = note.notes;
  return [...days.values()].sort((a, b) => b.day.localeCompare(a.day));
}

function DeleteDialog({
  entry,
  describe,
  onClose,
  onDeleted,
}: {
  entry: WorkHours | null;
  describe: (entry: WorkHours) => string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<RustMessage | null>(null);

  async function confirm() {
    if (!entry) return;
    setWorking(true);
    setError(null);
    try {
      await deleteWorkHours(entry.id);
      onDeleted();
    } catch (e) {
      setError(toRustMessage(e));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(next) => {
        if (!next) {
          setError(null);
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("workHours.deleteDialog.title")}</DialogTitle>
          <DialogDescription>{entry && t("workHours.deleteDialog.description", { entry: describe(entry) })}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{translateMessage(error)}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={working}>
            {t("workHours.dialog.cancel")}
          </Button>
          <Button type="button" variant="destructive" onClick={confirm} disabled={working}>
            {working && <LoaderCircleIcon className="animate-spin" />}
            {working ? t("workHours.deleteDialog.working") : t("workHours.deleteDialog.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
