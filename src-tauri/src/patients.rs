//! Patients and their treatments in the local database.
//!
//! Every change is saved here first and marked for syncing (`sync_state`, see
//! localdb.rs): the app works the same offline, and sync.rs sends the changes to
//! the server once it can. Financial data never goes in these tables; it belongs
//! in local-only tables (localdb::LOCAL_ONLY_TABLES).
//!
//! A patient is a person, unique across the whole system by identification code
//! (see person.rs), and their id is derived from it
//! (`patient_id`): every installation gives the same person the same id, even
//! offline, so their records meet on the server.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::localdb::{SYNC_NEW, SYNC_REJECTED};
use crate::message::Message;
use crate::person::{self, latin_digits};
use crate::secure;

/// Patients per page of the list (PATIENT_PAGE_SIZE in src/lib/patients.ts).
const LIST_PAGE_SIZE: i64 = 20;

const MAX_NAME_CHARS: usize = 100;
const MAX_ADDRESS_CHARS: usize = 500;
const MAX_NOTES_CHARS: usize = 5000;
const MAX_TOOTH_CHARS: usize = 20;
const MAX_PROCEDURE_CHARS: usize = 200;

fn err(key: &str) -> Message {
    Message::new(key)
}

fn internal(details: impl std::fmt::Display) -> Message {
    Message::error("errors.unknown", details)
}

/// A patient's id, from their identification code (already normalized): the same
/// on every installation and on the server (Patient.id in
/// dental-server/proto/dental/v1/patient.proto).
pub fn patient_id(code: &str) -> [u8; 16] {
    let input = format!("dental/patient/v2\0{code}");
    let mut id = [0u8; 16];
    id.copy_from_slice(&secure::sha256(input.as_bytes())[..16]);
    id[6] = (id[6] & 0x0f) | 0x80; // version 8
    id[8] = (id[8] & 0x3f) | 0x80; // RFC 4122 variant
    id
}

// ---------------------------------------------------------------------------
// Checks shared by patients and treatments

fn required(text: &str, max: usize, missing: &str) -> Result<String, Message> {
    let text = text.trim();
    if text.is_empty() {
        return Err(err(missing));
    }
    optional(text, max)
}

fn optional(text: &str, max: usize) -> Result<String, Message> {
    let text = text.trim();
    if text.chars().count() > max {
        return Err(err("patients.errors.tooLong").with("max", max));
    }
    Ok(text.to_owned())
}

fn check_phone(phone: &str) -> Result<String, Message> {
    let phone: String = latin_digits(phone).chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
    let digits = phone.strip_prefix('+').unwrap_or(&phone);
    if phone.is_empty() || ((7..=15).contains(&digits.len()) && digits.chars().all(|c| c.is_ascii_digit())) {
        Ok(phone)
    } else {
        Err(err("patients.errors.invalidPhone"))
    }
}

/// A Gregorian "YYYY-MM-DD" that exists, or empty.
fn check_date(date: &str) -> Result<String, Message> {
    let date = latin_digits(date.trim());
    if date.is_empty() {
        return Ok(date);
    }
    let parts: Vec<u32> = date.split('-').filter_map(|p| p.parse().ok()).collect();
    let shaped = date.len() == 10 && date.as_bytes()[4] == b'-' && date.as_bytes()[7] == b'-';
    let valid = shaped
        && parts.len() == 3
        && (1..=12).contains(&parts[1])
        && (1..=days_in_month(parts[0], parts[1])).contains(&parts[2]);
    if valid {
        Ok(date)
    } else {
        Err(err("patients.errors.invalidBirthDate"))
    }
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        2 if (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn parse_id(hex_id: &str, not_found: &str) -> Result<[u8; 16], Message> {
    hex::decode(hex_id).ok().and_then(|b| b.try_into().ok()).ok_or_else(|| err(not_found))
}

/// The next `updated_at` of a record: now, but always later than its previous one,
/// so the change wins over what it replaces and an edit during a sync is noticed.
fn next_update(previous: Option<i64>, now: i64) -> i64 {
    previous.map_or(now, |previous| now.max(previous + 1))
}

/// `sync_state` after a local change: a record the server never stored stays new.
const CHANGED_STATE: &str = "CASE sync_state WHEN 'new' THEN 'new' ELSE 'changed' END";

// ---------------------------------------------------------------------------
// Patients

/// A patient as typed in a form.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatientInput {
    /// The identification code.
    pub identity: String,
    pub first_name: String,
    pub last_name: String,
    #[serde(default)]
    pub birth_date: String,
    /// "", "male" or "female".
    #[serde(default)]
    pub gender: String,
    #[serde(default)]
    pub phone: String,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub medical_notes: String,
}

/// A patient as stored, sent to the frontend.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatientRecord {
    /// 32 hex digits.
    pub id: String,
    pub identity: String,
    pub first_name: String,
    pub last_name: String,
    pub birth_date: String,
    pub gender: String,
    pub phone: String,
    pub address: String,
    pub medical_notes: String,
    /// Unix milliseconds.
    pub created_at: i64,
    pub updated_at: i64,
    /// "new", "changed", "synced" or "rejected" (see localdb.rs).
    pub sync_state: String,
}

