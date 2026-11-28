import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  FileChartColumnIcon,
  LoaderCircleIcon,
  LogInIcon,
  LogOutIcon,
  NotebookPenIcon,
  PencilLineIcon,
  PlusIcon,
  UserPlusIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSession } from "@/auth/store";
import { localIsoDate } from "@/i18n/calendar";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { cn } from "@/lib/utils";
import {
  addDays,
  clockOut,
  groupByDay,
  listWorkHours,
  localMidnight,
  saveWorkHours,
  type WorkDay,
  type WorkHours,
  type WorkHoursList,
} from "@/lib/work-hours";
import { DayNoteDialog } from "@/components/day-note-dialog";
import { MemberDialog } from "@/components/member-dialog";
import { WorkHoursDialog } from "@/components/work-hours-dialog";
import {
  DayBadge,
  EntryChipContent,
  entryChipClass,
  Loading,
  StatusDot,
  UserSelect,
  useWorkHoursFormat,
  useWorkHoursUsers,
} from "@/components/work-hours-parts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** What is open over the page. */
type Open = { kind: "day"; day: string } | { kind: "note"; day: string } | { kind: "member" };

/** How often the running time of an open entry is redrawn. */
const TICK_MS = 30_000;
/** Days shown below the status: today and the ones before it. */
const RECENT_DAYS = 7;

/**
 * /work-hours: recording when a user came in and left. The user's status with
 * one-click entry/exit (at the current time) or typed-in times for any day, then
 * the last few days, each with its entries, total and notes, to change or add to.
 * The month-by-month listing of everyone's hours is the report page
 * (src/pages/work-hours-report-page.tsx).
 *
 * Entries and exits are recorded any number a day but in order: no new entry
 * until the last one has its exit. An exit on a later day than its entry is split
 * at midnight (each day keeps its own hours).
 *
 * Everything here stays on this computer: it is never sent to the server.
 * Everyone sees everyone's hours but changes only their own; a manager can change
 * anyone's (src-tauri/src/work_hours.rs checks it again). A clinic admin can also
 * add a new user here, which does go to the server (only that user's own details).
 */
