//! Two-way sync of the clinic's records with the server (SyncService in
//! dental-server/proto/dental/v1/sync.proto).
//!
//! The local database is always the one the app works on, online or offline.
//! Every synced record carries a `sync_state` (localdb.rs): a change marks it
//! "new" or "changed", and here, whenever there is an online session:
//! 1. Push: changed records go to the server in batches; each one the server took
//!    becomes "synced" (unless it changed again meanwhile), each one it refused
//!    becomes "rejected" and waits for a fix.
//! 2. Pull: what changed on the server since the last pull (other installations of
//!    the clinic, other clinics treating the same patients) is applied, the latest
//!    change winning record by record; a newer local change not sent yet is kept.
//!
//! Only the tables in localdb::SYNCED_TABLES are ever read here, field by field:
//! financial data lives in local-only tables and never reaches the server.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use zeroize::Zeroizing;

use crate::api::{Api, ApiError};
use crate::auth::{self, Session};
use crate::localdb::{SYNC_CHANGED, SYNC_NEW, SYNC_REJECTED, SYNC_SYNCED};
use crate::message::Message;
use crate::{clock, proto};

/// The event the frontend listens to; its payload is a `SyncStatus`.
pub const EVENT: &str = "sync";
/// Records per push (the server takes up to 500).
const BATCH: usize = 200;
/// Pushes or pulls per run at most, so a run always ends; the next one goes on.
const MAX_ROUNDS: usize = 100;
/// The one pull scope so far: everything of the session's clinic.
const CLINIC_SCOPE: &str = "clinic";

// ---------------------------------------------------------------------------
// Conversions

fn timestamp(millis: i64) -> prost_types::Timestamp {
    prost_types::Timestamp { seconds: millis.div_euclid(1000), nanos: (millis.rem_euclid(1000) * 1_000_000) as i32 }
}

fn millis(timestamp: &Option<prost_types::Timestamp>) -> Option<i64> {
    timestamp.as_ref().map(|t| t.seconds * 1000 + i64::from(t.nanos) / 1_000_000)
}

fn gender_to_proto(gender: &str) -> proto::Gender {
    match gender {
        "male" => proto::Gender::Male,
        "female" => proto::Gender::Female,
        _ => proto::Gender::Unspecified,
    }
}

fn gender_from_proto(value: i32) -> &'static str {
    match proto::Gender::try_from(value) {
        Ok(proto::Gender::Male) => "male",
        Ok(proto::Gender::Female) => "female",
        _ => "",
    }
}

// ---------------------------------------------------------------------------
// Push

/// A row that was sent, to recognize it when the answer comes.
struct Sent {
    table: &'static str,
    id: Vec<u8>,
    updated_at: i64,
}

/// One push: the request and what it contains.
pub struct Outbox {
    request: proto::PushRequest,
    sent: Vec<Sent>,
}

impl Outbox {
    pub fn is_empty(&self) -> bool {
        self.sent.is_empty()
    }
}

const WAITING: &str = "sync_state IN ('new', 'changed')";

fn patient_to_proto(row: &Row) -> rusqlite::Result<(proto::Patient, i64)> {
    let updated_at: i64 = row.get(9)?;
    let patient = proto::Patient {
        id: row.get(0)?,
        identity: Some(proto::PersonIdentity { number: row.get(1)? }),
        first_name: row.get(2)?,
        last_name: row.get(3)?,
        birth_date: row.get(4)?,
        gender: gender_to_proto(&row.get::<_, String>(5)?) as i32,
        phone: row.get(6)?,
        address: row.get(7)?,
        medical_notes: row.get(8)?,
        updated_at: Some(timestamp(updated_at)),
    };
    Ok((patient, updated_at))
}

fn treatment_to_proto(row: &Row) -> rusqlite::Result<(proto::Treatment, i64)> {
    let updated_at: i64 = row.get(7)?;
    let treatment = proto::Treatment {
        id: row.get(0)?,
        patient_id: row.get(1)?,
        performed_by: row.get::<_, Option<Vec<u8>>>(2)?.unwrap_or_default(),
        performed_at: Some(timestamp(row.get(3)?)),
        tooth: row.get(4)?,
        procedure: row.get(5)?,
        notes: row.get(6)?,
        updated_at: Some(timestamp(updated_at)),
        deleted_at: row.get::<_, Option<i64>>(8)?.map(timestamp),
    };
    Ok((treatment, updated_at))
}

