//! Working hours: when each of the clinic's users came in and left, with notes
//! per day.
//!
//! Kept in the local database only (localdb::LOCAL_ONLY_TABLES): never sent to
//! the server. Everyone can see everyone's hours, but changes only their own; a
//! manager can change anyone's.
//!
//! A user may come and go any number of times a day, but in order: an entry is
//! recorded first, then only its exit. Until the exit is in, no new entry can be
//! added (an entry without an exit is "open"). Entries of the same user never
//! overlap.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::auth::SessionInfo;
use crate::localdb::ROLE_MANAGER;
use crate::message::Message;
use crate::secure;

const MAX_NOTES_CHARS: usize = 1000;
/// The longest one entry can be: anything longer is surely a typo.
const MAX_SHIFT_MILLIS: i64 = 24 * 60 * 60 * 1000;
/// The longest a local day can be (25 hours when clocks go back).
const MAX_DAY_MILLIS: i64 = 25 * 60 * 60 * 1000;

fn err(key: &str) -> Message {
    Message::new(key)
}

fn internal(details: impl std::fmt::Display) -> Message {
    Message::error("errors.unknown", details)
}

fn parse_id(hex_id: &str, not_found: &str) -> Result<[u8; 16], Message> {
    hex::decode(hex_id.trim()).ok().and_then(|b| b.try_into().ok()).ok_or_else(|| err(not_found))
}

/// A day as "YYYY-MM-DD" (Gregorian). Only the shape is checked: it is a key, not a date to compute with.
pub(crate) fn check_day(day: &str) -> Result<String, Message> {
    let day = day.trim();
    let bytes = day.as_bytes();
    let shaped = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes.iter().enumerate().all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit());
    let in_range = shaped && matches!(day[5..7].parse::<u8>(), Ok(1..=12)) && matches!(day[8..].parse::<u8>(), Ok(1..=31));
    if in_range {
        Ok(day.to_owned())
    } else {
        Err(err("workHours.errors.invalidDay"))
    }
}

/// One entry as typed in the form (src/lib/work-hours.ts).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkHoursInput {
    /// Who worked: a local user id (hex).
    pub user_id: String,
    /// Came in, unix milliseconds.
    pub started_at: i64,
    /// Left, unix milliseconds; None while still at work.
    #[serde(default)]
    pub ended_at: Option<i64>,
}

/// One entry as stored, sent to the frontend.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkHoursRecord {
    pub id: String,
    pub user_id: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A user's notes for one day.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayNote {
    /// Local day, Gregorian "YYYY-MM-DD".
    pub day: String,
    pub notes: String,
}

/// A user's entries and notes in a period, with their total.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkHoursList {
    /// Entries that started in the period, oldest first.
    pub entries: Vec<WorkHoursRecord>,
    /// The time worked in the finished ones, in milliseconds.
    pub total_millis: i64,
    /// The user's entry still without an exit, whenever it started.
    pub open: Option<WorkHoursRecord>,
    /// Notes of the days in the period, by day.
    pub day_notes: Vec<DayNote>,
}

const COLUMNS: &str = "id, user_id, started_at, ended_at, created_at, updated_at";

