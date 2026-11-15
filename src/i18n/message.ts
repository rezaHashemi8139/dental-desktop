import i18n from "./index";

/**
 * Text from the Rust side: a translation key plus values (see
 * `src-tauri/src/message.rs`). Keep the object in state and translate it while
 * rendering, so it follows language changes.
 */
export interface RustMessage {
  key: string;
  params?: Record<string, unknown>;
}

export function isRustMessage(value: unknown): value is RustMessage {
  return typeof value === "object" && value !== null && typeof (value as RustMessage).key === "string";
}

/** Turns anything a command returned or threw into a `RustMessage`. */
export function toRustMessage(value: unknown): RustMessage {
  if (isRustMessage(value)) return value;
  const details = value instanceof Error ? value.message : String(value);
  return { key: "errors.unknown", params: { details } };
}

/** The text of a message in the current language. */
export function translateMessage(message: RustMessage): string {
  // Keys come from Rust at runtime, so they can't be type-checked here.
  const t = i18n.t as unknown as (key: string, options?: Record<string, unknown>) => string;
  return t(message.key, { ...message.params, defaultValue: message.key });
}
