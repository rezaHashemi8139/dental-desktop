import { invoke } from "@tauri-apps/api/core";
import type { PersonIdentityInput } from "@/auth/setup";

/**
 * Adding a user to the clinic (src-tauri/src/members.rs). Only the new user's
 * own details go to the server; it needs the server and a clinic admin.
 * Throws a RustMessage (src/i18n/message.ts) on failure.
 */

export interface MemberInput extends PersonIdentityInput {
  fullName: string;
  phone: string;
  /** Optional: empty for none. */
  email: string;
  username: string;
  /** The server makes them change it before their first login. */
  temporaryPassword: string;
}

export interface CreatedMember {
  /** Server user id, 32 hex digits: also a LocalUser id from now on. */
  id: string;
  username: string;
  fullName: string;
  /**
   * False when the person already had an account: it keeps its own username and
   * password, and the temporary password typed was not used.
   */
  created: boolean;
}

/** Creates the account (or finds the person's existing one) and lets it log in to this clinic. */
export function createMember(member: MemberInput): Promise<CreatedMember> {
  return invoke<CreatedMember>("create_member", { member });
}

/**
 * Sets a staff member's birth date on their account (Gregorian "YYYY-MM-DD", "" to
 * remove it), for birthdays on the home calendar. Returns it as stored.
 */
export function setMemberBirthDate(userId: string, birthDate: string): Promise<string> {
  return invoke<string>("set_member_birth_date", { userId, birthDate });
}

/**
 * Copies the staff's birth dates from the server to this computer (online only;
 * offline it does nothing), so one set on another computer shows on the home calendar.
 */
export function refreshBirthDates(): Promise<void> {
  return invoke<void>("refresh_birth_dates");
}
