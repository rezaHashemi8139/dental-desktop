import { invoke } from "@tauri-apps/api/core";

/**
 * First start: the clinic and its owner are registered together with this
 * computer (see src-tauri/src/setup.rs). Until then the login screen shows the
 * setup form (ConnectionMode "setup").
 */

/** See ClinicInput in src-tauri/src/setup.rs. */
export interface ClinicInput {
  name: string;
  /** Unique across all clinics. */
  licenseNumber: string;
  phone: string;
  city: string;
  address: string;
  postalCode: string;
}

/** Who is responsible for the clinic: a new account, or an existing one proven with its password. */
export type OwnerInput =
  | { kind: "new"; username: string; password: string; fullName: string; nationalId: string; phone: string }
  | { kind: "existing"; username: string; password: string; nationalId: string };

/** Returns the owner's username, as the server spells it. Throws a RustMessage on failure. */
export function setupClinic(clinic: ClinicInput, owner: OwnerInput): Promise<string> {
  return invoke<string>("setup_clinic", { clinic, owner });
}

// Same rules as the server (dental-server/proto/dental/v1/installation.proto).
export const LICENSE_NUMBER_PATTERN = /^[A-Za-z0-9./-]{3,32}$/;
export const PHONE_PATTERN = /^\+?[0-9]{7,15}$/;
/** Optional: empty or 5-10 digits. */
export const POSTAL_CODE_PATTERN = /^([0-9]{5,10})?$/;

/**
 * Iranian national ID: 10 digits, the last one a check digit. IDs made of one
 * repeated digit pass the check but are never issued.
 * Same check as validNationalID in dental-server/internal/service/installation.go.
 */
export function isValidNationalId(id: string): boolean {
  if (!/^[0-9]{10}$/.test(id) || id === id[0].repeat(10)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(id[i]) * (10 - i);
  const remainder = sum % 11;
  const check = Number(id[9]);
  return remainder < 2 ? check === remainder : check === 11 - remainder;
}