const PATIENT_COLUMNS: &str =
    "id, identity, first_name, last_name, birth_date, gender, phone, address, medical_notes, created_at, updated_at, sync_state";

fn patient_from_row(row: &Row) -> rusqlite::Result<PatientRecord> {
    Ok(PatientRecord {
        id: hex::encode(row.get::<_, Vec<u8>>(0)?),
        identity: row.get(1)?,
        first_name: row.get(2)?,
        last_name: row.get(3)?,
        birth_date: row.get(4)?,
        gender: row.get(5)?,
        phone: row.get(6)?,
        address: row.get(7)?,
        medical_notes: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        sync_state: row.get(11)?,
    })
}

/// A checked PatientInput, ready to store.
struct CheckedPatient {
    id: [u8; 16],
    code: String,
    first_name: String,
    last_name: String,
    birth_date: String,
    gender: String,
    phone: String,
    address: String,
    medical_notes: String,
}

fn check_patient(input: &PatientInput) -> Result<CheckedPatient, Message> {
    let code = person::normalize(&input.identity)?;
    let gender = match input.gender.trim() {
        g @ ("" | "male" | "female") => g.to_owned(),
        _ => return Err(err("patients.errors.invalidGender")),
    };
    Ok(CheckedPatient {
        id: patient_id(&code),
        code,
        first_name: required(&input.first_name, MAX_NAME_CHARS, "patients.errors.nameRequired")?,
        last_name: required(&input.last_name, MAX_NAME_CHARS, "patients.errors.nameRequired")?,
        birth_date: check_date(&input.birth_date)?,
        gender,
        phone: check_phone(&input.phone)?,
        address: optional(&input.address, MAX_ADDRESS_CHARS)?,
        medical_notes: optional(&input.medical_notes, MAX_NOTES_CHARS)?,
    })
}

pub fn get_patient(db: &Connection, id: &[u8]) -> Result<Option<PatientRecord>, Message> {
    db.query_row(&format!("SELECT {PATIENT_COLUMNS} FROM patients WHERE id = ?1"), [id], patient_from_row)
        .optional()
        .map_err(internal)
}

