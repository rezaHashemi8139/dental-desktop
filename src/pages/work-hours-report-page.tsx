import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon, ChevronLeftIcon, NotebookTextIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSession } from "@/auth/store";
import { useCalendar } from "@/i18n/calendar";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import {
  calendarMonth,
  groupByDay,
  listWorkHours,
  workHoursSummary,
  type UserTotal,
  type WorkDay,
} from "@/lib/work-hours";
import { DayNoteDialog } from "@/components/day-note-dialog";
import { WorkDayDetailsDialog } from "@/components/work-day-details-dialog";
import { WorkHoursDialog } from "@/components/work-hours-dialog";
import {
  ALL_USERS,
  DayBadge,
  EntryChipContent,
  entryChipClass,
  initial,
  Loading,
  MonthNav,
  Stat,
  UserSelect,
  useWorkHoursFormat,
  useWorkHoursUsers,
} from "@/components/work-hours-parts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Tab = "days" | "staff";

/** One user's day, by who and when. */
interface DayKey {
  userId: string;
  day: string;
}

/** What is open over the page: a day's details, or one of its editors (which return to the details). */
type Open = { kind: "details" | "entries" | "note"; key: DayKey };

/**
 * /work-hours/report: working hours a month (of the calendar in use) at a time,
 * of one user or everyone. Two tabs: day by day (each user's day as a row with its
 * entries, total and the start of its notes; a row opens the day in full), and
 * each user's totals (a user opens their days). Whoever may change a day (their
 * own, or anyone's for a manager) can edit it from its details; recording is on
 * the /work-hours page.
 *
 * Read from this computer only, like everything about working hours.
 */
