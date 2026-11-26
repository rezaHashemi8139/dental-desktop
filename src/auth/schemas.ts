import { z } from "zod";
import type { ParseKeys } from "i18next";
import { MIN_PASSWORD_LENGTH, USERNAME_PATTERN } from "./session";
import { isValidNationalId, LICENSE_NUMBER_PATTERN, PHONE_PATTERN, POSTAL_CODE_PATTERN } from "./setup";
import { isRecoveryKeyFormat } from "@/lib/backup";

/**
 * Form rules. Error messages are translation keys, translated while rendering
 * (see `fieldError` in src/lib/form.ts) so they follow language changes.
 * The server checks sign-up and setup again. Login only requires both fields, so
 * accounts made under older rules can still log in.
 */
const message = (key: ParseKeys) => key;

const required = z.string().min(1, message("auth.validation.required"));
const requiredText = z.string().trim().min(1, message("auth.validation.required"));
const username = z.string().trim().regex(USERNAME_PATTERN, message("auth.validation.usernameFormat"));
const newPassword = z
  .string()
  // Counted in characters (code points) like the server, not UTF-16 units.
  .refine((v) => [...v].length >= MIN_PASSWORD_LENGTH, message("auth.validation.passwordLength"))
  .regex(/[0-9]/, message("auth.validation.passwordDigit"))
  .regex(/[a-z]/, message("auth.validation.passwordLower"))
  .regex(/[A-Z]/, message("auth.validation.passwordUpper"));
const passwordsMatch = (v: { password: string; confirmPassword: string }) => v.confirmPassword === v.password;
const passwordMismatch = { path: ["confirmPassword"], message: message("auth.validation.passwordMismatch") };

export const loginSchema = z.object({
  username: required,
  password: required,
});
export type LoginValues = z.infer<typeof loginSchema>;

const phone = z.string().trim().regex(PHONE_PATTERN, message("setup.validation.phoneFormat"));
const nationalId = z.string().trim().refine(isValidNationalId, message("setup.validation.nationalIdFormat"));

/** Every account has an identity (unique across the system) and a mobile number. */
export const registerSchema = z
  .object({
    fullName: requiredText,
    nationalId,
    phone,
    username,
    password: newPassword,
    confirmPassword: z.string(),
  })
  .refine(passwordsMatch, passwordMismatch);
export type RegisterValues = z.infer<typeof registerSchema>;

/** A new password in place of a temporary one: the sign-up rules. */
export const changePasswordSchema = z
  .object({
    password: newPassword,
    confirmPassword: z.string(),
  })
  .refine(passwordsMatch, passwordMismatch);
export type ChangePasswordValues = z.infer<typeof changePasswordSchema>;

// --- First start: the clinic this computer joins (src/pages/clinic-setup.tsx) ---

/** A point picked on the map; null until one is picked. */
const location = z
  .object({ latitude: z.number(), longitude: z.number() })
  .nullable()
  // The server takes 0, 0 for "never set".
  .refine((v) => v !== null && (v.latitude !== 0 || v.longitude !== 0), message("setup.validation.locationRequired"));

const clinicFields = {
  name: requiredText,
  licenseNumber: z.string().trim().regex(LICENSE_NUMBER_PATTERN, message("setup.validation.licenseNumberFormat")),
  phone,
  city: requiredText,
  address: requiredText,
  postalCode: z.string().trim().regex(POSTAL_CODE_PATTERN, message("setup.validation.postalCodeFormat")),
  location,
};

/** A new clinic, for an account with an identity on file. */
export const clinicSchema = z.object({ ...clinicFields, nationalId: z.string() });

/** A new clinic, for an old account without an identity on file: it is saved with the clinic. */
export const clinicWithIdentitySchema = z.object({ ...clinicFields, nationalId });

export type ClinicValues = z.infer<typeof clinicWithIdentitySchema>;

// --- Database page (src/components/*-database-dialog.tsx) ------------------

// Every database action also asks for the user's own account password ("is it
// really you?"); Rust checks it.

/** The backup password follows the same rules as an account password. */
export const exportDatabaseSchema = z
  .object({
    password: newPassword,
    confirmPassword: z.string(),
    accountPassword: required,
  })
  .refine(passwordsMatch, passwordMismatch);
export type ExportDatabaseValues = z.infer<typeof exportDatabaseSchema>;

export const restoreDatabaseSchema = z.object({
  mode: z.enum(["replace", "merge"]),
  path: z.string().min(1, message("backup.validation.fileRequired")),
  recoveryKey: z.string().trim().refine(isRecoveryKeyFormat, message("backup.validation.recoveryKeyFormat")),
  password: required,
  accountPassword: required,
});
export type RestoreDatabaseValues = z.infer<typeof restoreDatabaseSchema>;

/** Clearing is also confirmed by typing one's own username, exactly as shown. */
export function clearDatabaseSchema(username: string) {
  return z.object({
    confirmation: z.string().trim().refine((v) => v === username, message("database.validation.confirmationMismatch")),
    accountPassword: required,
  });
}
export type ClearDatabaseValues = z.infer<ReturnType<typeof clearDatabaseSchema>>;
