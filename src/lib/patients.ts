import { invoke } from "@tauri-apps/api/core";
import type { PersonIdentityInput } from "@/auth/setup";

/**
 * Patients and treatments (src-tauri/src/patients.rs). Every change is saved in
 * the local database first and synced by Rust when online (src/lib/sync.ts), so
 * these work offline too. No financial data belongs here: fees and payments live
 * in local-only tables and never reach the server.
 *
 * Each call throws a RustMessage (src/i18n/message.ts) on failure.
 */

/** "new": the server never stored it; "changed": waiting to be sent; "rejected": the server refused it. */
export type SyncState = "new" | "changed" | "synced" | "rejected";

export type Gender = "" | "male" | "female";

export interface PatientInput extends PersonIdentityInput {
  firstName: string;
  lastName: string;
  /** Gregorian "YYYY-MM-DD", or "". */
  birthDate: string;
  gender: Gender;
  phone: string;
  address: string;
  medicalNotes: string;
}

export interface Patient {
  /** 32 hex digits, derived from the identification code: the same on every computer. */
  id: string;
  /** The identification code. */
  identity: string;
  firstName: string;
  lastName: string;
  birthDate: string;
  gender: Gender;
  phone: string;
  address: string;
  medicalNotes: string;
  /** Unix milliseconds. */
  createdAt: number;
  updatedAt: number;
  syncState: SyncState;
}

export interface TreatmentInput {
  patientId: string;
  /** User id (hex) of who performed it, if known. */
  performedBy?: string | null;
  /** Unix milliseconds. */
  performedAt: number;
  tooth: string;
  procedure: string;
  notes: string;
}

export interface Treatment {
  id: string;
  patientId: string;
  performedBy: string | null;
  performedAt: number;
  tooth: string;
  procedure: string;
  notes: string;
  createdAt: number;
  updatedAt: number;
  syncState: SyncState;
}

/** A patient's history in every clinic, from the server. */
export interface PatientHistory {
  identity: string;
  firstName: string;
  lastName: string;
  birthDate: string;
  gender: Gender;
  phone: string;
  address: string;
  medicalNotes: string;
  /** Newest first. */
  treatments: {
    performedAt: number;
    tooth: string;
    procedure: string;
    notes: string;
    clinicName: string;
    clinicCity: string;
    performedByName: string;
  }[];
}

/** One page of the patient list. */
export interface PatientPage {
  patients: Patient[];
  /** Matching patients on every page. */
  total: number;
}

/**
 * Page `page` (from 1) of the patients whose name, identification code or phone
 * contains `query` (all if empty), by name; PATIENT_PAGE_SIZE per page.
 */
export function listPatients(query = "", page = 1): Promise<PatientPage> {
  return invoke<PatientPage>("list_patients", { query, page });
}

export function getPatient(id: string): Promise<Patient | null> {
  return invoke<Patient | null>("get_patient", { id });
}

/**
 * Adds a patient, or updates one (`id`). Adding someone whose identity is already
 * here updates them instead: one person is never stored twice. The identity can
 * change only until the server has the patient.
 */
export function savePatient(patient: PatientInput, id?: string): Promise<Patient> {
  return invoke<Patient>("save_patient", { id: id ?? null, patient });
}

export function listTreatments(patientId: string): Promise<Treatment[]> {
  return invoke<Treatment[]>("list_treatments", { patientId });
}

export function saveTreatment(treatment: TreatmentInput, id?: string): Promise<Treatment> {
  return invoke<Treatment>("save_treatment", { id: id ?? null, treatment });
}

export function deleteTreatment(id: string): Promise<void> {
  return invoke("delete_treatment", { id });
}

/** Someone who has logged in on this computer (see LocalUser in src-tauri/src/localdb.rs). */
export interface LocalUser {
  id: string;
  username: string;
  fullName: string;
}

/** Everyone who has logged in on this computer: who can be picked as having performed a treatment. */
export function listLocalUsers(): Promise<LocalUser[]> {
  return invoke<LocalUser[]>("list_local_users");
}

/** Patients per page of the list (LIST_PAGE_SIZE in src-tauri/src/patients.rs). */
export const PATIENT_PAGE_SIZE = 20;

/**
 * A patient's treatments in every clinic. Needs an online session; the server
 * records who looked, from which clinic, and when.
 */
export function patientHistory(identity: PersonIdentityInput): Promise<PatientHistory> {
  return invoke<PatientHistory>("patient_history", { identity: identity.identity });
}
