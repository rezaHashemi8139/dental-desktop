//! Reminders: short notes a user leaves on a day of the home calendar, any number
//! a day. Each user sees and changes only their own.
//!
//! Kept in the local database only (localdb::LOCAL_ONLY_TABLES): never sent to
//! the server.

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::auth::SessionInfo;
use crate::message::Message;
use crate::secure;
use crate::work_hours::check_day;

const MAX_TEXT_CHARS: usize = 500;

fn err(key: &str) -> Message {
    Message::new(key)
}

fn internal(details: impl std::fmt::Display) -> Message {
    Message::error("errors.unknown", details)
}

fn user_id(session: &SessionInfo) -> Result<[u8; 16], Message> {
    hex::decode(&session.user_id)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| internal("session user id is not 16 bytes"))
}

fn day(day: &str) -> Result<String, Message> {
    check_day(day).map_err(|_| err("reminders.errors.invalidDay"))
}

/// One reminder, sent to the frontend.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub id: String,
    /// Local day, Gregorian "YYYY-MM-DD".
    pub day: String,
    pub text: String,
    /// Unix milliseconds.
    pub created_at: i64,
}

/// The logged-in user's reminders of the days in [from_day, to_day) ("YYYY-MM-DD"),
/// by day, then in the order they were added.
pub fn list(db: &Connection, session: &SessionInfo, from_day: &str, to_day: &str) -> Result<Vec<Reminder>, Message> {
    let user = user_id(session)?;
    let (from_day, to_day) = (day(from_day)?, day(to_day)?);
    let mut statement = db
        .prepare(
            "SELECT id, day, text, created_at FROM reminders
             WHERE user_id = ?1 AND day >= ?2 AND day < ?3 ORDER BY day, created_at, id",
        )
        .map_err(internal)?;
    let rows = statement
        .query_map(params![user, from_day, to_day], |row| {
            Ok(Reminder {
                id: hex::encode(row.get::<_, Vec<u8>>(0)?),
                day: row.get(1)?,
                text: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(internal)?;
    rows.collect::<rusqlite::Result<_>>().map_err(internal)
}

/// Adds a reminder for the logged-in user on `day` ("YYYY-MM-DD").
pub fn add(db: &Connection, session: &SessionInfo, day_iso: &str, text: &str, now: i64) -> Result<Reminder, Message> {
    let user = user_id(session)?;
    let day = day(day_iso)?;
    let text = text.trim();
    if text.is_empty() {
        return Err(err("reminders.errors.empty"));
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(err("reminders.errors.tooLong").with("max", MAX_TEXT_CHARS));
    }
    let id = *secure::random_bytes::<16>();
    db.execute(
        "INSERT INTO reminders (id, user_id, day, text, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, user, day, text, now],
    )
    .map_err(internal)?;
    Ok(Reminder { id: hex::encode(id), day, text: text.to_owned(), created_at: now })
}

/// Deletes one of the logged-in user's reminders.
pub fn delete(db: &Connection, session: &SessionInfo, id: &str) -> Result<(), Message> {
    let user = user_id(session)?;
    let id: [u8; 16] = hex::decode(id.trim())
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| err("reminders.errors.notFound"))?;
    let deleted = db
        .execute("DELETE FROM reminders WHERE id = ?1 AND user_id = ?2", params![id, user])
        .map_err(internal)?;
    if deleted == 0 {
        return Err(err("reminders.errors.notFound"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::localdb::{self, ROLE_STAFF};

    const NOW: i64 = 1_000_000;

    fn database(name: &str) -> Connection {
        let dir = std::env::temp_dir().join(format!("dental-reminders-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        localdb::create(&dir.join(localdb::DATABASE_FILE), &[12u8; 32]).unwrap()
    }

    fn session(user: u8) -> SessionInfo {
        SessionInfo {
            user_id: hex::encode([user; 16]),
            username: String::new(),
            full_name: String::new(),
            role: ROLE_STAFF.into(),
            is_admin: false,
            is_owner: false,
            online: false,
            offline_until: 0,
            billing: None,
            locked: false,
        }
    }

    #[test]
    fn several_a_day_and_personal() {
        let db = database("several");
        let nurse = session(2);
        let doctor = session(1);
        let first = add(&db, &nurse, "2026-01-05", " call the lab ", NOW).unwrap();
        add(&db, &nurse, "2026-01-05", "order gloves", NOW + 1).unwrap();
        add(&db, &nurse, "2026-02-01", "next month", NOW).unwrap();
        add(&db, &doctor, "2026-01-05", "not the nurse's", NOW).unwrap();

        let month = list(&db, &nurse, "2026-01-01", "2026-02-01").unwrap();
        let texts: Vec<_> = month.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(texts, ["call the lab", "order gloves"]);

        // Only the owner can delete it.
        assert_eq!(delete(&db, &doctor, &first.id).unwrap_err().key, "reminders.errors.notFound");
        delete(&db, &nurse, &first.id).unwrap();
        assert_eq!(list(&db, &nurse, "2026-01-01", "2026-02-01").unwrap().len(), 1);
        assert_eq!(delete(&db, &nurse, &first.id).unwrap_err().key, "reminders.errors.notFound");
    }

    #[test]
    fn checks_input() {
        let db = database("checks");
        let nurse = session(2);
        let key = |day: &str, text: &str| add(&db, &nurse, day, text, NOW).unwrap_err().key;
        assert_eq!(key("2026-01-05", "   "), "reminders.errors.empty");
        assert_eq!(key("2026-01-05", &"x".repeat(MAX_TEXT_CHARS + 1)), "reminders.errors.tooLong");
        assert_eq!(key("2026-13-05", "x"), "reminders.errors.invalidDay");
        assert_eq!(delete(&db, &nurse, "nonsense").unwrap_err().key, "reminders.errors.notFound");
    }
}
