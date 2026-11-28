import { z } from "zod";
import type { ParseKeys } from "i18next";
import { MIN_PASSWORD_LENGTH, USERNAME_PATTERN } from "./session";
import { IDENTITY_CODE_PATTERN, LICENSE_NUMBER_PATTERN, PHONE_PATTERN, POSTAL_CODE_PATTERN } from "./setup";
import { isRecoveryKeyFormat } from "@/lib/backup";
import { CARD_LAST4_PATTERN, PAYMENT_REFERENCE_PATTERN } from "@/lib/billing";
import {
  PAYMENT_KINDS,
  PAYMENT_METHODS,
  PATIENT_PAYMENT_REFERENCE_MAX,
  PATIENT_PAYMENT_REFERENCE_PATTERN,
} from "@/lib/payments";

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
/** Optional: empty, or an email address of at most 254 characters (the server's rule). */
const optionalEmail = (error: ParseKeys) =>
  z
    .string()
    .trim()
    .refine((v) => v === "" || (v.length <= 254 && z.email().safeParse(v).success), error);
const email = optionalEmail(message("setup.validation.emailFormat"));
// Typed in any case, with spaces or dashes; sent the way the server takes it.
const identityCode = z
  .string()
  .transform((v) => v.replace(/[\s-]/g, "").toUpperCase())
  .pipe(z.string().regex(IDENTITY_CODE_PATTERN, message("setup.validation.identityCodeFormat")));