export function WorkHoursReportPage() {
  const { t } = useTranslation();
  const session = useSession();
  const { calendar } = useCalendar();
  const { number, duration, range, longDay } = useWorkHoursFormat();
  const [error, setError] = useState<RustMessage | null>(null);
  const { users, userName } = useWorkHoursUsers(setError);
  const [tab, setTab] = useState<Tab>("days");
  const [userId, setUserId] = useState(ALL_USERS);
  // Any moment in the month shown: the month itself follows the calendar.
  const [anchor, setAnchor] = useState(() => Date.now());
  const [days, setDays] = useState<WorkDay[] | null>(null);
  const [summary, setSummary] = useState<UserTotal[] | null>(null);
  const [open, setOpen] = useState<Open | null>(null);

  const month = calendarMonth(anchor, calendar);
  const isAll = userId === ALL_USERS;

  const load = useCallback(async () => {
    try {
      const period = { start: month.start, end: month.end };
      const totals = await workHoursSummary(period);
      // The summary has every user of this computer.
      const ids = userId === ALL_USERS ? totals.map((total) => total.userId) : [userId];
      const lists = await Promise.all(ids.map((id) => listWorkHours(id, period)));
      setSummary(totals);
      setDays(lists.flatMap((list, i) => groupByDay(ids[i], list)));
      setError(null);
    } catch (e) {
      setError(toRustMessage(e));
    }
  }, [userId, month.start, month.end]);

  useEffect(() => {
    setDays(null);
    void load();
  }, [load]);

  // The app layout leaves for /login when there is no session.
  if (!session) return null;

  const isManager = session.role === "manager";
  const canChange = (id: string) => isManager || id === session.userId;

  // Newest day first; on the same day, by name.
  const rows = [...(days ?? [])].sort(
    (a, b) => b.day.localeCompare(a.day) || userName(a.userId).localeCompare(userName(b.userId)),
  );
  const worked = rows.filter((day) => day.entries.length > 0);
  const totalMillis = rows.reduce((sum, day) => sum + day.totalMillis, 0);
  const workedDays = new Set(worked.map((day) => day.day)).size;
  const people = new Set(worked.map((day) => day.userId)).size;

  const findDay = (key: DayKey | undefined) =>
    (key && rows.find((day) => day.userId === key.userId && day.day === key.day)) || null;
  const opened = findDay(open?.key);
  // Edits go back to the day's details, which show the change once reloaded.
  const backToDetails = () => setOpen((current) => current && { kind: "details", key: current.key });
  const saved = () => {
    backToDetails();
    void load();
  };

  return (
    <Card className="w-full max-w-4xl">
      <CardHeader>
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <CardTitle>{t("workHours.report.title")}</CardTitle>
            <CardDescription>{t("workHours.report.description")}</CardDescription>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/work-hours">
              <ArrowRightIcon data-icon="inline-start" className="ltr:rotate-180" />
              {t("workHours.report.back")}
            </Link>
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="gap-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TabsList>
              <TabsTrigger value="days">{t("workHours.report.tabs.days")}</TabsTrigger>
              <TabsTrigger value="staff">{t("workHours.report.tabs.staff")}</TabsTrigger>
            </TabsList>
            <div className="flex flex-wrap items-center gap-2">
              {tab === "days" && (
                <UserSelect
                  users={users}
                  value={userId}
                  onChange={setUserId}
                  allLabel={t("workHours.report.allUsers")}
                  className="w-56"
                />
              )}
              <MonthNav month={month} onChange={setAnchor} />
            </div>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{translateMessage(error)}</AlertDescription>
            </Alert>
          )}

          <TabsContent value="days" className="flex flex-col gap-5">
            {days === null ? (
              !error && <Loading label={t("workHours.loading")} />
            ) : (
              <>
                <dl className="grid grid-cols-3 gap-3">
                  <Stat label={t("workHours.monthTotal")} value={duration(totalMillis)} strong />
                  <Stat label={t("workHours.days")} value={number(workedDays)} />
                  {isAll ? (
                    <Stat label={t("workHours.report.people")} value={number(people)} />
                  ) : (
                    <Stat label={t("workHours.average")} value={worked.length ? duration(totalMillis / worked.length) : "—"} />
                  )}
                </dl>

                {rows.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">{t("workHours.empty")}</p>
                ) : (
                  <ul className="flex flex-col divide-y">
                    {rows.map((day) => (
                      <li key={`${day.userId}/${day.day}`}>
                        <button
                          type="button"
                          aria-label={t("workHours.report.openDetails", { day: longDay(day.day), name: userName(day.userId) })}
                          onClick={() => setOpen({ kind: "details", key: { userId: day.userId, day: day.day } })}
                          className="flex w-full items-start gap-4 rounded-lg px-2 py-3 text-start transition-colors outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
                        >
                          <DayBadge day={day.day} />
                          <span className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
                            {isAll && (
                              <span className="truncate text-sm font-medium">
                                {userName(day.userId)}
                                {day.userId === session.userId && (
                                  <span className="text-muted-foreground"> {t("workHours.me")}</span>
                                )}
                              </span>
                            )}
                            <span className="flex flex-wrap gap-1.5">
                              {day.entries.length === 0 ? (
                                <span className="text-xs text-muted-foreground">{t("workHours.report.noEntries")}</span>
                              ) : (
                                day.entries.map((entry) => (
                                  <span key={entry.id} className={entryChipClass(entry)}>
                                    <EntryChipContent entry={entry} range={range(entry)} />
                                  </span>
                                ))
                              )}
                            </span>
                            {day.notes && (
                              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <NotebookTextIcon className="size-3.5 shrink-0" />
                                <span className="truncate">{day.notes}</span>
                              </span>
                            )}
                          </span>
                          <span className="pt-0.5 text-sm font-medium whitespace-nowrap tabular-nums">
                            {day.entries.length > 0 ? duration(day.totalMillis) : ""}
                          </span>
                          <ChevronLeftIcon className="mt-1 size-4 shrink-0 text-muted-foreground ltr:rotate-180" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </TabsContent>

          <TabsContent value="staff">
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
                        setTab("days");
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
                          {total.userId === session.userId && <span className="text-muted-foreground"> {t("workHours.me")}</span>}
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

      <WorkDayDetailsDialog
        open={open?.kind === "details"}
        onOpenChange={(next) => !next && setOpen(null)}
        day={opened}
        userName={opened ? userName(opened.userId) : ""}
        canChange={!!opened && canChange(opened.userId)}
        onEditEntries={() => setOpen((current) => current && { kind: "entries", key: current.key })}
        onEditNotes={() => setOpen((current) => current && { kind: "note", key: current.key })}
      />
      <WorkHoursDialog
        open={open?.kind === "entries"}
        onOpenChange={(next) => !next && backToDetails()}
        userId={open?.key.userId ?? ""}
        userName={open ? userName(open.key.userId) : ""}
        day={open?.key.day ?? ""}
        onSaved={saved}
      />
      <DayNoteDialog
        open={open?.kind === "note"}
        onOpenChange={(next) => !next && backToDetails()}
        userId={open?.key.userId ?? ""}
        day={open?.key.day ?? ""}
        dayLabel={open ? longDay(open.key.day) : ""}
        notes={opened?.notes ?? ""}
        onSaved={saved}
      />
    </Card>
  );
}
