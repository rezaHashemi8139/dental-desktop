import type { FieldError } from "react-hook-form";
import { translateMessage } from "@/i18n/message";

/** The text of a field's error, if any. Schema messages are translation keys (src/auth/schemas.ts). */
export function fieldError(error: FieldError | undefined): string | null {
  return error?.message ? translateMessage({ key: error.message }) : null;
}