/// The next records waiting to be sent, patients first: a treatment's patient must
/// be on the server before it, so treatments wait until every patient has gone.
pub fn outbox(db: &Connection) -> rusqlite::Result<Outbox> {
    let mut request = proto::PushRequest::default();
    let mut sent = Vec::new();

    let mut statement = db.prepare(&format!(
        "SELECT id, identity, first_name, last_name, birth_date, gender, phone, address, medical_notes, updated_at
         FROM patients WHERE {WAITING} ORDER BY updated_at LIMIT ?1"
    ))?;
    for row in statement.query_map([BATCH as i64], patient_to_proto)? {
        let (patient, updated_at) = row?;
        sent.push(Sent { table: "patients", id: patient.id.clone(), updated_at });
        request.patients.push(patient);
    }

    if sent.len() < BATCH {
        let mut statement = db.prepare(&format!(
            "SELECT id, patient_id, performed_by, performed_at, tooth, procedure, notes, updated_at, deleted_at
             FROM treatments WHERE {WAITING} ORDER BY updated_at LIMIT ?1"
        ))?;
        for row in statement.query_map([(BATCH - sent.len()) as i64], treatment_to_proto)? {
            let (treatment, updated_at) = row?;
            sent.push(Sent { table: "treatments", id: treatment.id.clone(), updated_at });
            request.treatments.push(treatment);
        }
    }
    Ok(Outbox { request, sent })
}

/// Records the server's answer to `outbox`. A record changed again since it was
/// sent keeps waiting: its newer change goes in the next push.
pub fn after_push(db: &Connection, outbox: &Outbox, response: &proto::PushResponse) -> rusqlite::Result<()> {
    let rejected: HashSet<&[u8]> = response.rejected.iter().map(|r| r.id.as_slice()).collect();
    for record in &response.rejected {
        eprintln!("Sync: the server refused record {}: {}", hex::encode(&record.id), record.reason);
    }

    let tx = db.unchecked_transaction()?;
    for sent in &outbox.sent {
        let state = if rejected.contains(sent.id.as_slice()) { SYNC_REJECTED } else { SYNC_SYNCED };
        tx.execute(
            &format!("UPDATE {} SET sync_state = ?3 WHERE id = ?1 AND updated_at = ?2", sent.table),
            params![sent.id, sent.updated_at, state],
        )?;
        if state == SYNC_SYNCED {
            // Changed again meanwhile: still waiting, but the server has it now.
            tx.execute(
                &format!("UPDATE {} SET sync_state = '{SYNC_CHANGED}' WHERE id = ?1 AND sync_state = '{SYNC_NEW}'", sent.table),
                [&sent.id],
            )?;
        }
        // Treatments refused because their patient was not on the server yet go
        // again now that it is.
        if sent.table == "patients" && state == SYNC_SYNCED {
            tx.execute(
                "UPDATE treatments SET sync_state = 'changed' WHERE patient_id = ?1 AND sync_state = 'rejected'",
                [&sent.id],
            )?;
        }
    }
    tx.commit()
}

// ---------------------------------------------------------------------------
// Pull

/// Where the last pull stopped (0: never pulled).
pub fn cursor(db: &Connection) -> rusqlite::Result<i64> {
    db.query_row("SELECT revision FROM sync_cursors WHERE scope = ?1", [CLINIC_SCOPE], |row| row.get(0))
        .optional()
        .map(Option::unwrap_or_default)
}