/// Saves a patient and marks the change for syncing.
///
/// - Without `id`: adds the patient, or, if someone with the same identity is
///   already here, updates them (the same person is never stored twice).
/// - With `id` (hex): updates that patient. Their identity may change only while
///   the server has never stored them (a typo caught early); the patient then gets
///   the id of the new identity, and their treatments follow.
pub fn save_patient(db: &Connection, id: Option<&str>, input: &PatientInput, now: i64) -> Result<PatientRecord, Message> {
    let patient = check_patient(input)?;
    let tx = db.unchecked_transaction().map_err(internal)?;

    let target = match id {
        None => patient.id,
        Some(hex_id) => {
            let current = parse_id(hex_id, "patients.errors.notFound")?;
            let existing = get_patient(&tx, &current)?.ok_or_else(|| err("patients.errors.notFound"))?;
            if current != patient.id {
                // A new identity: only for patients the server does not know yet.
                if existing.sync_state != SYNC_NEW && existing.sync_state != SYNC_REJECTED {
                    return Err(err("patients.errors.identityLocked"));
                }
                if get_patient(&tx, &patient.id)?.is_some() {
                    return Err(err("patients.errors.identityTaken"));
                }
                tx.execute("UPDATE patients SET id = ?2, sync_state = 'new' WHERE id = ?1", params![current, patient.id])
                    .map_err(internal)?;
                tx.execute(
                    &format!(
                        "UPDATE treatments SET patient_id = ?2, updated_at = max(?3, updated_at + 1), sync_state = {CHANGED_STATE}
                         WHERE patient_id = ?1"
                    ),
                    params![current, patient.id, now],
                )
                .map_err(internal)?;
            }
            patient.id
        }
    };

    let previous: Option<i64> = tx
        .query_row("SELECT updated_at FROM patients WHERE id = ?1", [target], |row| row.get(0))
        .optional()
        .map_err(internal)?;
    let updated_at = next_update(previous, now);
    let values = params![
        target,
        patient.code,
        patient.first_name,
        patient.last_name,
        patient.birth_date,
        patient.gender,
        patient.phone,
        patient.address,
        patient.medical_notes,
        updated_at,
    ];
    if previous.is_some() {
        // A patient the server refused was never stored there: still new.
        tx.execute(
            "UPDATE patients SET identity = ?2, first_name = ?3, last_name = ?4, birth_date = ?5, gender = ?6,
                phone = ?7, address = ?8, medical_notes = ?9, updated_at = ?10,
                sync_state = CASE sync_state WHEN 'new' THEN 'new' WHEN 'rejected' THEN 'new' ELSE 'changed' END
             WHERE id = ?1",
            values,
        )
    } else {
        tx.execute(
            "INSERT INTO patients (id, identity, first_name, last_name, birth_date, gender, phone, address,
                medical_notes, updated_at, created_at, sync_state)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, 'new')",
            values,
        )
    }
    .map_err(internal)?;

    let saved = get_patient(&tx, &target)?.ok_or_else(|| internal("saved patient not found"))?;
    tx.commit().map_err(internal)?;
    Ok(saved)
}

/// One page of the patient list.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatientPage {
    pub patients: Vec<PatientRecord>,
    /// Matching patients on every page.
    pub total: i64,
}

/// A LIKE pattern (with ESCAPE '\') for text that contains `text`.
fn contains_pattern(text: &str) -> String {
    format!("%{}%", text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"))
}

/// Page `page` (from 1; 0 means 1) of the patients whose name ("first last"),
/// identification code or phone contains `query` (all if empty), by name. Codes
/// and phones are stored without spaces or dashes, so they are compared to the
/// query without those too: "0912 123" finds 09121234567.
pub fn list_patients(db: &Connection, query: &str, page: u32) -> Result<PatientPage, Message> {
    let query = latin_digits(query.trim());
    let compact: String = query.chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
    let (pattern, compact_pattern) = (contains_pattern(&query), contains_pattern(&compact));
    let filter = "WHERE ?1 = '%%'
        OR first_name || ' ' || last_name LIKE ?1 ESCAPE '\\'
        OR (?2 <> '%%' AND (identity LIKE ?2 ESCAPE '\\' OR phone LIKE ?2 ESCAPE '\\'))";

    let total = db
        .query_row(&format!("SELECT count(*) FROM patients {filter}"), params![pattern, compact_pattern], |row| row.get(0))
        .map_err(internal)?;
    let offset = (i64::from(page.max(1)) - 1) * LIST_PAGE_SIZE;
    let mut statement = db
        .prepare(&format!(
            "SELECT {PATIENT_COLUMNS} FROM patients {filter}
             ORDER BY last_name, first_name, id LIMIT ?3 OFFSET ?4"
        ))
        .map_err(internal)?;
    let rows = statement
        .query_map(params![pattern, compact_pattern, LIST_PAGE_SIZE, offset], patient_from_row)
        .map_err(internal)?;
    let patients = rows.collect::<rusqlite::Result<_>>().map_err(internal)?;
    Ok(PatientPage { patients, total })
}

// ---------------------------------------------------------------------------
// Treatments

/// A treatment as typed in a form.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreatmentInput {
    /// The patient (hex).
    pub patient_id: String,
    /// Server user id (hex) of who performed it, if given.
    #[serde(default)]
    pub performed_by: Option<String>,
    /// Unix milliseconds.
    pub performed_at: i64,
    #[serde(default)]
    pub tooth: String,
    pub procedure: String,
    #[serde(default)]
    pub notes: String,
}

