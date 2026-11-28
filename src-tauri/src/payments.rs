//! Money received from patients, and refunds paid back to them: how much, when
//! (date and time), how (cash, card reader, transfer...) and an optional
//! tracking code. A patient's balance is what they paid less what was refunded.
//!
//! Financial data: kept in the local database only (localdb::LOCAL_ONLY_TABLES),
//! never sent to the server. Anyone can record a payment and see them all; only
//! whoever recorded one, or a manager, can change or delete it.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::auth::SessionInfo;
use crate::localdb::ROLE_MANAGER;
use crate::message::Message;
use crate::person::latin_digits;
use crate::secure;

const MAX_NOTES_CHARS: usize = 1000;
const MAX_REFERENCE_CHARS: usize = 64;
/// Far above any real payment: anything larger is surely a typo.
const MAX_AMOUNT: f64 = 1e15;

/// A payment received from the patient, or money paid back to them.
pub const KIND_PAYMENT: &str = "payment";
pub const KIND_REFUND: &str = "refund";

/// How a payment was made (PAYMENT_METHODS in src/lib/payments.ts, `payments.methods.*` in the locale files).
pub const METHODS: &[&str] =
    &["cash", "pos", "cardToCard", "accountTransfer", "bankTransfer", "online", "cheque", "other"];

fn err(key: &str) -> Message {
    Message::new(key)
}

fn internal(details: impl std::fmt::Display) -> Message {
    Message::error("errors.unknown", details)
}

fn parse_id(hex_id: &str, not_found: &str) -> Result<[u8; 16], Message> {
    hex::decode(hex_id.trim()).ok().and_then(|b| b.try_into().ok()).ok_or_else(|| err(not_found))
}

/// A payment as typed in the form (src/lib/payments.ts).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentInput {
    /// The patient (hex).
    pub patient_id: String,
    /// KIND_PAYMENT or KIND_REFUND.
    pub kind: String,
    /// Stored amount (src/i18n/currency.ts), Rial for Toman and Rial. Always
    /// positive: `kind` says which way the money went.
    pub amount: f64,
    /// One of METHODS.
    pub method: String,
    /// When it was received or refunded, unix milliseconds.
    pub paid_at: i64,
    /// Tracking code, cheque number...; empty for none.
    #[serde(default)]
    pub reference: String,
    #[serde(default)]
    pub notes: String,
}

/// A payment as stored, sent to the frontend.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentRecord {
    pub id: String,
    pub patient_id: String,
    pub kind: String,
    pub amount: f64,
    pub method: String,
    pub paid_at: i64,
    pub reference: String,
    pub notes: String,
    /// Local user id (hex) of who recorded it.
    pub recorded_by: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A patient's payments and refunds, with their totals.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentList {
    /// Payments and refunds together, newest first.
    pub payments: Vec<PaymentRecord>,
    /// Everything received.
    pub received: f64,
    /// Everything paid back.
    pub refunded: f64,
    /// received - refunded.
    pub balance: f64,
}

const COLUMNS: &str = "id, patient_id, kind, amount, method, paid_at, reference, notes, recorded_by, created_at, updated_at";

