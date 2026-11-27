import { useCallback, useEffect, useState } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
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
import { localIsoDate, useCalendar, useFormatDate } from "@/i18n/calendar";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { useLanguage } from "@/i18n/use-language";
import { listLocalUsers, type LocalUser } from "@/lib/patients";
import { cn } from "@/lib/utils";
import {
  calendarMonth,
  clockOut,
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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/** What is open over the page. */
type Open = { kind: "day"; day: string } | { kind: "note"; day: string } | { kind: "member" };

type Tab = "person" | "team";

/** One day of the month shown: its entries, finished time and notes. */
interface Day {
  /** Gregorian "YYYY-MM-DD". */
  day: string;
  entries: WorkHours[];
  totalMillis: number;
  notes: string;
}

/** How often the running time of an open entry is redrawn. */
const TICK_MS = 30_000;

/**
 * /work-hours: when a user came in and left, a month (of the calendar in use) at
 * a time. Two tabs: one person's month (status with one-click entry/exit, the
 * month's totals, then day by day with each day's total and notes, and a way to
 * add more entries to any day), and everyone's totals. Entries and exits are recorded at the current time or typed in, any
 * number a day but in order: no new entry until the last one has its exit. An
 * exit on a later day than its entry is split at midnight (each day keeps its own
 * hours). Any day can be opened to change, remove or add its entries and exits.
 *
 * Everything here stays on this computer: it is never sent to the server.
 * Everyone sees everyone's hours but changes only their own; a manager can change
 * anyone's (src-tauri/src/work_hours.rs checks it again). A clinic admin can also
 * add a new user here, which does go to the server (only that user's own details).
 */
export function WorkHoursPage() {
  const { t } = useTranslation();
  const session = useSession();
  const { calendar } = useCalendar();
  const { language } = useLanguage();
  const formatDate = useFormatDate();
  const [tab, setTab] = useState<Tab>("person");
  const [users, setUsers] = useState<LocalUser[]>([]);
  const [userId, setUserId] = useState(session?.userId ?? "");
  // Any moment in the month shown: the month itself follows the calendar.
  const [anchor, setAnchor] = useState(() => Date.now());
  const [list, setList] = useState<WorkHoursList | null>(null);
  const [summary, setSummary] = useState<UserTotal[] | null>(null);
  const [error, setError] = useState<RustMessage | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow(TICK_MS);

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
  const range = (entry: WorkHours) => `${time(entry.startedAt)} – ${entry.endedAt ? time(entry.endedAt) : "…"}`;

  /** "Record entry" / "record exit": no form, the current time. */
  async function clock() {
    setBusy(true);
    try {
      const at = Date.now();
      const current = list?.open;
      if (current) await clockOut(userId, at, current.startedAt);
      else await saveWorkHours({ userId, startedAt: at, endedAt: null });
      // Back to the month of today, where the change shows.
      setAnchor(at);
      await load();
    } catch (e) {
      setError(toRustMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const days = list ? groupByDay(list) : [];
  const workedDays = days.filter((day) => day.entries.length > 0).length;
  const isCurrentMonth = month.end > Date.now();
  const noteDay = open?.kind === "note" ? open.day : "";
  const today = localIsoDate(now);
  const reload = () => {
    setOpen(null);
    void load();
  };

  return (
    <Card className="w-full max-w-3xl">
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <CardTitle>{t("workHours.title")}</CardTitle>
            <CardDescription>{t("workHours.description")}</CardDescription>
          </div>
          {session.isAdmin && (
            <Button size="sm" onClick={() => setOpen({ kind: "member" })}>
              <UserPlusIcon data-icon="inline-start" />
              {t("members.add")}
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent>
        <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="gap-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TabsList>
              <TabsTrigger value="person">{t("workHours.tabs.person")}</TabsTrigger>
              <TabsTrigger value="team">{t("workHours.tabs.team")}</TabsTrigger>
            </TabsList>
            <div className="flex items-center">
              <Button variant="ghost" size="icon-sm" aria-label={t("workHours.previousMonth")} onClick={() => setAnchor(month.start - 1)}>
                <ChevronRightIcon className="ltr:rotate-180" />
              </Button>
              <span className="min-w-28 text-center text-sm font-medium">
                {formatDate(month.start, { year: "numeric", month: "long" })}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("workHours.nextMonth")}
                disabled={isCurrentMonth}
                onClick={() => setAnchor(month.end)}
              >
                <ChevronLeftIcon className="ltr:rotate-180" />
              </Button>
            </div>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{translateMessage(error)}</AlertDescription>
            </Alert>
          )}

          <TabsContent value="person" className="flex flex-col gap-5">
            {/* Who, where they are now, and the one action that matters most. */}
            <section className="flex flex-col gap-4 rounded-xl bg-muted/50 p-4">
              <Select value={userId} onValueChange={setUserId}>
                <SelectTrigger className="w-full max-w-64 bg-background" aria-label={t("workHours.user")}>
                  <SelectValue placeholder={t("workHours.user")} />
                </SelectTrigger>
                <SelectContent>
                  {users.map((user) => (
                    <SelectItem key={user.id} value={user.id}>
                      {user.fullName || user.username}
                      {user.id === session.userId && ` ${t("workHours.me")}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

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

            {list === null ? (
              !error && <Loading label={t("workHours.loading")} />
            ) : (
              <>
                <dl className="grid grid-cols-3 gap-3">
                  <Stat label={t("workHours.monthTotal")} value={duration(list.totalMillis)} strong />
                  <Stat label={t("workHours.days")} value={number(workedDays)} />
                  <Stat
                    label={t("workHours.average")}
                    value={workedDays ? duration(list.totalMillis / workedDays) : "—"}
                  />
                </dl>

                {days.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">{t("workHours.empty")}</p>
                ) : (
                  <ul className="flex flex-col divide-y">
                    {days.map((day) => (
                      <DayRow
                        key={day.day}
                        day={day}
                        canChange={canChange}
                        weekday={formatDate(localMidnight(day.day), { weekday: "short" })}
                        dayNumber={formatDate(localMidnight(day.day), { day: "numeric" })}
                        total={day.entries.length > 0 ? duration(day.totalMillis) : ""}
                        range={range}
                        onEdit={() => setOpen({ kind: "day", day: day.day })}
                        onNote={() => setOpen({ kind: "note", day: day.day })}
                      />
                    ))}
                  </ul>
                )}
              </>
            )}
          </TabsContent>

          <TabsContent value="team">
            {summary === null ? (
              !error && <Loading label={t("workHours.loading")} />
            ) : (
              <ul className="flex flex-col divide-y">
                {summary.map((total) => (
                  <li key={total.userId}>
                    <button
                      type="button"
                      onClick={() => {
                        setUserId(total.userId);
                        setTab("person");
                      }}
                      className="flex w-full items-center gap-3 rounded-lg px-2 py-3 text-start transition-colors outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <span className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium">
                        {initial(userName(total.userId))}
                        {total.atWork && (
                          <span className="absolute -end-0.5 -bottom-0.5 size-3 rounded-full border-2 border-card bg-emerald-500" />
                        )}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium">
                          {userName(total.userId)}
                          {total.userId === session.userId && (
                            <span className="text-muted-foreground"> {t("workHours.me")}</span>
                          )}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {total.atWork ? t("workHours.atWork") : t("workHours.daysCount", { days: number(total.days) })}
                        </span>
                      </span>
                      <span className="text-sm font-medium whitespace-nowrap tabular-nums">{duration(total.totalMillis)}</span>
                      <ChevronLeftIcon className="size-4 shrink-0 text-muted-foreground ltr:rotate-180" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
        </Tabs>
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
        dayLabel={noteDay ? formatDate(localMidnight(noteDay), { weekday: "long", day: "numeric", month: "long" }) : ""}
        notes={list?.dayNotes.find((note) => note.day === noteDay)?.notes ?? ""}
        onSaved={reload}
      />
      <MemberDialog
        open={open?.kind === "member"}
        onOpenChange={(next) => !next && setOpen(null)}
        onCreated={(member) => {
          loadUsers();
          // Straight to the new user's hours.
          setUserId(member.id);
          setTab("person");
        }}
      />
    </Card>
  );
}

/** One day: the date on the side, each entry–exit as a chip, the day's total and notes. */
function DayRow({
  day,
  canChange,
  weekday,
  dayNumber,
  total,
  range,
  onEdit,
  onNote,
}: {
  day: Day;
  canChange: boolean;
  weekday: string;
  dayNumber: string;
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
      <div className="flex w-10 shrink-0 flex-col items-center">
        <span className="text-xs text-muted-foreground">{weekday}</span>
        <span className="text-lg leading-tight font-semibold tabular-nums">{dayNumber}</span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
        {(day.entries.length > 0 || canChange) && (
          <div className="flex flex-wrap gap-1.5">
            {day.entries.map((entry) => {
              const chip = cn(
                "inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs tabular-nums",
                !entry.endedAt && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
              );
              const content = (
                <>
                  {!entry.endedAt && <span className="size-1.5 rounded-full bg-emerald-500" />}
                  <span dir="ltr">{range(entry)}</span>
                </>
              );
              return canChange ? (
                <button
                  key={entry.id}
                  type="button"
                  aria-label={t("workHours.editEntry", { range: range(entry) })}
                  onClick={onEdit}
                  className={cn(chip, "transition-colors outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50")}
                >
                  {content}
                </button>
              ) : (
                <span key={entry.id} className={chip}>
                  {content}
                </span>
              );
            })}
            {canChange && (
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
            )}
          </div>
        )}
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

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("text-sm font-medium tabular-nums", strong && "text-base font-semibold")}>{value}</dd>
    </div>
  );
}

function StatusDot({ active }: { active: boolean }) {
  return (
    <span className="relative flex size-3 shrink-0">
      {active && <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/60" />}
      <span className={cn("relative inline-flex size-3 rounded-full", active ? "bg-emerald-500" : "bg-muted-foreground/40")} />
    </span>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
      <LoaderCircleIcon className="size-4 animate-spin" />
      {label}
    </p>
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

/** The first letter of a name, for its avatar. */
function initial(name: string): string {
  return [...name.trim()][0]?.toUpperCase() ?? "?";
}

/** The days of `list` that have entries or notes, newest first. */
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