/// A treatment as stored, sent to the frontend. Deleted ones are not listed.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreatmentRecord {
    pub id: String,
    pub patient_id: String,
    pub performed_by: Option<String>,
    pub performed_at: i64,
    pub tooth: String,
    pub procedure: String,
    pub notes: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub sync_state: String,
}

const TREATMENT_COLUMNS: &str =
    "id, patient_id, performed_by, performed_at, tooth, procedure, notes, created_at, updated_at, sync_state";

fn treatment_from_row(row: &Row) -> rusqlite::Result<TreatmentRecord> {
    Ok(TreatmentRecord {
        id: hex::encode(row.get::<_, Vec<u8>>(0)?),
        patient_id: hex::encode(row.get::<_, Vec<u8>>(1)?),
        performed_by: row.get::<_, Option<Vec<u8>>>(2)?.map(hex::encode),
        performed_at: row.get(3)?,
        tooth: row.get(4)?,
        procedure: row.get(5)?,
        notes: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        sync_state: row.get(9)?,
    })
}

fn get_treatment(db: &Connection, id: &[u8]) -> Result<Option<TreatmentRecord>, Message> {
    db.query_row(
        &format!("SELECT {TREATMENT_COLUMNS} FROM treatments WHERE id = ?1 AND deleted_at IS NULL"),
        [id],
        treatment_from_row,
    )
    .optional()
    .map_err(internal)
}

/// Saves a treatment (new without `id`) and marks the change for syncing.
pub fn save_treatment(db: &Connection, id: Option<&str>, input: &TreatmentInput, now: i64) -> Result<TreatmentRecord, Message> {
    let patient = parse_id(&input.patient_id, "patients.errors.notFound")?;
    if get_patient(db, &patient)?.is_none() {
        return Err(err("patients.errors.notFound"));
    }
    let performed_by: Option<[u8; 16]> = match input.performed_by.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(hex_id) => Some(parse_id(hex_id, "treatments.errors.invalidPerformer")?),
    };
    let procedure = required(&input.procedure, MAX_PROCEDURE_CHARS, "treatments.errors.procedureRequired")?;
    let tooth = optional(&input.tooth, MAX_TOOTH_CHARS)?;
    let notes = optional(&input.notes, MAX_NOTES_CHARS)?;
    if input.performed_at <= 0 {
        return Err(err("treatments.errors.invalidDate"));
    }

    let tx = db.unchecked_transaction().map_err(internal)?;
    let target = match id {
        None => *secure::random_bytes::<16>(),
        Some(hex_id) => parse_id(hex_id, "treatments.errors.notFound")?,
    };
    let previous: Option<i64> = if id.is_some() {
        Some(
            tx.query_row("SELECT updated_at FROM treatments WHERE id = ?1 AND deleted_at IS NULL", [target], |row| row.get(0))
                .optional()
                .map_err(internal)?
                .ok_or_else(|| err("treatments.errors.notFound"))?,
        )
    } else {
        None
    };
    let updated_at = next_update(previous, now);
    let values = params![target, patient, performed_by, input.performed_at, tooth, procedure, notes, updated_at];
    if previous.is_some() {
        tx.execute(
            &format!(
                "UPDATE treatments SET patient_id = ?2, performed_by = ?3, performed_at = ?4, tooth = ?5,
                    procedure = ?6, notes = ?7, updated_at = ?8, sync_state = {CHANGED_STATE}
                 WHERE id = ?1"
            ),
            values,
        )
    } else {
        tx.execute(
            "INSERT INTO treatments (id, patient_id, performed_by, performed_at, tooth, procedure, notes,
                updated_at, created_at, sync_state)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, 'new')",
            values,
        )
    }
    .map_err(internal)?;

    let saved = get_treatment(&tx, &target)?.ok_or_else(|| internal("saved treatment not found"))?;
    tx.commit().map_err(internal)?;
    Ok(saved)
}

