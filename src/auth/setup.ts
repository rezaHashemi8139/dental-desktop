import { invoke } from "@tauri-apps/api/core";
import { isRustMessage, type RustMessage } from "@/i18n/message";
import { login, type Session } from "./session";

/**
 * First start: this computer is connected to exactly one clinic, for good (see
 * src-tauri/src/setup.rs). Until then logging in is refused with
 * SETUP_REQUIRED; the login screen then lists the account's clinics, and the
 * person picks the one this computer belongs to or adds a new one, then is
 * logged in with the same credentials.
 */

/** The error of a login on a computer not connected to a clinic yet. */
export const SETUP_REQUIRED = "setup.errors.required";

/** A new clinic (see ClinicInput in src-tauri/src/setup.rs). */
export interface ClinicInput {
  name: string;
  /** Unique across all clinics. */
  licenseNumber: string;
  phone: string;
  /** A City.id from listCities(); its province comes with it. */
  cityId: number;
  address: string;
  postalCode: string;
  /** Picked on the map, in WGS 84 degrees. */
  latitude: number;
  longitude: number;
}

/**
 * How a person is identified (src-tauri/src/person.rs): Iranian citizens by national ID,
 * foreign nationals by their FIDA code plus their nationality (ISO 3166-1 alpha-2).
 * National IDs need no nationality: it is always "IR".
 */
export interface PersonIdentityInput {
  identityType: "national" | "foreign";
  identity: string;
  nationality?: string;
}

/**
 * The clinic this computer is connected to (see SetupTarget in src-tauri/src/setup.rs):
 * a new one, owned by the person setting up, or one they already own.
 * A new clinic needs an identity only when the account has none on file
 * (MyClinics.identityOnFile).
 */
export type SetupTarget =
  | ({ kind: "new"; clinic: ClinicInput } & Partial<PersonIdentityInput>)
  | { kind: "existing"; licenseNumber: string };

/** A clinic the account owns or administers (see MyClinic in src-tauri/src/setup.rs). */
export interface MyClinic {
  /** Identifies the clinic in SetupTarget "existing". */
  licenseNumber: string;
  name: string;
  city: string;
  address: string;
  isOwner: boolean;
  ownerFullName: string;
  /** Computers already connected, and how many the owner's subscription allows (0 if none). */
  installationCount: number;
  maxInstallations: number;
  /** Unix seconds; 0 if the owner has no subscription in force. */
  subscriptionEndsAt: number;
  /** Why this computer cannot be connected to the clinic; null if it can. */
  cannotAdd: RustMessage | null;
}

/** The account's clinics (see MyClinics in src-tauri/src/setup.rs). */
export interface MyClinics {
  fullName: string;
  /** False only for old accounts: adding a clinic then needs their national ID. */
  identityOnFile: boolean;
  /** Owned ones first, then oldest first. */
  clinics: MyClinic[];
  /** The account's own subscription: unix seconds, 0 if none is in force. */
  subscriptionEndsAt: number;
  maxClinics: number;
  ownedClinicCount: number;
}

/** A province of Iran with its cities (see Province in src-tauri/src/setup.rs). Official Persian names. */
export interface Province {
  id: number;
  name: string;
  cities: { id: number; name: string }[];
}

// Each call throws a RustMessage (see src/i18n/message.ts) on failure.

/** Provinces and cities ordered by ID: sort them by name for display. Needs the server. */
export function listCities(): Promise<Province[]> {
  return invoke<Province[]>("list_cities");
}

export function listMyClinics(username: string, password: string): Promise<MyClinics> {
  return invoke<MyClinics>("list_my_clinics", { username, password });
}

/** A free plan the server started by itself for the owner's first clinic (see FreeTrial in setup.rs). */
export interface FreeTrial {
  planName: string;
  /** Unix seconds. */
  endsAt: number;
}

/**
 * Connects this computer to `target`. Does not log in. Returns the free trial
 * registering a first clinic may have started (then the login is a full one).
 */
export function setupClinic(username: string, password: string, target: SetupTarget): Promise<FreeTrial | null> {
  return invoke<FreeTrial | null>("setup_clinic", { username, password, target });
}

/** The credentials of a login that must pick or add the clinic first, with the account's clinics. */
export interface PendingSetup {
  username: string;
  password: string;
  clinics: MyClinics;
}

/**
 * Logs in; on a computer not connected to a clinic yet, returns the account's
 * clinics instead (proven with the same password). Throws a RustMessage.
 */
export async function startLogin(
  username: string,
  password: string,
): Promise<{ session: Session } | { setup: PendingSetup }> {
  try {
    return { session: await login(username, password) };
  } catch (e) {
    if (!isRustMessage(e) || e.key !== SETUP_REQUIRED) throw e;
  }
  return { setup: { username, password, clinics: await listMyClinics(username, password) } };
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