/// Applies a PullResponse: each record replaces the local one unless the local one
/// has a newer change that was not sent yet.
pub fn apply_pull(db: &Connection, response: &proto::PullResponse, now: i64) -> rusqlite::Result<()> {
    let tx = db.unchecked_transaction()?;
    for patient in &response.patients {
        let Some(identity) = patient.identity.as_ref() else { continue };
        tx.execute(
            &format!(
                "INSERT INTO patients (id, identity, first_name, last_name, birth_date, gender, phone, address,
                    medical_notes, updated_at, created_at, sync_state)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'synced')
                 ON CONFLICT (id) DO UPDATE SET
                    first_name = excluded.first_name,
                    last_name = excluded.last_name, birth_date = excluded.birth_date, gender = excluded.gender,
                    phone = excluded.phone, address = excluded.address, medical_notes = excluded.medical_notes,
                    updated_at = excluded.updated_at, sync_state = 'synced'
                 WHERE NOT (patients.{WAITING} AND patients.updated_at > excluded.updated_at)"
            ),
            params![
                patient.id,
                identity.number,
                patient.first_name,
                patient.last_name,
                patient.birth_date,
                gender_from_proto(patient.gender),
                patient.phone,
                patient.address,
                patient.medical_notes,
                millis(&patient.updated_at).unwrap_or(0),
                now,
            ],
        )?;
    }
    for treatment in &response.treatments {
        let performed_by = (!treatment.performed_by.is_empty()).then_some(&treatment.performed_by);
        tx.execute(
            &format!(
                "INSERT INTO treatments (id, patient_id, performed_by, performed_at, tooth, procedure, notes,
                    updated_at, deleted_at, created_at, sync_state)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'synced')
                 ON CONFLICT (id) DO UPDATE SET
                    patient_id = excluded.patient_id, performed_by = excluded.performed_by,
                    performed_at = excluded.performed_at, tooth = excluded.tooth, procedure = excluded.procedure,
                    notes = excluded.notes, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
                    sync_state = 'synced'
                 WHERE NOT (treatments.{WAITING} AND treatments.updated_at > excluded.updated_at)"
            ),
            params![
                treatment.id,
                treatment.patient_id,
                performed_by,
                millis(&treatment.performed_at).unwrap_or(0),
                treatment.tooth,
                treatment.procedure,
                treatment.notes,
                millis(&treatment.updated_at).unwrap_or(0),
                millis(&treatment.deleted_at),
                now,
            ],
        )?;
    }
    tx.execute(
        "INSERT INTO sync_cursors (scope, revision) VALUES (?1, ?2)
         ON CONFLICT (scope) DO UPDATE SET revision = excluded.revision",
        params![CLINIC_SCOPE, response.revision],
    )?;
    tx.commit()
}

/// After a restore the data is not what the server last saw: everything is sent
/// again (the server keeps whichever change is newer) and pulled again from the start.
pub fn resync_all(db: &Connection) -> rusqlite::Result<()> {
    let tx = db.unchecked_transaction()?;
    for table in crate::localdb::SYNCED_TABLES {
        tx.execute(&format!("UPDATE {table} SET sync_state = '{SYNC_CHANGED}' WHERE sync_state = '{SYNC_SYNCED}'"), [])?;
    }
    tx.execute("DELETE FROM sync_cursors", [])?;
    tx.commit()
}

// ---------------------------------------------------------------------------
// Running

