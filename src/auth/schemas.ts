import { z } from "zod";
import type { ParseKeys } from "i18next";
import { MIN_PASSWORD_LENGTH, USERNAME_PATTERN } from "./session";

/**
 * Form rules. Error messages are translation keys, translated while rendering
 * (see `fieldError` in src/lib/form.ts) so they follow language changes.
 * Sign-up rules match the server; it checks them again.
 */
const message = (key: ParseKeys) => key;

const required = z.string().min(1, message("auth.validation.required"));

export const loginSchema = z.object({
  username: required,
  password: required,
});
export type LoginValues = z.infer<typeof loginSchema>;

export const registerSchema = z
  .object({
    fullName: z.string().trim().min(1, message("auth.validation.required")),
    username: z.string().trim().regex(USERNAME_PATTERN, message("auth.validation.usernameFormat")),
    // Counted in characters (code points) like the server, not UTF-16 units.
    password: z.string().refine((v) => [...v].length >= MIN_PASSWORD_LENGTH, message("auth.validation.passwordLength")),
    confirmPassword: z.string(),
  })
  .refine((v) => v.confirmPassword === v.password, {
    path: ["confirmPassword"],
    message: message("auth.validation.passwordMismatch"),
  });
export type RegisterValues = z.infer<typeof registerSchema>;