/// Deletes a treatment. It stays as a tombstone, so the deletion reaches the
/// server and the clinic's other installations.
pub fn delete_treatment(db: &Connection, id: &str, now: i64) -> Result<(), Message> {
    let id = parse_id(id, "treatments.errors.notFound")?;
    let changed = db
        .execute(
            &format!(
                "UPDATE treatments SET deleted_at = ?2, updated_at = max(?2, updated_at + 1), sync_state = {CHANGED_STATE}
                 WHERE id = ?1 AND deleted_at IS NULL"
            ),
            params![id, now],
        )
        .map_err(internal)?;
    if changed == 0 {
        return Err(err("treatments.errors.notFound"));
    }
    Ok(())
}

/// A patient's treatments in this clinic, newest first.
pub fn list_treatments(db: &Connection, patient_id: &str) -> Result<Vec<TreatmentRecord>, Message> {
    let patient = parse_id(patient_id, "patients.errors.notFound")?;
    let mut statement = db
        .prepare(&format!(
            "SELECT {TREATMENT_COLUMNS} FROM treatments WHERE patient_id = ?1 AND deleted_at IS NULL
             ORDER BY performed_at DESC"
        ))
        .map_err(internal)?;
    let rows = statement.query_map([patient], treatment_from_row).map_err(internal)?;
    rows.collect::<rusqlite::Result<_>>().map_err(internal)
}

// ---------------------------------------------------------------------------
// History across clinics (from the server, never stored here)

/// A patient's history in every clinic, sent to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatientHistory {
    pub identity: String,
    pub first_name: String,
    pub last_name: String,
    pub birth_date: String,
    pub gender: String,
    pub phone: String,
    pub address: String,
    pub medical_notes: String,
    /// Newest first.
    pub treatments: Vec<HistoryEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    /// Unix milliseconds.
    pub performed_at: i64,
    pub tooth: String,
    pub procedure: String,
    pub notes: String,
    pub clinic_name: String,
    pub clinic_city: String,
    /// Empty if not given.
    pub performed_by_name: String,
}

fn millis(timestamp: &Option<prost_types::Timestamp>) -> i64 {
    timestamp.as_ref().map_or(0, |t| t.seconds * 1000 + i64::from(t.nanos) / 1_000_000)
}