fn from_row(row: &Row) -> rusqlite::Result<PaymentRecord> {
    Ok(PaymentRecord {
        id: hex::encode(row.get::<_, Vec<u8>>(0)?),
        patient_id: hex::encode(row.get::<_, Vec<u8>>(1)?),
        kind: row.get(2)?,
        amount: row.get(3)?,
        method: row.get(4)?,
        paid_at: row.get(5)?,
        reference: row.get(6)?,
        notes: row.get(7)?,
        recorded_by: hex::encode(row.get::<_, Vec<u8>>(8)?),
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn get(db: &Connection, id: &[u8]) -> Result<Option<PaymentRecord>, Message> {
    db.query_row(&format!("SELECT {COLUMNS} FROM patient_payments WHERE id = ?1"), [id], from_row)
        .optional()
        .map_err(internal)
}

/// Empty, or a code of Latin letters, digits, "-", "/" and "." (Persian digits
/// become Latin, spaces are dropped): what banks and cheques print.
fn check_reference(reference: &str) -> Result<String, Message> {
    let reference: String = latin_digits(reference).chars().filter(|c| !c.is_whitespace()).collect();
    let valid = reference.chars().count() <= MAX_REFERENCE_CHARS
        && reference.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | '.'));
    if valid {
        Ok(reference)
    } else {
        Err(err("payments.errors.invalidReference"))
    }
}

/// Checks that the logged-in user may change `payment`: whoever recorded it, or a manager.
fn check_change(session: &SessionInfo, payment: &PaymentRecord) -> Result<(), Message> {
    if payment.recorded_by != session.user_id && session.role != ROLE_MANAGER {
        return Err(err("payments.errors.notAllowed"));
    }
    Ok(())
}

/// Records a payment or refund (no `id`), or changes one.
pub fn save(
    db: &Connection,
    session: &SessionInfo,
    id: Option<&str>,
    input: &PaymentInput,
    now: i64,
) -> Result<PaymentRecord, Message> {
    let patient = parse_id(&input.patient_id, "patients.errors.notFound")?;
    let known: bool = db
        .query_row("SELECT EXISTS (SELECT 1 FROM patients WHERE id = ?1)", [patient], |row| row.get(0))
        .map_err(internal)?;
    if !known {
        return Err(err("patients.errors.notFound"));
    }
    let kind = input.kind.trim();
    if kind != KIND_PAYMENT && kind != KIND_REFUND {
        return Err(err("payments.errors.invalidKind"));
    }
    if !(input.amount.is_finite() && input.amount > 0.0 && input.amount <= MAX_AMOUNT) {
        return Err(err("payments.errors.invalidAmount"));
    }
    let method = input.method.trim();
    if !METHODS.contains(&method) {
        return Err(err("payments.errors.invalidMethod"));
    }
    if input.paid_at <= 0 {
        return Err(err("payments.errors.invalidDate"));
    }
    let reference = check_reference(&input.reference)?;
    let notes = input.notes.trim();
    if notes.chars().count() > MAX_NOTES_CHARS {
        return Err(err("patients.errors.tooLong").with("max", MAX_NOTES_CHARS));
    }

    let tx = db.unchecked_transaction().map_err(internal)?;
    let target = match id {
        None => {
            let target = *secure::random_bytes::<16>();
            let recorded_by = parse_id(&session.user_id, "errors.unknown")?;
            tx.execute(
                "INSERT INTO patient_payments (id, patient_id, kind, amount, method, paid_at, reference, notes,
                    recorded_by, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
                params![target, patient, kind, input.amount, method, input.paid_at, reference, notes, recorded_by, now],
            )
            .map_err(internal)?;
            target
        }
        Some(hex_id) => {
            let target = parse_id(hex_id, "payments.errors.notFound")?;
            let existing = get(&tx, &target)?.ok_or_else(|| err("payments.errors.notFound"))?;
            check_change(session, &existing)?;
            // A payment stays with its patient and with whoever recorded it.
            if existing.patient_id != hex::encode(patient) {
                return Err(err("payments.errors.notFound"));
            }
            tx.execute(
                "UPDATE patient_payments SET kind = ?2, amount = ?3, method = ?4, paid_at = ?5, reference = ?6,
                    notes = ?7, updated_at = ?8
                 WHERE id = ?1",
                params![target, kind, input.amount, method, input.paid_at, reference, notes, now],
            )
            .map_err(internal)?;
            target
        }
    };
    let saved = get(&tx, &target)?.ok_or_else(|| internal("saved payment not found"))?;
    tx.commit().map_err(internal)?;
    Ok(saved)
}

/// A patient's payments and refunds, newest first, with their totals.
pub fn list(db: &Connection, patient_id: &str) -> Result<PaymentList, Message> {
    let patient = parse_id(patient_id, "patients.errors.notFound")?;
    let payments: Vec<PaymentRecord> = db
        .prepare(&format!(
            "SELECT {COLUMNS} FROM patient_payments WHERE patient_id = ?1 ORDER BY paid_at DESC, created_at DESC"
        ))
        .and_then(|mut statement| statement.query_map([patient], from_row)?.collect())
        .map_err(internal)?;
    let sum = |kind: &str| payments.iter().filter(|p| p.kind == kind).map(|p| p.amount).sum::<f64>();
    let (received, refunded) = (sum(KIND_PAYMENT), sum(KIND_REFUND));
    Ok(PaymentList { payments, received, refunded, balance: received - refunded })
}

/// Deletes a payment for good (nothing to sync).
pub fn delete(db: &Connection, session: &SessionInfo, id: &str) -> Result<(), Message> {
    let target = parse_id(id, "payments.errors.notFound")?;
    let existing = get(db, &target)?.ok_or_else(|| err("payments.errors.notFound"))?;
    check_change(session, &existing)?;
    db.execute("DELETE FROM patient_payments WHERE id = ?1", [target]).map_err(internal)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::localdb::{self, ROLE_STAFF};
    use crate::patients::{self, PatientInput};

    fn database(name: &str) -> Connection {
        let dir = std::env::temp_dir().join(format!("dental-payments-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        localdb::create(&dir.join(localdb::DATABASE_FILE), &[4u8; 32]).unwrap()
    }

    fn session(user: u8, role: &str) -> SessionInfo {
        SessionInfo {
            user_id: hex::encode([user; 16]),
            username: format!("user{user}"),
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

    fn patient(db: &Connection, code: &str) -> String {
        let input = PatientInput {
            identity: code.into(),
            first_name: "Sara".into(),
            last_name: "Ahmadi".into(),
            birth_date: String::new(),
            gender: String::new(),
            phone: String::new(),
            email: String::new(),
            address: String::new(),
            medical_notes: String::new(),
        };
        patients::save_patient(db, None, &input, 1).unwrap().id
    }

    fn input(patient_id: &str) -> PaymentInput {
        PaymentInput {
            patient_id: patient_id.into(),
            kind: KIND_PAYMENT.into(),
            amount: 1_250_000.0,
            method: "pos".into(),
            paid_at: 100,
            reference: " ۱۲۳ ۴۵۶ ".into(),
            notes: " First visit ".into(),
        }
    }

    #[test]
    fn records_lists_and_totals() {
        let db = database("save");
        let staff = session(1, ROLE_STAFF);
        let patient_id = patient(&db, "0012345679");

        let first = save(&db, &staff, None, &input(&patient_id), 1000).unwrap();
        assert_eq!(first.reference, "123456", "Latin digits, no spaces");
        assert_eq!(first.notes, "First visit");
        assert_eq!(first.recorded_by, staff.user_id);

        let mut cash = input(&patient_id);
        cash.method = "cash".into();
        cash.amount = 500_000.0;
        cash.paid_at = 200;
        cash.reference = String::new();
        let second = save(&db, &staff, None, &cash, 1001).unwrap();

        let listed = list(&db, &patient_id).unwrap();
        assert_eq!(listed.payments.iter().map(|p| p.id.clone()).collect::<Vec<_>>(), [second.id.clone(), first.id.clone()]);
        assert_eq!((listed.received, listed.refunded, listed.balance), (1_750_000.0, 0.0, 1_750_000.0));

        // A refund is subtracted from the balance.
        let mut refund = input(&patient_id);
        refund.kind = KIND_REFUND.into();
        refund.method = "cardToCard".into();
        refund.amount = 250_000.0;
        refund.paid_at = 300;
        let refunded = save(&db, &staff, None, &refund, 1002).unwrap();
        let listed = list(&db, &patient_id).unwrap();
        assert_eq!(listed.payments[0].id, refunded.id, "newest first");
        assert_eq!((listed.received, listed.refunded, listed.balance), (1_750_000.0, 250_000.0, 1_500_000.0));

        cash.amount = 600_000.0;
        let changed = save(&db, &staff, Some(&second.id), &cash, 2000).unwrap();
        assert_eq!((changed.amount, changed.created_at, changed.updated_at), (600_000.0, 1001, 2000));
    }

    #[test]
    fn checks_input() {
        let db = database("checks");
        let staff = session(1, ROLE_STAFF);
        let patient_id = patient(&db, "0012345679");
        let key = |input: &PaymentInput| save(&db, &staff, None, input, 1).unwrap_err().key;

        for amount in [0.0, -5.0, f64::NAN, f64::INFINITY, 2e15] {
            let mut bad = input(&patient_id);
            bad.amount = amount;
            assert_eq!(key(&bad), "payments.errors.invalidAmount", "{amount}");
        }
        let mut bad = input(&patient_id);
        bad.kind = "loan".into();
        assert_eq!(key(&bad), "payments.errors.invalidKind");
        let mut bad = input(&patient_id);
        bad.method = "barter".into();
        assert_eq!(key(&bad), "payments.errors.invalidMethod");
        let mut bad = input(&patient_id);
        bad.paid_at = 0;
        assert_eq!(key(&bad), "payments.errors.invalidDate");
        for reference in ["کد۱۲", "12#34", &"1".repeat(65)] {
            let mut bad = input(&patient_id);
            bad.reference = reference.into();
            assert_eq!(key(&bad), "payments.errors.invalidReference", "{reference}");
        }
        let mut good = input(&patient_id);
        good.reference = "AB-12/34.5".into();
        assert_eq!(save(&db, &staff, None, &good, 1).unwrap().reference, "AB-12/34.5");
        assert_eq!(key(&input(&hex::encode([9u8; 16]))), "patients.errors.notFound");
    }

    #[test]
    fn only_the_recorder_or_a_manager_changes_a_payment() {
        let db = database("access");
        let (recorder, other, manager) = (session(1, ROLE_STAFF), session(2, ROLE_STAFF), session(3, ROLE_MANAGER));
        let patient_id = patient(&db, "0012345679");
        let saved = save(&db, &recorder, None, &input(&patient_id), 1).unwrap();

        assert_eq!(save(&db, &other, Some(&saved.id), &input(&patient_id), 2).unwrap_err().key, "payments.errors.notAllowed");
        assert_eq!(delete(&db, &other, &saved.id).unwrap_err().key, "payments.errors.notAllowed");
        // The manager's change keeps who recorded it.
        assert_eq!(save(&db, &manager, Some(&saved.id), &input(&patient_id), 3).unwrap().recorded_by, recorder.user_id);
        // A payment does not move to another patient.
        let other_patient = patient(&db, "1234567891");
        assert_eq!(save(&db, &recorder, Some(&saved.id), &input(&other_patient), 4).unwrap_err().key, "payments.errors.notFound");

        delete(&db, &recorder, &saved.id).unwrap();
        assert!(list(&db, &patient_id).unwrap().payments.is_empty());
        assert_eq!(delete(&db, &manager, &saved.id).unwrap_err().key, "payments.errors.notFound");
    }

    /// A corrected identification code gives the patient a new id; their payments follow.
    #[test]
    fn payments_follow_a_corrected_identity() {
        let db = database("identity");
        let staff = session(1, ROLE_STAFF);
        let old_id = patient(&db, "0012345679");
        save(&db, &staff, None, &input(&old_id), 1).unwrap();

        let corrected = PatientInput {
            identity: "1234567891".into(),
            first_name: "Sara".into(),
            last_name: "Ahmadi".into(),
            birth_date: String::new(),
            gender: String::new(),
            phone: String::new(),
            email: String::new(),
            address: String::new(),
            medical_notes: String::new(),
        };
        let new_id = patients::save_patient(&db, Some(&old_id), &corrected, 2).unwrap().id;
        assert_ne!(new_id, old_id);
        assert_eq!(list(&db, &new_id).unwrap().payments.len(), 1);
        assert!(list(&db, &old_id).unwrap().payments.is_empty());
    }
}
