//! Working hours: when each of the clinic's users came in and left, with notes
//! per day.
//!
//! Kept in the local database only (localdb::LOCAL_ONLY_TABLES): never sent to
//! the server. Everyone records their own hours; a manager can also record and
//! see anyone's.
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
fn check_day(day: &str) -> Result<String, Message> {
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

/// Checks that the logged-in user may see and change `user`'s hours: their own,
/// or anyone's for a manager. `user` must be one of this computer's users.
fn check_access(db: &Connection, session: &SessionInfo, user: &str) -> Result<[u8; 16], Message> {
    let user = parse_id(user, "workHours.errors.unknownUser")?;
    if hex::encode(user) != session.user_id && session.role != ROLE_MANAGER {
        return Err(err("workHours.errors.notAllowed"));
    }
    let known: bool = db
        .query_row("SELECT EXISTS (SELECT 1 FROM users WHERE id = ?1)", [user], |row| row.get(0))
        .map_err(internal)?;
    if !known {
        return Err(err("workHours.errors.unknownUser"));
    }
    Ok(user)
}

/// `user`'s entries that started in [from, to) (unix milliseconds), their open
/// one, and their notes of the days in [from_day, to_day) ("YYYY-MM-DD").
pub fn list(
    db: &Connection,
    session: &SessionInfo,
    user: &str,
    (from, to): (i64, i64),
    (from_day, to_day): (&str, &str),
) -> Result<WorkHoursList, Message> {
    let user = check_access(db, session, user)?;
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

/// Adds an entry (no `id`) or changes one. `now` (unix milliseconds) is the
/// latest a time may be: hours are recorded once worked.
pub fn save(
    db: &Connection,
    session: &SessionInfo,
    id: Option<&str>,
    input: &WorkHoursInput,
    now: i64,
) -> Result<WorkHoursRecord, Message> {
    let user = check_access(db, session, &input.user_id)?;
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

    let tx = db.unchecked_transaction().map_err(internal)?;
    let target = match id {
        None => {
            // In order: the last entry's exit comes before any new entry.
            if open_entry(&tx, &user)?.is_some() {
                return Err(err("workHours.errors.exitFirst"));
            }
            *secure::random_bytes::<16>()
        }
        Some(hex_id) => {
            let target = parse_id(hex_id, "workHours.errors.notFound")?;
            let existing = get(&tx, &target)?.ok_or_else(|| err("workHours.errors.notFound"))?;
            // An entry stays with whoever worked it.
            if existing.user_id != hex::encode(user) {
                return Err(err("workHours.errors.notFound"));
            }
            target
        }
    };

    // Another entry of the same user sharing any moment with this one. An open
    // entry lasts until now as far as this goes.
    let overlaps: bool = tx
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM work_hours
                WHERE user_id = ?1 AND id <> ?2
                  AND started_at < coalesce(?4, ?5 + 1)
                  AND ?3 < coalesce(ended_at, ?5 + 1))",
            params![user, target, start, end, now],
            |row| row.get(0),
        )
        .map_err(internal)?;
    if overlaps {
        return Err(err("workHours.errors.overlap"));
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

    let saved = get(&tx, &target)?.ok_or_else(|| internal("saved work hours not found"))?;
    tx.commit().map_err(internal)?;
    Ok(saved)
}

/// Deletes an entry for good (nothing to sync).
pub fn delete(db: &Connection, session: &SessionInfo, id: &str) -> Result<(), Message> {
    let target = parse_id(id, "workHours.errors.notFound")?;
    let existing = get(db, &target)?.ok_or_else(|| err("workHours.errors.notFound"))?;
    check_access(db, session, &existing.user_id)?;
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
    let user = check_access(db, session, user)?;
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

        let found = list(&db, &nurse, &nurse.user_id, period, DAYS).unwrap();
        assert_eq!(found.entries.len(), 3);
        assert_eq!(found.total_millis, 12 * HOUR, "the open entry is not counted");
        assert_eq!(found.open, Some(open.clone()));

        // The exit.
        save(&db, &nurse, Some(&open.id), &entry(2, NOW - HOUR, Some(NOW)), NOW).unwrap();
        let found = list(&db, &nurse, &nurse.user_id, period, DAYS).unwrap();
        assert_eq!(found.total_millis, 13 * HOUR);
        assert_eq!(found.open, None);

        delete(&db, &nurse, &first.id).unwrap();
        assert_eq!(list(&db, &nurse, &nurse.user_id, period, DAYS).unwrap().total_millis, 5 * HOUR);
    }

    #[test]
    fn entries_come_in_order() {
        let db = database("order");
        let nurse = session(2, ROLE_STAFF);
        let open = save(&db, &nurse, None, &entry(2, NOW - 2 * HOUR, None), NOW).unwrap();
        // No new entry before the exit, not even an earlier one typed in.
        let key = |input: WorkHoursInput| save(&db, &nurse, None, &input, NOW).unwrap_err().key;
        assert_eq!(key(entry(2, NOW - HOUR, None)), "workHours.errors.exitFirst");
        assert_eq!(key(entry(2, NOW - 9 * HOUR, Some(NOW - 8 * HOUR))), "workHours.errors.exitFirst");
        // After the exit, any number more the same day.
        save(&db, &nurse, Some(&open.id), &entry(2, NOW - 2 * HOUR, Some(NOW - HOUR)), NOW).unwrap();
        save(&db, &nurse, None, &entry(2, NOW - 9 * HOUR, Some(NOW - 8 * HOUR)), NOW).unwrap();
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
        let notes = |db: &Connection| list(db, &nurse, &nurse.user_id, (0, NOW), DAYS).unwrap().day_notes;
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
    fn staff_see_only_their_own_hours() {
        let db = database("access");
        let (doctor, nurse) = (session(1, localdb::ROLE_MANAGER), session(2, ROLE_STAFF));
        let theirs = save(&db, &doctor, None, &entry(1, NOW - 2 * HOUR, Some(NOW - HOUR)), NOW).unwrap();
        let key = |r: Result<WorkHoursList, Message>| r.unwrap_err().key;
        assert_eq!(key(list(&db, &nurse, &doctor.user_id, (0, NOW), DAYS)), "workHours.errors.notAllowed");
        assert_eq!(save(&db, &nurse, None, &entry(1, NOW - 4 * HOUR, None), NOW).unwrap_err().key, "workHours.errors.notAllowed");
        assert_eq!(delete(&db, &nurse, &theirs.id).unwrap_err().key, "workHours.errors.notAllowed");
        assert_eq!(
            save_day_note(&db, &nurse, &doctor.user_id, "2026-01-05", "x", NOW).unwrap_err().key,
            "workHours.errors.notAllowed"
        );
        // Moving an entry to someone else is refused.
        assert_eq!(
            save(&db, &doctor, Some(&theirs.id), &entry(2, NOW - 2 * HOUR, Some(NOW - HOUR)), NOW).unwrap_err().key,
            "workHours.errors.notFound"
        );

        // A manager can record and see anyone's hours, but only for users of this computer.
        save(&db, &doctor, None, &entry(2, NOW - 2 * HOUR, Some(NOW - HOUR)), NOW).unwrap();
        assert_eq!(list(&db, &doctor, &nurse.user_id, (0, NOW), DAYS).unwrap().total_millis, HOUR);
        assert_eq!(key(list(&db, &doctor, &hex::encode([3u8; 16]), (0, NOW), DAYS)), "workHours.errors.unknownUser");
    }
}