/** Every account has an identity (unique across the system) and a mobile number; an email is optional. */
export const registerSchema = z
  .object({
    fullName: requiredText,
    identityCode,
    phone,
    email,
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

/** The user's own account: what can be changed (src/components/profile-dialog.tsx). */
export const profileSchema = z.object({
  fullName: requiredText,
  phone,
  email,
});
export type ProfileValues = z.infer<typeof profileSchema>;

/** The user's own password (src/components/profile-dialog.tsx): the current one, then the new one twice. */
export const changeOwnPasswordSchema = z
  .object({
    currentPassword: required,
    password: newPassword,
    confirmPassword: z.string(),
  })
  .refine(passwordsMatch, passwordMismatch)
  .refine((v) => v.password !== v.currentPassword, {
    path: ["password"],
    message: message("auth.errors.passwordUnchanged"),
  });
export type ChangeOwnPasswordValues = z.infer<typeof changeOwnPasswordSchema>;

/** The lock screen: only the password; Rust checks it. */
export const unlockSchema = z.object({
  password: required,
});
export type UnlockValues = z.infer<typeof unlockSchema>;

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
  // Picked from the lists (select values are strings); the province only narrows the cities.
  provinceId: z.string().min(1, message("setup.validation.provinceRequired")),
  cityId: z.string().min(1, message("setup.validation.cityRequired")),
  address: requiredText,
  postalCode: z.string().trim().regex(POSTAL_CODE_PATTERN, message("setup.validation.postalCodeFormat")),
  location,
};

/** A new clinic, for an account with an identity on file. */
export const clinicSchema = z.object({ ...clinicFields, identityCode: z.string() });

/** A new clinic, for an old account without an identity on file: it is saved with the clinic. */
export const clinicWithIdentitySchema = z.object({ ...clinicFields, identityCode });

export type ClinicValues = z.infer<typeof clinicWithIdentitySchema>;

// --- Patients (src/components/patient-dialog.tsx, treatment-dialog.tsx) -----

// Rust checks lengths again (src-tauri/src/patients.rs); the inputs' maxLength keeps them in range.

/** A date field's value: "" when empty, null while incomplete or not a real day (src/components/date-field.tsx). */
const optionalDate = z.string().nullable().refine((v) => v !== null, message("patients.errors.invalidBirthDate"));

export const patientSchema = z.object({
  identityCode,
  firstName: z.string().trim().min(1, message("patients.errors.nameRequired")),
  lastName: z.string().trim().min(1, message("patients.errors.nameRequired")),
  birthDate: optionalDate,
  gender: z.enum(["", "male", "female"]),
  // Empty, or the same rule as the clinic's phone.
  phone: z
    .string()
    .transform((v) => v.replace(/[\s-]/g, ""))
    .pipe(z.string().refine((v) => v === "" || PHONE_PATTERN.test(v), message("patients.errors.invalidPhone"))),
  email: optionalEmail(message("patients.errors.invalidEmail")),
  address: z.string().trim(),
  medicalNotes: z.string().trim(),
});
/** As the form holds them (the birth date may be null while being typed). */
export type PatientFormValues = z.input<typeof patientSchema>;
export type PatientValues = z.infer<typeof patientSchema>;

export const treatmentSchema = z.object({
  performedOn: z
    .string()
    .nullable()
    .refine((v) => !!v, message("treatments.errors.invalidDate")),
  tooth: z.string().trim(),
  procedure: z.string().trim().min(1, message("treatments.errors.procedureRequired")),
  notes: z.string().trim(),
  /** A LocalUser id, or "" if not given. */
  performedBy: z.string(),
});
export type TreatmentValues = z.infer<typeof treatmentSchema>;

// --- Subscription purchase (src/components/purchase-dialog.tsx) -------------

/** A transfer the owner made, as reported. The amount is the quote's, never typed. */
export const paymentSchema = z
  .object({
    mode: z.enum(["extend", "upgradeNow"]),
    accountId: z.string().min(1, message("billing.validation.accountRequired")),
    method: z.enum(["cardToCard", "bankTransfer"]),
    reference: z.string().trim().regex(PAYMENT_REFERENCE_PATTERN, message("billing.validation.referenceFormat")),
    /** Days before today the money was sent, "0" for today. */
    daysAgo: z.string(),
    payerCardLast4: z.string().trim(),
  })
  .refine((v) => v.method !== "cardToCard" || CARD_LAST4_PATTERN.test(v.payerCardLast4), {
    path: ["payerCardLast4"],
    message: message("billing.validation.cardLast4Format"),
  });
export type PaymentValues = z.infer<typeof paymentSchema>;

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

// --- Working hours (src/components/work-hours-dialog.tsx, member-dialog.tsx) ---

/** "HH:MM" from a time input (24 hours). */
const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** One entry and its exit on the form's day. */
const workHoursRow = z.object({
  start: z.string().regex(TIME_PATTERN, message("workHours.validation.timeFormat")),
  /** "" while still at work. */
  end: z.string().refine((v) => v === "" || TIME_PATTERN.test(v), message("workHours.validation.timeFormat")),
});

/** Minutes since midnight of "HH:MM". */
const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/**
 * A day and all its entry/exit rows (none empties the day). An exit of "00:00" is
 * midnight at the day's end, an empty one means still at work. Rows may not overlap,
 * and an open row must be the last. Rust checks the times again (no future, no
 * overlap with other days: src-tauri/src/work_hours.rs).
 */
export const workHoursSchema = z.object({
  day: z
    .string()
    .nullable()
    .refine((v) => !!v, message("workHours.validation.dayRequired")),
  rows: z.array(workHoursRow).superRefine((rows, ctx) => {
    const spans: { index: number; start: number; end: number }[] = [];
    rows.forEach((row, index) => {
      if (!TIME_PATTERN.test(row.start) || (row.end !== "" && !TIME_PATTERN.test(row.end))) return;
      const start = minutesOf(row.start);
      const end = row.end === "" ? Infinity : row.end === "00:00" ? 24 * 60 : minutesOf(row.end);
      if (end <= start) {
        ctx.addIssue({ code: "custom", path: [index, "end"], message: message("workHours.validation.endBeforeStart") });
      } else {
        spans.push({ index, start, end });
      }
    });
    spans.sort((a, b) => a.start - b.start);
    for (let i = 1; i < spans.length; i++) {
      if (spans[i].start < spans[i - 1].end) {
        ctx.addIssue({ code: "custom", path: [spans[i].index, "start"], message: message("workHours.validation.overlap") });
      }
    }
  }),
});
export type WorkHoursFormValues = z.input<typeof workHoursSchema>;
export type WorkHoursValues = z.infer<typeof workHoursSchema>;

/** A day's notes; empty removes them. */
export const dayNoteSchema = z.object({
  notes: z.string().trim(),
});
export type DayNoteValues = z.infer<typeof dayNoteSchema>;

/** A new user of the clinic: the sign-up fields, with a temporary password instead of their own. */
export const memberSchema = z.object({
  fullName: requiredText,
  identityCode,
  phone,
  email,
  username,
  temporaryPassword: newPassword,
});
export type MemberValues = z.infer<typeof memberSchema>;

// --- Patient payments and refunds (src/components/payment-dialog.tsx) ------

/** Rust checks everything again (src-tauri/src/payments.rs). */
export const patientPaymentSchema = z.object({
  kind: z.enum(PAYMENT_KINDS),
  paidOn: z
    .string()
    .nullable()
    .refine((v) => !!v, message("payments.errors.invalidDate")),
  /** "HH:MM", 24 hours. */
  paidTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, message("payments.errors.invalidTime")),
  /** A stored amount from <MoneyInput>; null while empty. */
  amount: z
    .number()
    .nullable()
    .refine((v) => v !== null && v > 0, message("payments.errors.invalidAmount")),
  method: z.enum(PAYMENT_METHODS),
  // Spaces are dropped, as Rust does.
  reference: z
    .string()
    .transform((v) => v.replace(/\s/g, ""))
    .pipe(
      z
        .string()
        .max(PATIENT_PAYMENT_REFERENCE_MAX, message("payments.errors.invalidReference"))
        .regex(PATIENT_PAYMENT_REFERENCE_PATTERN, message("payments.errors.invalidReference")),
    ),
  notes: z.string().trim(),
});
/** As the form holds them (the date may be null while being typed). */
export type PatientPaymentFormValues = z.input<typeof patientPaymentSchema>;
export type PatientPaymentValues = z.infer<typeof patientPaymentSchema>;