/// Counts of records waiting to be sent, and refused by the server.
fn counts(db: &Connection) -> rusqlite::Result<(u32, u32)> {
    let mut waiting = 0;
    let mut rejected = 0;
    for table in crate::localdb::SYNCED_TABLES {
        let (w, r): (u32, u32) = db.query_row(
            &format!(
                "SELECT count(*) FILTER (WHERE sync_state IN ('{SYNC_NEW}', '{SYNC_CHANGED}')),
                        count(*) FILTER (WHERE sync_state = '{SYNC_REJECTED}')
                 FROM {table}"
            ),
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        waiting += w;
        rejected += r;
    }
    Ok((waiting, rejected))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncState {
    /// No online session: changes are kept here until there is one.
    Offline,
    Syncing,
    /// The last run finished.
    Idle,
    /// The last run failed; the next one tries again.
    Error,
}

/// Sent to the frontend (src/lib/sync.ts).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub state: SyncState,
    /// Records changed here and not on the server yet.
    pub pending: u32,
    /// Records the server refused; they wait for a fix.
    pub rejected: u32,
    /// When a run last finished without error (unix seconds; 0 = not in this session).
    pub last_synced_at: i64,
    pub error: Option<Message>,
}

pub enum SyncError {
    /// No session, or an offline one.
    NotOnline,
    Api(ApiError),
    Local(rusqlite::Error),
}

impl SyncError {
    pub fn is_update_required(&self) -> bool {
        matches!(self, SyncError::Api(ApiError::Server { reason, .. }) if reason == crate::api::UPDATE_REQUIRED)
    }

    fn message(&self) -> Option<Message> {
        match self {
            SyncError::NotOnline => None,
            SyncError::Api(ApiError::Network(e)) => Some(Message::error("errors.network", e)),
            SyncError::Api(ApiError::Server { code, reason }) => Some(auth::server_error(code, reason)),
            SyncError::Local(e) => Some(Message::error("errors.unknown", e)),
        }
    }
}

impl From<rusqlite::Error> for SyncError {
    fn from(e: rusqlite::Error) -> Self {
        SyncError::Local(e)
    }
}

/// One run: push everything waiting, then pull everything new. Locks the session
/// only for local work, never during a request. If the data was replaced while a
/// request ran (logout, another login, a restore or clearing), its answer is
/// dropped and the run ends: the next one starts from the new data.
async fn run(api: &Api, session: &Mutex<Option<Session>>) -> Result<(), SyncError> {
    // The token and the data the request is about, read together.
    let start = |read: &dyn Fn(&Connection) -> rusqlite::Result<()>| -> Result<(Zeroizing<String>, u64), SyncError> {
        let guard = session.lock().unwrap();
        let session = guard.as_ref().ok_or(SyncError::NotOnline)?;
        let token = Zeroizing::new(session.token().ok_or(SyncError::NotOnline)?.to_owned());
        read(&session.db)?;
        Ok((token, session.data_epoch()))
    };
    // Runs `apply` on the session's database if it is still the data the request was about.
    let finish = |epoch: u64, apply: &dyn Fn(&Connection) -> rusqlite::Result<()>| -> Result<bool, SyncError> {
        let guard = session.lock().unwrap();
        match guard.as_ref() {
            Some(session) if session.data_epoch() == epoch => Ok(apply(&session.db).map(|()| true)?),
            _ => Ok(false),
        }
    };

    for _ in 0..MAX_ROUNDS {
        let pending = Mutex::new(None);
        let (token, epoch) = start(&|db| {
            *pending.lock().unwrap() = Some(outbox(db)?);
            Ok(())
        })?;
        let pending = pending.into_inner().unwrap().expect("set by start");
        if pending.is_empty() {
            break;
        }
        let response = api.push(&token, &pending.request).await.map_err(SyncError::Api)?;
        if !finish(epoch, &|db| after_push(db, &pending, &response))? {
            return Ok(());
        }
    }

    for _ in 0..MAX_ROUNDS {
        let since = Mutex::new(0);
        let (token, epoch) = start(&|db| {
            *since.lock().unwrap() = cursor(db)?;
            Ok(())
        })?;
        let response = api.pull(&token, since.into_inner().unwrap()).await.map_err(SyncError::Api)?;
        if !finish(epoch, &|db| apply_pull(db, &response, clock::now_millis()))? || !response.has_more {
            break;
        }
    }
    Ok(())
}

/// Runs syncs one at a time and keeps their status for the frontend.
pub struct Syncer {
    running: tauri::async_runtime::Mutex<()>,
    /// Asked for while a run was going: run once more when it ends, so a change
    /// made during a run does not wait for the next trigger.
    again: AtomicBool,
    status: Mutex<SyncStatus>,
}

impl Syncer {
    pub fn new() -> Self {
        Self {
            running: tauri::async_runtime::Mutex::new(()),
            again: AtomicBool::new(false),
            status: Mutex::new(SyncStatus { state: SyncState::Offline, pending: 0, rejected: 0, last_synced_at: 0, error: None }),
        }
    }

    /// The status, with fresh counts from the session's database.
    pub fn status(&self, session: &Mutex<Option<Session>>) -> SyncStatus {
        let counted = session.lock().unwrap().as_ref().map(|s| (counts(&s.db), s.token().is_some()));
        let mut status = self.status.lock().unwrap();
        match counted {
            Some((Ok((pending, rejected)), online)) => {
                status.pending = pending;
                status.rejected = rejected;
                if !online && status.state != SyncState::Syncing {
                    status.state = SyncState::Offline;
                }
            }
            Some((Err(e), _)) => eprintln!("Sync status unavailable: {e}"),
            None => {
                *status = SyncStatus { state: SyncState::Offline, pending: 0, rejected: 0, last_synced_at: 0, error: None };
            }
        }
        status.clone()
    }

    /// Syncs now, or after the run in progress. `notify` gets every status change.
    /// Returns the last run's error, if any.
    pub async fn sync(
        &self,
        api: &Api,
        session: &Mutex<Option<Session>>,
        notify: impl Fn(SyncStatus),
    ) -> Result<(), SyncError> {
        self.again.store(true, Ordering::SeqCst);
        let Ok(_running) = self.running.try_lock() else {
            return Ok(());
        };
        let mut result = Ok(());
        while self.again.swap(false, Ordering::SeqCst) {
            self.status.lock().unwrap().state = SyncState::Syncing;
            notify(self.status(session));

            result = run(api, session).await;
            {
                let mut status = self.status.lock().unwrap();
                status.error = result.as_ref().err().and_then(SyncError::message);
                status.state = match &result {
                    Ok(()) => {
                        status.last_synced_at = clock::now_unix();
                        SyncState::Idle
                    }
                    Err(SyncError::NotOnline) => SyncState::Offline,
                    Err(_) => SyncState::Error,
                };
            }
            if let Err(SyncError::Api(e)) = &result {
                eprintln!("Sync failed: {e}");
            }
            notify(self.status(session));
            if result.is_err() {
                break;
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::localdb;
    use crate::patients::{self, PatientInput, TreatmentInput};

    fn database(name: &str) -> Connection {
        let dir = std::env::temp_dir().join(format!("dental-sync-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        localdb::create(&dir.join(localdb::DATABASE_FILE), &[4u8; 32]).unwrap()
    }

    fn patient(first_name: &str) -> PatientInput {
        PatientInput {
            identity: "0012345679".into(),
            first_name: first_name.into(),
            last_name: "Ahmadi".into(),
            birth_date: String::new(),
            gender: "female".into(),
            phone: String::new(),
            address: String::new(),
            medical_notes: String::new(),
        }
    }

    fn state(db: &Connection, table: &str) -> String {
        db.query_row(&format!("SELECT sync_state FROM {table}"), [], |row| row.get(0)).unwrap()
    }

    fn accepted(outbox: &Outbox) -> proto::PushResponse {
        proto::PushResponse { accepted: outbox.sent.len() as u32, rejected: vec![] }
    }

    #[test]
    fn push_marks_sent_records_and_keeps_newer_changes() {
        let db = database("push");
        let saved = patients::save_patient(&db, None, &patient("Sara"), 1000).unwrap();
        let treatment = TreatmentInput {
            patient_id: saved.id.clone(),
            performed_by: None,
            performed_at: 900,
            tooth: "36".into(),
            procedure: "Filling".into(),
            notes: String::new(),
        };
        patients::save_treatment(&db, None, &treatment, 1000).unwrap();
        assert_eq!(counts(&db).unwrap(), (2, 0));

        let first = outbox(&db).unwrap();
        assert_eq!((first.request.patients.len(), first.request.treatments.len()), (1, 1));
        let sent = &first.request.patients[0];
        assert_eq!(sent.identity.as_ref().unwrap().number, "0012345679");
        assert_eq!(millis(&sent.updated_at), Some(1000));

        // Changed while the push was on its way: stays waiting.
        patients::save_patient(&db, Some(&saved.id), &patient("Sarah"), 1500).unwrap();
        after_push(&db, &first, &accepted(&first)).unwrap();
        assert_eq!(state(&db, "patients"), SYNC_CHANGED);
        assert_eq!(state(&db, "treatments"), SYNC_SYNCED);

        let second = outbox(&db).unwrap();
        assert_eq!(second.request.patients[0].first_name, "Sarah");
        after_push(&db, &second, &accepted(&second)).unwrap();
        assert_eq!(counts(&db).unwrap(), (0, 0));
        assert!(outbox(&db).unwrap().is_empty());
    }

    #[test]
    fn rejected_records_wait_for_a_fix() {
        let db = database("rejected");
        let saved = patients::save_patient(&db, None, &patient("Sara"), 1000).unwrap();
        let treatment = TreatmentInput {
            patient_id: saved.id.clone(),
            performed_by: None,
            performed_at: 900,
            tooth: String::new(),
            procedure: "Cleaning".into(),
            notes: String::new(),
        };
        patients::save_treatment(&db, None, &treatment, 1000).unwrap();

        let sent = outbox(&db).unwrap();
        let ids = [sent.request.patients[0].id.clone(), sent.request.treatments[0].id.clone()];
        let response = proto::PushResponse {
            accepted: 0,
            rejected: ids.iter().map(|id| proto::RejectedRecord { id: id.clone(), reason: "test".into() }).collect(),
        };
        after_push(&db, &sent, &response).unwrap();
        assert_eq!(counts(&db).unwrap(), (0, 2));
        assert!(outbox(&db).unwrap().is_empty(), "refused records are not sent again as they are");

        // Fixing the patient sends it again, and its refused treatment with it once it is taken.
        patients::save_patient(&db, Some(&saved.id), &patient("Sara"), 2000).unwrap();
        assert_eq!(state(&db, "patients"), SYNC_NEW, "never stored by the server");
        let retry = outbox(&db).unwrap();
        assert_eq!((retry.request.patients.len(), retry.request.treatments.len()), (1, 0));
        after_push(&db, &retry, &accepted(&retry)).unwrap();
        assert_eq!(state(&db, "treatments"), SYNC_CHANGED);
    }

    fn pulled_patient(first_name: &str, updated_at: i64) -> proto::Patient {
        let id = patients::patient_id("0012345679");
        proto::Patient {
            id: id.to_vec(),
            identity: Some(proto::PersonIdentity { number: "0012345679".into() }),
            first_name: first_name.into(),
            last_name: "Ahmadi".into(),
            birth_date: String::new(),
            gender: proto::Gender::Female as i32,
            phone: String::new(),
            address: String::new(),
            medical_notes: String::new(),
            updated_at: Some(timestamp(updated_at)),
        }
    }

    #[test]
    fn pull_applies_the_latest_change() {
        let db = database("pull");
        let response = |patient: proto::Patient, revision: i64| proto::PullResponse {
            patients: vec![patient],
            treatments: vec![],
            revision,
            has_more: false,
        };
        let first_name = |db: &Connection| -> String {
            db.query_row("SELECT first_name FROM patients", [], |row| row.get(0)).unwrap()
        };

        // New from another installation.
        apply_pull(&db, &response(pulled_patient("Sara", 1000), 7), 5).unwrap();
        assert_eq!((first_name(&db), state(&db, "patients")), ("Sara".into(), SYNC_SYNCED.into()));
        assert_eq!(cursor(&db).unwrap(), 7);

        // A local change not sent yet, newer than the server's: kept.
        let id = hex::encode(patients::patient_id("0012345679"));
        patients::save_patient(&db, Some(&id), &patient("Local"), 3000).unwrap();
        apply_pull(&db, &response(pulled_patient("Older", 2000), 8), 5).unwrap();
        assert_eq!((first_name(&db), state(&db, "patients")), ("Local".into(), SYNC_CHANGED.into()));

        // A newer change from the server wins over the unsent local one.
        apply_pull(&db, &response(pulled_patient("Newer", 4000), 9), 5).unwrap();
        assert_eq!((first_name(&db), state(&db, "patients")), ("Newer".into(), SYNC_SYNCED.into()));

        // A treatment deleted elsewhere arrives as a tombstone.
        let treatment = proto::Treatment {
            id: vec![1; 16],
            patient_id: patients::patient_id("0012345679").to_vec(),
            performed_by: vec![],
            performed_at: Some(timestamp(100)),
            tooth: String::new(),
            procedure: "Filling".into(),
            notes: String::new(),
            updated_at: Some(timestamp(5000)),
            deleted_at: Some(timestamp(5000)),
        };
        let with_treatment = proto::PullResponse { patients: vec![], treatments: vec![treatment], revision: 10, has_more: false };
        apply_pull(&db, &with_treatment, 5).unwrap();
        assert!(patients::list_treatments(&db, &id).unwrap().is_empty());

        resync_all(&db).unwrap();
        assert_eq!(cursor(&db).unwrap(), 0);
        assert_eq!(counts(&db).unwrap(), (2, 0), "everything is sent again after a restore");
    }

    #[test]
    fn timestamps_round_trip() {
        for value in [0, 1, 999, 1000, 1_732_442_400_123, -1] {
            assert_eq!(millis(&Some(timestamp(value))), Some(value));
        }
    }
}