pub fn history_from_proto(response: crate::proto::GetPatientHistoryResponse) -> PatientHistory {
    let patient = response.patient.unwrap_or_default();
    let identity = patient.identity.unwrap_or_default();
    PatientHistory {
        identity: identity.number,
        first_name: patient.first_name,
        last_name: patient.last_name,
        birth_date: patient.birth_date,
        gender: match crate::proto::Gender::try_from(patient.gender) {
            Ok(crate::proto::Gender::Male) => "male".to_owned(),
            Ok(crate::proto::Gender::Female) => "female".to_owned(),
            _ => String::new(),
        },
        phone: patient.phone,
        address: patient.address,
        medical_notes: patient.medical_notes,
        treatments: response
            .treatments
            .into_iter()
            .map(|entry| {
                let treatment = entry.treatment.unwrap_or_default();
                HistoryEntry {
                    performed_at: millis(&treatment.performed_at),
                    tooth: treatment.tooth,
                    procedure: treatment.procedure,
                    notes: treatment.notes,
                    clinic_name: entry.clinic_name,
                    clinic_city: entry.clinic_city,
                    performed_by_name: entry.performed_by_name,
                }
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::localdb::{self, SYNC_CHANGED};

    fn database(name: &str) -> Connection {
        let dir = std::env::temp_dir().join(format!("dental-patients-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        localdb::create(&dir.join(localdb::DATABASE_FILE), &[3u8; 32]).unwrap()
    }

    fn input(code: &str) -> PatientInput {
        PatientInput {
            identity: code.into(),
            first_name: " Sara ".into(),
            last_name: "Ahmadi".into(),
            birth_date: "1990-02-28".into(),
            gender: "female".into(),
            phone: "0912 123 4567".into(),
            address: String::new(),
            medical_notes: "Penicillin allergy".into(),
        }
    }

    const SARA: &str = "0012345679";
    const OTHER: &str = "1234567891";

    /// The server derives the same id (dental-server/internal/service/sync.go, patientID).
    #[test]
    fn patient_id_is_stable_and_versioned() {
        let id = patient_id(SARA);
        assert_eq!(id, patient_id(SARA));
        assert_ne!(id, patient_id(OTHER));
        assert_eq!(id[6] >> 4, 8, "UUID version 8");
        assert_eq!(id[8] >> 6, 0b10, "RFC 4122 variant");
        let expected = secure::sha256(b"dental/patient/v2\x000012345679");
        assert_eq!(id[..6], expected[..6]);
    }

    /// The same value as dental-server's TestPatientID: both sides must agree.
    #[test]
    fn patient_id_matches_the_server() {
        assert_eq!(hex::encode(patient_id(SARA)), "3cc05a27428a8621a9efab0ad5d2b80a");
    }

    #[test]
    fn save_normalizes_and_marks_for_sync() {
        let db = database("save");
        let mut persian = input("۰۰۱۲۳۴۵۶۷۹");
        persian.phone = "۰۹۱۲-۱۲۳-۴۵۶۷".into();
        let saved = save_patient(&db, None, &persian, 1000).unwrap();
        assert_eq!(saved.identity, SARA);
        assert_eq!(saved.first_name, "Sara");
        assert_eq!(saved.phone, "09121234567");
        assert_eq!(saved.sync_state, SYNC_NEW);
        assert_eq!(saved.id, hex::encode(patient_id(SARA)));

        // The same person added again is the same record, updated.
        let mut again = input(SARA);
        again.first_name = "Sarah".into();
        let updated = save_patient(&db, None, &again, 1000).unwrap();
        assert_eq!(updated.id, saved.id);
        assert_eq!(updated.first_name, "Sarah");
        assert_eq!(updated.updated_at, 1001, "a change in the same millisecond still moves forward");
        assert_eq!(list_patients(&db, "", 1).unwrap().total, 1);

        // Once the server has it, a change waits to be sent.
        db.execute("UPDATE patients SET sync_state = 'synced'", []).unwrap();
        let changed = save_patient(&db, Some(&saved.id), &input(SARA), 2000).unwrap();
        assert_eq!(changed.sync_state, SYNC_CHANGED);
    }

    #[test]
    fn checks_input() {
        let db = database("checks");
        let key = |input: &PatientInput| save_patient(&db, None, input, 1).unwrap_err().key;
        assert_eq!(key(&input("AB12")), "person.errors.invalidIdentityCode");
        let saved = save_patient(&db, None, &input("ab-12345"), 1).unwrap();
        assert_eq!(saved.identity, "AB12345");

        let mut bad = input(SARA);
        bad.first_name = "  ".into();
        assert_eq!(key(&bad), "patients.errors.nameRequired");
        let mut bad = input(SARA);
        bad.birth_date = "1990-02-30".into();
        assert_eq!(key(&bad), "patients.errors.invalidBirthDate");
        let mut bad = input(SARA);
        bad.phone = "12".into();
        assert_eq!(key(&bad), "patients.errors.invalidPhone");
    }

    #[test]
    fn lists_pages_searched_by_name_code_or_phone() {
        let db = database("list");
        // 25 patients, "Patient 01" to "Patient 25"; the last one has a phone of its own.
        for n in 1..=25 {
            let mut patient = input(&format!("CODE{n:04}"));
            patient.first_name = "Patient".into();
            patient.last_name = format!("{n:02}");
            if n == 25 {
                patient.phone = "0935 777 8899".into();
            }
            save_patient(&db, None, &patient, 1).unwrap();
        }
        let names = |page: &PatientPage| page.patients.iter().map(|p| p.last_name.clone()).collect::<Vec<_>>();

        // By name, a page at a time, with the total on every page.
        let first = list_patients(&db, "", 0).unwrap();
        assert_eq!((first.total, first.patients.len()), (25, 20));
        assert_eq!(first.patients[0].last_name, "01");
        let second = list_patients(&db, "", 2).unwrap();
        assert_eq!(second.total, 25);
        assert_eq!(names(&second), ["21", "22", "23", "24", "25"]);
        assert!(list_patients(&db, "", 3).unwrap().patients.is_empty());

        let count = |query: &str| list_patients(&db, query, 1).unwrap().total;
        assert_eq!(count("  patient 07 "), 1, "full name, any case");
        assert_eq!(count("code0012"), 1, "identification code");
        assert_eq!(count("CODE-001"), 10, "code as typed, with a dash");
        assert_eq!(count("۰۹۳۵ ۷۷۷"), 1, "phone in Persian digits, with spaces");
        assert_eq!(count("0912"), 24);
        assert_eq!(count("%"), 0);
        assert_eq!(count(" - "), 0, "only spaces and dashes match no code or phone");
    }

    #[test]
    fn identity_changes_only_before_the_server_has_it() {
        let db = database("identity");
        let saved = save_patient(&db, None, &input(SARA), 1).unwrap();
        let treatment = TreatmentInput {
            patient_id: saved.id.clone(),
            performed_by: None,
            performed_at: 5,
            tooth: "36".into(),
            procedure: "Filling".into(),
            notes: String::new(),
        };
        save_treatment(&db, None, &treatment, 2).unwrap();

        // A typo fixed before syncing: new id, treatments follow.
        let fixed = save_patient(&db, Some(&saved.id), &input(OTHER), 3).unwrap();
        assert_eq!(fixed.id, hex::encode(patient_id(OTHER)));
        assert!(get_patient(&db, &parse_id(&saved.id, "x").unwrap()).unwrap().is_none());
        assert_eq!(list_treatments(&db, &fixed.id).unwrap().len(), 1);

        db.execute("UPDATE patients SET sync_state = 'synced'", []).unwrap();
        let error = save_patient(&db, Some(&fixed.id), &input(SARA), 4).unwrap_err();
        assert_eq!(error.key, "patients.errors.identityLocked");
    }

    #[test]
    fn treatments_are_deleted_as_tombstones() {
        let db = database("treatments");
        let patient = save_patient(&db, None, &input(SARA), 1).unwrap();
        let mut treatment = TreatmentInput {
            patient_id: patient.id.clone(),
            performed_by: Some(hex::encode([7u8; 16])),
            performed_at: 10,
            tooth: "36".into(),
            procedure: " ".into(),
            notes: String::new(),
        };
        assert_eq!(save_treatment(&db, None, &treatment, 2).unwrap_err().key, "treatments.errors.procedureRequired");
        treatment.procedure = "Root canal".into();
        let saved = save_treatment(&db, None, &treatment, 2).unwrap();
        assert_eq!(saved.performed_by, Some(hex::encode([7u8; 16])));

        db.execute("UPDATE treatments SET sync_state = 'synced'", []).unwrap();
        delete_treatment(&db, &saved.id, 3).unwrap();
        assert!(list_treatments(&db, &patient.id).unwrap().is_empty());
        let (state, deleted): (String, Option<i64>) = db
            .query_row("SELECT sync_state, deleted_at FROM treatments", [], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap();
        assert_eq!((state.as_str(), deleted), (SYNC_CHANGED, Some(3)));
        assert_eq!(delete_treatment(&db, &saved.id, 4).unwrap_err().key, "treatments.errors.notFound");
    }
}