fn from_row(row: &Row) -> rusqlite::Result<WorkHoursRecord> {
    Ok(WorkHoursRecord {
        id: hex::encode(row.get::<_, Vec<u8>>(0)?),
        user_id: hex::encode(row.get::<_, Vec<u8>>(1)?),
        started_at: row.get(2)?,
        ended_at: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn get(db: &Connection, id: &[u8]) -> Result<Option<WorkHoursRecord>, Message> {
    db.query_row(&format!("SELECT {COLUMNS} FROM work_hours WHERE id = ?1"), [id], from_row)
        .optional()
        .map_err(internal)
}

fn open_entry(db: &Connection, user: &[u8; 16]) -> Result<Option<WorkHoursRecord>, Message> {
    db.query_row(&format!("SELECT {COLUMNS} FROM work_hours WHERE user_id = ?1 AND ended_at IS NULL"), [user], from_row)
        .optional()
        .map_err(internal)
}

/// `user` (hex), if they are one of this computer's users: anyone may see their hours.
fn known_user(db: &Connection, user: &str) -> Result<[u8; 16], Message> {
    let user = parse_id(user, "workHours.errors.unknownUser")?;
    let known: bool = db
        .query_row("SELECT EXISTS (SELECT 1 FROM users WHERE id = ?1)", [user], |row| row.get(0))
        .map_err(internal)?;
    if !known {
        return Err(err("workHours.errors.unknownUser"));
    }
    Ok(user)
}

/// Checks that the logged-in user may change `user`'s hours and notes: their own,
/// or anyone's for a manager.
fn check_change(db: &Connection, session: &SessionInfo, user: &str) -> Result<[u8; 16], Message> {
    let user = known_user(db, user)?;
    if hex::encode(user) != session.user_id && session.role != ROLE_MANAGER {
        return Err(err("workHours.errors.notAllowed"));
    }
    Ok(user)
}

/// `user`'s entries that started in [from, to) (unix milliseconds), their open
/// one, and their notes of the days in [from_day, to_day) ("YYYY-MM-DD").
pub fn list(
    db: &Connection,
    user: &str,
    (from, to): (i64, i64),
    (from_day, to_day): (&str, &str),
) -> Result<WorkHoursList, Message> {
    let user = known_user(db, user)?;
    let (from_day, to_day) = (check_day(from_day)?, check_day(to_day)?);
    let entries: Vec<WorkHoursRecord> = db
        .prepare(&format!(
            "SELECT {COLUMNS} FROM work_hours WHERE user_id = ?1 AND started_at >= ?2 AND started_at < ?3
             ORDER BY started_at, id"
        ))
        .and_then(|mut statement| statement.query_map(params![user, from, to], from_row)?.collect())
        .map_err(internal)?;
    let total_millis = entries.iter().filter_map(|e| e.ended_at.map(|end| end - e.started_at)).sum();
    let day_notes: Vec<DayNote> = db
        .prepare("SELECT day, notes FROM work_day_notes WHERE user_id = ?1 AND day >= ?2 AND day < ?3 ORDER BY day")
        .and_then(|mut statement| {
            statement.query_map(params![user, from_day, to_day], |row| Ok(DayNote { day: row.get(0)?, notes: row.get(1)? }))?.collect()
        })
        .map_err(internal)?;
    Ok(WorkHoursList { entries, total_millis, open: open_entry(db, &user)?, day_notes })
}

/// One user's hours in a period, for the overview of everyone.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserTotal {
    /// Local user id (hex).
    pub user_id: String,
    /// The time worked in the finished entries that started in the period, in milliseconds.
    pub total_millis: i64,
    /// Local days with an entry in the period.
    pub days: i64,
    /// Whether they are at work now (an entry without an exit).
    pub at_work: bool,
}

/// Every user's hours in [from, to) (unix milliseconds), everyone included even
/// with none.
pub fn summary(db: &Connection, (from, to): (i64, i64)) -> Result<Vec<UserTotal>, Message> {
    db.prepare(
        // Days are counted in this computer's time zone, like the frontend's.
        "SELECT u.id,
                coalesce(sum(w.ended_at - w.started_at), 0),
                count(DISTINCT date(w.started_at / 1000, 'unixepoch', 'localtime')),
                EXISTS (SELECT 1 FROM work_hours o WHERE o.user_id = u.id AND o.ended_at IS NULL)
         FROM users u
         LEFT JOIN work_hours w ON w.user_id = u.id AND w.started_at >= ?1 AND w.started_at < ?2
         GROUP BY u.id
         ORDER BY u.full_name, u.username",
    )
    .and_then(|mut statement| {
        statement
            .query_map(params![from, to], |row| {
                Ok(UserTotal {
                    user_id: hex::encode(row.get::<_, Vec<u8>>(0)?),
                    total_millis: row.get(1)?,
                    days: row.get(2)?,
                    at_work: row.get(3)?,
                })
            })?
            .collect()
    })
    .map_err(internal)
}

/// Adds an entry (no `id`) or changes one. `now` (unix milliseconds) is the
/// latest a time may be: hours are recorded once worked.
pub fn save(
    db: &Connection,
    session: &SessionInfo,
    id: Option<&str>,
    input: &WorkHoursInput,
    now: i64,
) -> Result<WorkHoursRecord, Message> {
    let tx = db.unchecked_transaction().map_err(internal)?;
    let saved = save_in(&tx, session, id, input, now)?;
    tx.commit().map_err(internal)?;
    Ok(saved)
}

/// An entry's times without whose it is, for one user's day (`replace_day`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryTimes {
    /// Came in, unix milliseconds.
    pub started_at: i64,
    /// Left, unix milliseconds; None while still at work.
    #[serde(default)]
    pub ended_at: Option<i64>,
}

/// Replaces `user`'s entries of one day, [from, to) (the local midnights around
/// it, unix milliseconds), with `entries`: all of them or, if any is refused,
/// none, and the day stays as it was. Each entry must lie within the day (an exit
/// at `to` is midnight). The refusal says which one, counted from 1 in the order
/// given, as `row`. No entries empties the day.
pub fn replace_day(
    db: &Connection,
    session: &SessionInfo,
    user: &str,
    (from, to): (i64, i64),
    entries: &[EntryTimes],
    now: i64,
) -> Result<Vec<WorkHoursRecord>, Message> {
    let user_id = check_change(db, session, user)?;
    if from >= to || to - from > MAX_DAY_MILLIS {
        return Err(internal(format!("invalid day {from}..{to}")));
    }
    let mut order: Vec<usize> = (0..entries.len()).collect();
    order.sort_by_key(|&i| entries[i].started_at);

    let tx = db.unchecked_transaction().map_err(internal)?;
    tx.execute(
        "DELETE FROM work_hours WHERE user_id = ?1 AND started_at >= ?2 AND started_at < ?3",
        params![user_id, from, to],
    )
    .map_err(internal)?;
    let mut saved = Vec::with_capacity(entries.len());
    for i in order {
        let entry = &entries[i];
        let row = |e: Message| e.with("row", i + 1);
        let inside = (from..to).contains(&entry.started_at) && entry.ended_at.is_none_or(|end| end <= to);
        if !inside {
            return Err(row(err("workHours.errors.outsideDay")));
        }
        let input = WorkHoursInput { user_id: user.to_owned(), started_at: entry.started_at, ended_at: entry.ended_at };
        saved.push(save_in(&tx, session, None, &input, now).map_err(row)?);
    }
    tx.commit().map_err(internal)?;
    Ok(saved)
}

/// Records `user`'s exit at `at` (unix milliseconds). If their open entry started
/// on an earlier day, it is cut at each local midnight between its start and
/// `at` (`midnights`, from the frontend, which knows the time zone): it ends at
/// the first, a new entry starts at each, and the last one ends at `at`. Returns
/// the entries ended, oldest first.
pub fn clock_out(
    db: &Connection,
    session: &SessionInfo,
    user: &str,
    at: i64,
    midnights: &[i64],
    now: i64,
) -> Result<Vec<WorkHoursRecord>, Message> {
    let user_id = check_change(db, session, user)?;
    if at > now {
        return Err(err("workHours.errors.inFuture"));
    }
    let tx = db.unchecked_transaction().map_err(internal)?;
    let open = open_entry(&tx, &user_id)?.ok_or_else(|| err("workHours.errors.notAtWork"))?;
    if at <= open.started_at {
        return Err(err("workHours.errors.endBeforeStart"));
    }
    let mut bounds = vec![open.started_at];
    for &midnight in midnights {
        if midnight <= bounds[bounds.len() - 1] || midnight >= at {
            return Err(internal(format!("invalid midnight {midnight} between {} and {at}", open.started_at)));
        }
        bounds.push(midnight);
    }
    bounds.push(at);

    let open_id = parse_id(&open.id, "workHours.errors.notFound")?;
    tx.execute(
        "UPDATE work_hours SET ended_at = ?2, updated_at = ?3 WHERE id = ?1",
        params![open_id, bounds[1], now],
    )
    .map_err(internal)?;
    let mut ended = vec![get(&tx, &open_id)?.ok_or_else(|| internal("ended entry not found"))?];
    for piece in bounds[1..].windows(2) {
        let id = *secure::random_bytes::<16>();
        tx.execute(
            "INSERT INTO work_hours (id, user_id, started_at, ended_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, user_id, piece[0], piece[1], now],
        )
        .map_err(internal)?;
        ended.push(get(&tx, &id)?.ok_or_else(|| internal("new entry not found"))?);
    }
    tx.commit().map_err(internal)?;
    Ok(ended)
}

/// `save` inside a transaction the caller commits.
fn save_in(
    tx: &Connection,
    session: &SessionInfo,
    id: Option<&str>,
    input: &WorkHoursInput,
    now: i64,
) -> Result<WorkHoursRecord, Message> {
    let user = check_change(tx, session, &input.user_id)?;
    let (start, end) = (input.started_at, input.ended_at);
    if start <= 0 {
        return Err(err("workHours.errors.invalidStart"));
    }
    if start > now || end.is_some_and(|end| end > now) {
        return Err(err("workHours.errors.inFuture"));
    }
    if let Some(end) = end {
        if end <= start {
            return Err(err("workHours.errors.endBeforeStart"));
        }
        if end - start > MAX_SHIFT_MILLIS {
            return Err(err("workHours.errors.tooLong"));
        }
    }

    let target = match id {
        None => *secure::random_bytes::<16>(),
        Some(hex_id) => {
            let target = parse_id(hex_id, "workHours.errors.notFound")?;
            let existing = get(tx, &target)?.ok_or_else(|| err("workHours.errors.notFound"))?;
            // An entry stays with whoever worked it.
            if existing.user_id != hex::encode(user) {
                return Err(err("workHours.errors.notFound"));
            }
            target
        }
    };

    // Another entry of the same user sharing a minute with this one. Compared in
    // whole minutes, as the page shows and types times: an entry typed in for the
    // minute the previous exit was clicked in follows it, though the exit has
    // seconds and the entry none. An open entry lasts until now as far as this
    // goes, which also keeps entries in order: nothing new after an entry until
    // its exit (earlier days can still be filled in).
    let clash: Option<(bool, i64)> = tx
        .query_row(
            "SELECT ended_at IS NULL, started_at FROM work_hours
             WHERE user_id = ?1 AND id <> ?2
               AND started_at / 60000 < coalesce(?4, ?5 + 1) / 60000
               AND ?3 / 60000 < coalesce(ended_at, ?5 + 1) / 60000
             ORDER BY ended_at IS NULL DESC LIMIT 1",
            params![user, target, start, end, now],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(internal)?;
    match clash {
        Some((true, open_start)) if start >= open_start => return Err(err("workHours.errors.exitFirst")),
        Some(_) => return Err(err("workHours.errors.overlap")),
        None => {}
    }

    let values = params![target, user, start, end, now];
    if id.is_some() {
        tx.execute("UPDATE work_hours SET started_at = ?3, ended_at = ?4, updated_at = ?5 WHERE id = ?1 AND user_id = ?2", values)
    } else {
        tx.execute(
            "INSERT INTO work_hours (id, user_id, started_at, ended_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            values,
        )
    }
    .map_err(internal)?;

    get(tx, &target)?.ok_or_else(|| internal("saved work hours not found"))
}

/// Deletes an entry for good (nothing to sync).
pub fn delete(db: &Connection, session: &SessionInfo, id: &str) -> Result<(), Message> {
    let target = parse_id(id, "workHours.errors.notFound")?;
    let existing = get(db, &target)?.ok_or_else(|| err("workHours.errors.notFound"))?;
    check_change(db, session, &existing.user_id)?;
    db.execute("DELETE FROM work_hours WHERE id = ?1", [target]).map_err(internal)?;
    Ok(())
}

/// Sets `user`'s notes for `day` ("YYYY-MM-DD"); empty notes remove them.
pub fn save_day_note(
    db: &Connection,
    session: &SessionInfo,
    user: &str,
    day: &str,
    notes: &str,
    now: i64,
) -> Result<DayNote, Message> {
    let user = check_change(db, session, user)?;
    let day = check_day(day)?;
    let notes = notes.trim();
    if notes.chars().count() > MAX_NOTES_CHARS {
        return Err(err("workHours.errors.notesTooLong").with("max", MAX_NOTES_CHARS));
    }
    if notes.is_empty() {
        db.execute("DELETE FROM work_day_notes WHERE user_id = ?1 AND day = ?2", params![user, day])
    } else {
        db.execute(
            "INSERT INTO work_day_notes (user_id, day, notes, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (user_id, day) DO UPDATE SET notes = ?3, updated_at = ?4",
            params![user, day, notes, now],
        )
    }
    .map_err(internal)?;
    Ok(DayNote { day, notes: notes.to_owned() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::localdb::{self, ROLE_STAFF};

    const HOUR: i64 = 60 * 60 * 1000;
    const NOW: i64 = 1_000 * HOUR;
    const DAYS: (&str, &str) = ("2026-01-01", "2026-02-01");

    fn database(name: &str) -> Connection {
        let dir = std::env::temp_dir().join(format!("dental-work-hours-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let db = localdb::create(&dir.join(localdb::DATABASE_FILE), &[11u8; 32]).unwrap();
        localdb::record_login(&db, &[1; 16], "doctor", "Dr. A", localdb::ROLE_MANAGER, 1).unwrap();
        localdb::record_login(&db, &[2; 16], "nurse", "N. B", ROLE_STAFF, 1).unwrap();
        db
    }

    fn session(user: u8, role: &str) -> SessionInfo {
        SessionInfo {
            user_id: hex::encode([user; 16]),
            username: String::new(),
            full_name: String::new(),
            role: role.into(),
            is_admin: false,
            is_owner: false,
            online: false,
            offline_until: 0,
            billing: None,
            locked: false,
        }
    }

    fn entry(user: u8, start: i64, end: Option<i64>) -> WorkHoursInput {
        WorkHoursInput { user_id: hex::encode([user; 16]), started_at: start, ended_at: end }
    }

    #[test]
    fn records_and_totals_a_period() {
        let db = database("totals");
        let nurse = session(2, ROLE_STAFF);
        let period = (NOW - 50 * HOUR, NOW + HOUR);
        let first = save(&db, &nurse, None, &entry(2, NOW - 30 * HOUR, Some(NOW - 22 * HOUR)), NOW).unwrap();
        save(&db, &nurse, None, &entry(2, NOW - 10 * HOUR, Some(NOW - 6 * HOUR)), NOW).unwrap();
        // Before the period: not listed.
        save(&db, &nurse, None, &entry(2, NOW - 100 * HOUR, Some(NOW - 99 * HOUR)), NOW).unwrap();
        let open = save(&db, &nurse, None, &entry(2, NOW - HOUR, None), NOW).unwrap();

        let found = list(&db, &nurse.user_id, period, DAYS).unwrap();
        assert_eq!(found.entries.len(), 3);
        assert_eq!(found.total_millis, 12 * HOUR, "the open entry is not counted");
        assert_eq!(found.open, Some(open.clone()));

        // The exit.
        save(&db, &nurse, Some(&open.id), &entry(2, NOW - HOUR, Some(NOW)), NOW).unwrap();
        let found = list(&db, &nurse.user_id, period, DAYS).unwrap();
        assert_eq!(found.total_millis, 13 * HOUR);
        assert_eq!(found.open, None);

        delete(&db, &nurse, &first.id).unwrap();
        assert_eq!(list(&db, &nurse.user_id, period, DAYS).unwrap().total_millis, 5 * HOUR);
    }

    #[test]
    fn summary_of_everyone() {
        let db = database("summary");
        let (doctor, nurse) = (session(1, localdb::ROLE_MANAGER), session(2, ROLE_STAFF));
        save(&db, &nurse, None, &entry(2, NOW - 30 * HOUR, Some(NOW - 26 * HOUR)), NOW).unwrap();
        save(&db, &nurse, None, &entry(2, NOW - 25 * HOUR, Some(NOW - 24 * HOUR)), NOW).unwrap();
        // Outside the period: not counted.
        save(&db, &nurse, None, &entry(2, NOW - 100 * HOUR, Some(NOW - 99 * HOUR)), NOW).unwrap();
        save(&db, &nurse, None, &entry(2, NOW - HOUR, None), NOW).unwrap();

        let totals = summary(&db, (NOW - 50 * HOUR, NOW + HOUR)).unwrap();
        let doctor_total = totals.iter().find(|t| t.user_id == doctor.user_id).unwrap();
        assert_eq!((doctor_total.total_millis, doctor_total.days, doctor_total.at_work), (0, 0, false), "listed with none");
        let nurse_total = totals.iter().find(|t| t.user_id == nurse.user_id).unwrap();
        assert_eq!(nurse_total.total_millis, 5 * HOUR, "the open entry is not counted");
        assert!(nurse_total.at_work);
        assert!((1..=3).contains(&nurse_total.days), "days depend on the time zone");
    }

    fn times(start: i64, end: Option<i64>) -> EntryTimes {
        EntryTimes { started_at: start, ended_at: end }
    }

    #[test]
    fn replaces_a_day_at_once_or_not_at_all() {
        let db = database("day");
        let nurse = session(2, ROLE_STAFF);
        let day = (NOW - 20 * HOUR, NOW + 4 * HOUR);
        // Another day, untouched by the replacement.
        let before = save(&db, &nurse, None, &entry(2, NOW - 30 * HOUR, Some(NOW - 28 * HOUR)), NOW).unwrap();
        save(&db, &nurse, None, &entry(2, NOW - 10 * HOUR, Some(NOW - 9 * HOUR)), NOW).unwrap();

        let rows = [times(NOW - 4 * HOUR, Some(NOW - 3 * HOUR)), times(NOW - 9 * HOUR, Some(NOW - 5 * HOUR)), times(NOW - 2 * HOUR, None)];
        let saved = replace_day(&db, &nurse, &nurse.user_id, day, &rows, NOW).unwrap();
        // Stored oldest first, whatever the order given; the last one still open.
        assert_eq!(saved.iter().map(|e| e.started_at).collect::<Vec<_>>(), [NOW - 9 * HOUR, NOW - 4 * HOUR, NOW - 2 * HOUR]);
        let found = list(&db, &nurse.user_id, (0, NOW + 4 * HOUR), DAYS).unwrap();
        assert_eq!(found.entries.len(), 4, "the old entry of the day is gone, the other day's kept");
        assert_eq!(found.entries[0], before);
        assert!(found.open.is_some());

        // One bad row (overlapping the first given): nothing changes, and the row is named.
        let rows = [times(NOW - 9 * HOUR, Some(NOW - 5 * HOUR)), times(NOW - 6 * HOUR, Some(NOW - 4 * HOUR))];
        let refused = replace_day(&db, &nurse, &nurse.user_id, day, &rows, NOW).unwrap_err();
        assert_eq!((refused.key.as_str(), refused.params["row"].as_u64()), ("workHours.errors.overlap", Some(2)));
        assert_eq!(list(&db, &nurse.user_id, (0, NOW + 4 * HOUR), DAYS).unwrap().entries.len(), 4);

        // Outside the day: refused. An exit at the day's end (midnight) is inside.
        let refused = replace_day(&db, &nurse, &nurse.user_id, day, &[times(NOW - 21 * HOUR, Some(NOW - 19 * HOUR))], NOW);
        assert_eq!(refused.unwrap_err().key, "workHours.errors.outsideDay");
        let past_day = (NOW - 48 * HOUR, NOW - 24 * HOUR);
        replace_day(&db, &nurse, &nurse.user_id, past_day, &[times(NOW - 26 * HOUR, Some(NOW - 24 * HOUR))], NOW).unwrap();

        // No rows empties the day.
        replace_day(&db, &nurse, &nurse.user_id, day, &[], NOW).unwrap();
        let left = list(&db, &nurse.user_id, day, DAYS).unwrap();
        assert!(left.entries.is_empty() && left.open.is_none());

        // Another user's day: staff cannot.
        let doctor = hex::encode([1u8; 16]);
        assert_eq!(replace_day(&db, &nurse, &doctor, day, &[], NOW).unwrap_err().key, "workHours.errors.notAllowed");
    }

    #[test]
    fn clocking_out_the_next_day_splits_at_midnight() {
        let db = database("midnight");
        let nurse = session(2, ROLE_STAFF);
        let midnight = NOW - 6 * HOUR;
        let open = save(&db, &nurse, None, &entry(2, midnight - 3 * HOUR, None), NOW).unwrap();

        let ended = clock_out(&db, &nurse, &nurse.user_id, NOW - 2 * HOUR, &[midnight], NOW).unwrap();
        let spans: Vec<_> = ended.iter().map(|e| (e.started_at, e.ended_at)).collect();
        assert_eq!(spans, [(midnight - 3 * HOUR, Some(midnight)), (midnight, Some(NOW - 2 * HOUR))]);
        assert_eq!(ended[0].id, open.id, "the open entry ends at midnight");
        assert_eq!(clock_out(&db, &nurse, &nurse.user_id, NOW, &[], NOW).unwrap_err().key, "workHours.errors.notAtWork");

        // Several days: cut at each midnight. The same day: no cut.
        save(&db, &nurse, None, &entry(2, NOW - HOUR, None), NOW).unwrap();
        assert_eq!(clock_out(&db, &nurse, &nurse.user_id, NOW, &[], NOW).unwrap().len(), 1);
        let db = database("midnights");
        save(&db, &nurse, None, &entry(2, NOW - 50 * HOUR, None), NOW).unwrap();
        let ended = clock_out(&db, &nurse, &nurse.user_id, NOW, &[NOW - 48 * HOUR, NOW - 24 * HOUR], NOW).unwrap();
        assert_eq!(ended.len(), 3);
        // Midnights out of place are a bug, not the user's.
        let db = database("bad-midnight");
        save(&db, &nurse, None, &entry(2, NOW - HOUR, None), NOW).unwrap();
        assert_eq!(clock_out(&db, &nurse, &nurse.user_id, NOW, &[NOW - 2 * HOUR], NOW).unwrap_err().key, "errors.unknown");
    }

    /// The form keeps only hours and minutes, the buttons the exact moment: an entry
    /// typed in for the minute an exit was clicked in still follows it.
    #[test]
    fn several_entries_a_day_from_buttons_and_form() {
        let db = database("several");
        let nurse = session(2, ROLE_STAFF);
        const MINUTE: i64 = 60 * 1000;
        let day = NOW - 10 * HOUR; // a whole minute
        // Clock in and out with the buttons, a few seconds into a minute.
        let first = save(&db, &nurse, None, &entry(2, day + 5_000, None), NOW).unwrap();
        save(&db, &nurse, Some(&first.id), &entry(2, day + 5_000, Some(day + 2 * MINUTE + 45_000)), NOW).unwrap();
        // The next entry typed in with "now" in that same minute: 2 minutes, no seconds.
        let second = save(&db, &nurse, None, &entry(2, day + 2 * MINUTE, Some(day + 30 * MINUTE)), NOW).unwrap();
        // And again with the buttons.
        let third = save(&db, &nurse, None, &entry(2, day + 31 * MINUTE + 1_000, None), NOW).unwrap();
        save(&db, &nurse, Some(&third.id), &entry(2, day + 31 * MINUTE + 1_000, Some(day + 40 * MINUTE)), NOW).unwrap();

        let found = list(&db, &nurse.user_id, (day, NOW), DAYS).unwrap();
        assert_eq!(found.entries.len(), 3);
        assert_eq!(found.entries[1].id, second.id);
        // A real overlap of a minute or more is still refused.
        let overlapping = entry(2, day + 29 * MINUTE, Some(day + 35 * MINUTE));
        assert_eq!(save(&db, &nurse, None, &overlapping, NOW).unwrap_err().key, "workHours.errors.overlap");
    }

    #[test]
    fn entries_come_in_order() {
        let db = database("order");
        let nurse = session(2, ROLE_STAFF);
        let open = save(&db, &nurse, None, &entry(2, NOW - 2 * HOUR, None), NOW).unwrap();
        // No new entry before the exit, not even an earlier one typed in.
        let key = |input: WorkHoursInput| save(&db, &nurse, None, &input, NOW).unwrap_err().key;
        assert_eq!(key(entry(2, NOW - HOUR, None)), "workHours.errors.exitFirst");
        // Earlier times can still be filled in.
        save(&db, &nurse, None, &entry(2, NOW - 9 * HOUR, Some(NOW - 8 * HOUR)), NOW).unwrap();
        // After the exit, any number more the same day.
        save(&db, &nurse, Some(&open.id), &entry(2, NOW - 2 * HOUR, Some(NOW - HOUR)), NOW).unwrap();
        save(&db, &nurse, None, &entry(2, NOW - HOUR, None), NOW).unwrap();
    }

    #[test]
    fn checks_times() {
        let db = database("times");
        let nurse = session(2, ROLE_STAFF);
        let key = |input: WorkHoursInput| save(&db, &nurse, None, &input, NOW).unwrap_err().key;
        assert_eq!(key(entry(2, NOW - HOUR, Some(NOW - 2 * HOUR))), "workHours.errors.endBeforeStart");
        assert_eq!(key(entry(2, NOW - 30 * HOUR, Some(NOW))), "workHours.errors.tooLong");
        assert_eq!(key(entry(2, NOW + HOUR, None)), "workHours.errors.inFuture");
        assert_eq!(key(entry(2, NOW - HOUR, Some(NOW + HOUR))), "workHours.errors.inFuture");
        assert_eq!(key(entry(2, 0, None)), "workHours.errors.invalidStart");

        save(&db, &nurse, None, &entry(2, NOW - 10 * HOUR, Some(NOW - 6 * HOUR)), NOW).unwrap();
        assert_eq!(key(entry(2, NOW - 7 * HOUR, Some(NOW - 5 * HOUR))), "workHours.errors.overlap");
        assert_eq!(key(entry(2, NOW - 11 * HOUR, None)), "workHours.errors.overlap", "open from before an entry");
        // Back to back is fine, and another user's hours do not count.
        save(&db, &nurse, None, &entry(2, NOW - 6 * HOUR, Some(NOW - 5 * HOUR)), NOW).unwrap();
        let doctor = session(1, localdb::ROLE_MANAGER);
        save(&db, &doctor, None, &entry(1, NOW - 7 * HOUR, Some(NOW - 5 * HOUR)), NOW).unwrap();
    }

    #[test]
    fn notes_per_day() {
        let db = database("notes");
        let nurse = session(2, ROLE_STAFF);
        save_day_note(&db, &nurse, &nurse.user_id, "2026-01-05", " first ", NOW).unwrap();
        save_day_note(&db, &nurse, &nurse.user_id, "2026-01-05", "changed", NOW).unwrap();
        save_day_note(&db, &nurse, &nurse.user_id, "2026-01-09", "other", NOW).unwrap();
        save_day_note(&db, &nurse, &nurse.user_id, "2026-02-01", "next month", NOW).unwrap();
        let notes = |db: &Connection| list(db, &nurse.user_id, (0, NOW), DAYS).unwrap().day_notes;
        assert_eq!(
            notes(&db),
            [
                DayNote { day: "2026-01-05".into(), notes: "changed".into() },
                DayNote { day: "2026-01-09".into(), notes: "other".into() }
            ]
        );
        save_day_note(&db, &nurse, &nurse.user_id, "2026-01-09", "  ", NOW).unwrap();
        assert_eq!(notes(&db).len(), 1, "empty notes are removed");

        let key = |day: &str| save_day_note(&db, &nurse, &nurse.user_id, day, "x", NOW).unwrap_err().key;
        assert_eq!(key("2026-1-5"), "workHours.errors.invalidDay");
        assert_eq!(key("2026-13-01"), "workHours.errors.invalidDay");
        assert_eq!(key("۲۰۲۶-01-05"), "workHours.errors.invalidDay");
    }

    #[test]
    fn everyone_sees_all_but_changes_only_their_own() {
        let db = database("access");
        let (doctor, nurse) = (session(1, localdb::ROLE_MANAGER), session(2, ROLE_STAFF));
        let theirs = save(&db, &doctor, None, &entry(1, NOW - 2 * HOUR, Some(NOW - HOUR)), NOW).unwrap();
        save_day_note(&db, &doctor, &doctor.user_id, "2026-01-05", "busy day", NOW).unwrap();

        // Anyone sees another user's hours and notes, and everyone's totals.
        let found = list(&db, &doctor.user_id, (0, NOW), DAYS).unwrap();
        assert_eq!((found.total_millis, found.day_notes.len()), (HOUR, 1));
        assert_eq!(summary(&db, (0, NOW)).unwrap().len(), 2);

        // Staff change only their own.
        let refused = |r: Result<WorkHoursRecord, Message>| r.unwrap_err().key;
        assert_eq!(refused(save(&db, &nurse, None, &entry(1, NOW - 4 * HOUR, None), NOW)), "workHours.errors.notAllowed");
        let edited = entry(1, NOW - 3 * HOUR, Some(NOW - HOUR));
        assert_eq!(refused(save(&db, &nurse, Some(&theirs.id), &edited, NOW)), "workHours.errors.notAllowed");
        assert_eq!(delete(&db, &nurse, &theirs.id).unwrap_err().key, "workHours.errors.notAllowed");
        assert_eq!(
            save_day_note(&db, &nurse, &doctor.user_id, "2026-01-05", "x", NOW).unwrap_err().key,
            "workHours.errors.notAllowed"
        );
        // Moving an entry to someone else is refused.
        let moved = entry(2, NOW - 2 * HOUR, Some(NOW - HOUR));
        assert_eq!(refused(save(&db, &doctor, Some(&theirs.id), &moved, NOW)), "workHours.errors.notFound");

        // A manager changes anyone's hours, but only for users of this computer.
        save(&db, &doctor, None, &entry(2, NOW - 2 * HOUR, Some(NOW - HOUR)), NOW).unwrap();
        assert_eq!(list(&db, &nurse.user_id, (0, NOW), DAYS).unwrap().total_millis, HOUR);
        let unknown = hex::encode([3u8; 16]);
        assert_eq!(list(&db, &unknown, (0, NOW), DAYS).unwrap_err().key, "workHours.errors.unknownUser");
    }
}
