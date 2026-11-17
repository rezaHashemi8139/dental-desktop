import { z } from "zod";
import type { ParseKeys } from "i18next";
import { MIN_PASSWORD_LENGTH, USERNAME_PATTERN } from "./session";
import { isValidNationalId, LICENSE_NUMBER_PATTERN, PHONE_PATTERN, POSTAL_CODE_PATTERN } from "./setup";

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

export const registerSchema = z
  .object({
    fullName: requiredText,
    username,
    password: newPassword,
    confirmPassword: z.string(),
  })
  .refine(passwordsMatch, passwordMismatch);
export type RegisterValues = z.infer<typeof registerSchema>;

// --- First-start setup (src/pages/setup-form.tsx) ---------------------------

const phone = z.string().trim().regex(PHONE_PATTERN, message("setup.validation.phoneFormat"));

/** Fields of the setup form whatever kind of owner is chosen. */
const setupFields = {
  clinicName: requiredText,
  licenseNumber: z.string().trim().regex(LICENSE_NUMBER_PATTERN, message("setup.validation.licenseNumberFormat")),
  clinicPhone: phone,
  city: requiredText,
  address: requiredText,
  postalCode: z.string().trim().regex(POSTAL_CODE_PATTERN, message("setup.validation.postalCodeFormat")),
  ownerKind: z.enum(["new", "existing"]),
  nationalId: z.string().trim().refine(isValidNationalId, message("setup.validation.nationalIdFormat")),
};

/**
 * Both schemas have the same fields, so the form keeps one set of values and
 * picks the schema by `ownerKind`. A new owner gets the sign-up rules.
 */
export const newOwnerSetupSchema = z
  .object({
    ...setupFields,
    fullName: requiredText,
    ownerPhone: phone,
    username,
    password: newPassword,
    confirmPassword: z.string(),
  })
  .refine(passwordsMatch, passwordMismatch);

/** An existing owner only proves the account, like login. */
export const existingOwnerSetupSchema = z.object({
  ...setupFields,
  // Only used for a new account.
  fullName: z.string(),
  ownerPhone: z.string(),
  confirmPassword: z.string(),
  username: required,
  password: required,
});
export type SetupValues = z.infer<typeof newOwnerSetupSchema>;