export function WorkHoursPage() {
  const { t } = useTranslation();
  const session = useSession();
  const { duration, time, range, longDay } = useWorkHoursFormat();
  const [error, setError] = useState<RustMessage | null>(null);
  const { users, userName, reload: reloadUsers } = useWorkHoursUsers(setError);
  const [userId, setUserId] = useState(session?.userId ?? "");
  const [list, setList] = useState<WorkHoursList | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow(TICK_MS);
  const today = localIsoDate(now);
  const firstDay = addDays(today, 1 - RECENT_DAYS);

  const isManager = session?.role === "manager";
  // Whether the hours shown may be changed here: one's own, or anyone's for a manager.
  const canChange = isManager || userId === session?.userId;

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      setList(await listWorkHours(userId, { start: localMidnight(firstDay), end: localMidnight(addDays(firstDay, RECENT_DAYS)) }));
      setError(null);
    } catch (e) {
      setError(toRustMessage(e));
    }
  }, [userId, firstDay]);

  useEffect(() => {
    setList(null);
    void load();
  }, [load]);

  // The app layout leaves for /login when there is no session.
  if (!session) return null;

  /** "Record entry" / "record exit": no form, the current time. */
  async function clock() {
    setBusy(true);
    try {
      const at = Date.now();
      const current = list?.open;
      if (current) await clockOut(userId, at, current.startedAt);
      else await saveWorkHours({ userId, startedAt: at, endedAt: null });
      await load();
    } catch (e) {
      setError(toRustMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const recentDays = Array.from({ length: RECENT_DAYS }, (_, i) => addDays(today, -i));
  const days = list ? groupByDay(userId, list, recentDays) : [];
  const noteDay = open?.kind === "note" ? open.day : "";
  const reload = () => {
    setOpen(null);
    void load();
  };

  return (
    <Card className="w-full max-w-3xl">
      <CardHeader>
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <CardTitle>{t("workHours.title")}</CardTitle>
            <CardDescription>{t("workHours.description")}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/work-hours/report">
                <FileChartColumnIcon data-icon="inline-start" />
                {t("workHours.openReport")}
              </Link>
            </Button>
            {session.isAdmin && (
              <Button size="sm" onClick={() => setOpen({ kind: "member" })}>
                <UserPlusIcon data-icon="inline-start" />
                {t("members.add")}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{translateMessage(error)}</AlertDescription>
          </Alert>
        )}

        {/* Who, where they are now, and the one action that matters most. */}
        <section className="flex flex-col gap-4 rounded-xl bg-muted/50 p-4">
          <UserSelect users={users} value={userId} onChange={setUserId} />

          {list && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <StatusDot active={!!list.open} />
                <div className="flex flex-col">
                  <span className="font-medium">{list.open ? t("workHours.atWork") : t("workHours.notAtWork")}</span>
                  {list.open && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {t("workHours.since", { time: time(list.open.startedAt), elapsed: duration(now - list.open.startedAt) })}
                    </span>
                  )}
                </div>
              </div>
              {canChange && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="lg"
                    // The day of the open entry, to type its exit; otherwise today.
                    onClick={() => setOpen({ kind: "day", day: list.open ? localIsoDate(list.open.startedAt) : today })}
                  >
                    {list.open ? <PencilLineIcon data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}
                    {list.open ? t("workHours.typeExit") : t("workHours.add")}
                  </Button>
                  <Button size="lg" onClick={clock} disabled={busy} variant={list.open ? "destructive" : "default"}>
                    {busy ? (
                      <LoaderCircleIcon className="animate-spin" />
                    ) : list.open ? (
                      <LogOutIcon data-icon="inline-start" />
                    ) : (
                      <LogInIcon data-icon="inline-start" />
                    )}
                    {list.open ? t("workHours.endNow") : t("workHours.startNow")}
                  </Button>
                </div>
              )}
            </div>
          )}
          {list && !canChange && <p className="text-xs text-muted-foreground">{t("workHours.viewOnly")}</p>}
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-medium">{t("workHours.recent.title")}</h3>
            {list && (
              <span className="text-sm text-muted-foreground tabular-nums">
                {t("workHours.recent.total", { total: duration(list.totalMillis) })}
              </span>
            )}
          </div>
          {list === null ? (
            !error && <Loading label={t("workHours.loading")} />
          ) : (
            <ul className="flex flex-col divide-y">
              {days.map((day) => (
                <DayRow
                  key={day.day}
                  day={day}
                  canChange={canChange}
                  total={day.entries.length > 0 ? duration(day.totalMillis) : ""}
                  range={range}
                  onEdit={() => setOpen({ kind: "day", day: day.day })}
                  onNote={() => setOpen({ kind: "note", day: day.day })}
                />
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">{t("workHours.recent.hint")}</p>
        </section>
      </CardContent>

      <WorkHoursDialog
        open={open?.kind === "day"}
        onOpenChange={(next) => !next && setOpen(null)}
        userId={userId}
        userName={userName(userId)}
        day={open?.kind === "day" ? open.day : today}
        onSaved={reload}
      />
      <DayNoteDialog
        open={open?.kind === "note"}
        onOpenChange={(next) => !next && setOpen(null)}
        userId={userId}
        day={noteDay}
        dayLabel={noteDay ? longDay(noteDay) : ""}
        notes={list?.dayNotes.find((note) => note.day === noteDay)?.notes ?? ""}
        onSaved={reload}
      />
      <MemberDialog
        open={open?.kind === "member"}
        onOpenChange={(next) => !next && setOpen(null)}
        onCreated={(member) => {
          reloadUsers();
          // Straight to the new user's hours.
          setUserId(member.id);
        }}
      />
    </Card>
  );
}

/** One day: the date on the side, each entry–exit as a chip, the day's total and notes. */
function DayRow({
  day,
  canChange,
  total,
  range,
  onEdit,
  onNote,
}: {
  day: WorkDay;
  canChange: boolean;
  /** The day's finished time, "" if it has no entries. */
  total: string;
  range: (entry: WorkHours) => string;
  /** Opens the day's entries and exits to change, remove or add to. */
  onEdit: () => void;
  onNote: () => void;
}) {
  const { t } = useTranslation();
  const noteLabel = day.notes ? t("workHours.dayNote.edit") : t("workHours.dayNote.add");
  return (
    <li className="group flex items-start gap-4 py-3">
      <DayBadge day={day.day} />
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
        <div className="flex flex-wrap gap-1.5">
          {day.entries.map((entry) =>
            canChange ? (
              <button
                key={entry.id}
                type="button"
                aria-label={t("workHours.editEntry", { range: range(entry) })}
                onClick={onEdit}
                className={cn(
                  entryChipClass(entry),
                  "transition-colors outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50",
                )}
              >
                <EntryChipContent entry={entry} range={range(entry)} />
              </button>
            ) : (
              <span key={entry.id} className={entryChipClass(entry)}>
                <EntryChipContent entry={entry} range={range(entry)} />
              </span>
            ),
          )}
          {canChange ? (
            <button
              type="button"
              aria-label={t("workHours.addToDay")}
              title={t("workHours.addToDay")}
              onClick={onEdit}
              className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <PlusIcon className="size-3.5" />
              {t("workHours.addShort")}
            </button>
          ) : (
            day.entries.length === 0 && <span className="py-1 text-xs text-muted-foreground">—</span>
          )}
        </div>
        {day.notes && <p className="text-xs whitespace-pre-wrap text-muted-foreground">{day.notes}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1 pt-0.5">
        {total && <span className="text-sm font-medium whitespace-nowrap tabular-nums">{total}</span>}
        {canChange && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={noteLabel}
            title={noteLabel}
            onClick={onNote}
            // Quiet until the row is pointed at; always there for the keyboard.
            className={cn("text-muted-foreground", !day.notes && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}
          >
            <NotebookPenIcon />
          </Button>
        )}
      </div>
    </li>
  );
}

/** The current time, redrawn every `intervalMs`. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
