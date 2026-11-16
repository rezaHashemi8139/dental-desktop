import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";

/**
 * Multi-language setup.
 *
 * A language is one JSON file that describes itself in its `_meta` section
 * (code, full name, abbreviation, text direction, version). Languages come from
 * two places:
 * - built-in: every file in `src/locales` (only Persian), bundled into the app.
 *   Removing one only hides it (saved on this computer); its text stays loaded as
 *   the fallback and it can be added back without a download;
 * - installed: downloaded from the dental server (English, German, ...) and saved
 *   by the Rust side (see `src-tauri/src/languages.rs`). These can be removed again.
 * The language in use can never be removed.
 * See `src/locales/README.md`.
 */

export type TextDirection = "ltr" | "rtl";
export type LanguageSource = "builtin" | "installed";

export interface Language {
  /** Language code, e.g. "fa". */
  code: string;
  /** Full name in the language itself, e.g. "English". */
  name: string;
  /** Short label, e.g. "FA". */
  abbr: string;
  dir: TextDirection;
  version: number;
  source: LanguageSource;
  /** The language's own currency (`_meta.currency`); see src/i18n/currency.ts. */
  currency: LanguageCurrency;
}

export interface LanguageCurrency {
  /** ISO 4217 code, or "IRT" for Toman. */
  default: string;
  /** Whether the currency is used with small change (cents); undefined: the currency's usual decimals. */
  minorUnit?: boolean;
}

interface LanguageMeta {
  code?: string;
  name?: string;
  abbr?: string;
  dir?: string;
  version?: number;
  currency?: { default?: unknown; minorUnit?: unknown };
}
export type LanguageFile = { _meta?: LanguageMeta } & Record<string, unknown>;

/** Currency of a language file without a valid `_meta.currency`. */
const FALLBACK_CURRENCY = "USD";
const CURRENCY_ID = /^[A-Z]{3}$/;

/** Used on first launch, before the user has picked a language. */
const DEFAULT_LANGUAGE = "fa";
/** Used for any text missing from the selected language's file: the built-in language. */
const FALLBACK_LANGUAGE = "fa";
const STORAGE_KEY = "language";
const HIDDEN_STORAGE_KEY = "hiddenLanguages";
const NAMESPACE = "translation";

// ---------------------------------------------------------------------------
// Language list (a tiny store React subscribes to via useLanguage)

/** Every registered language, including removed built-in ones. */
let allLanguages: readonly Language[] = [];
/** Languages the user can pick: all except removed built-in ones. */
let languages: readonly Language[] = [];
/** Built-in languages the user removed. Their text stays loaded as the fallback. */
let hiddenLanguages: readonly Language[] = [];
let hiddenCodes: ReadonlySet<string> = readHiddenCodes();
const listeners = new Set<() => void>();

export function getLanguages(): readonly Language[] {
  return languages;
}

/** Removed built-in languages, which can be added back without a download. */
export function getHiddenLanguages(): readonly Language[] {
  return hiddenLanguages;
}

export function subscribeLanguages(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setLanguages(next: readonly Language[]) {
  allLanguages = [...next].sort((a, b) => a.code.localeCompare(b.code));
  const isHidden = (language: Language) => language.source === "builtin" && hiddenCodes.has(language.code);
  languages = allLanguages.filter((language) => !isHidden(language));
  hiddenLanguages = allLanguages.filter(isHidden);
  listeners.forEach((listener) => listener());
}

function readHiddenCodes(): ReadonlySet<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(HIDDEN_STORAGE_KEY) ?? "[]");
    if (Array.isArray(saved)) return new Set(saved.filter((code) => typeof code === "string"));
  } catch {
    // Storage unavailable or unreadable: nothing is hidden.
  }
  return new Set();
}

function setHiddenCodes(next: ReadonlySet<string>) {
  hiddenCodes = next;
  try {
    localStorage.setItem(HIDDEN_STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    // Storage unavailable: the language just comes back on the next start.
  }
  setLanguages(allLanguages);
}

export function getLanguage(code: string | undefined): Language {
  return (
    languages.find((language) => language.code === code) ??
    languages.find((language) => language.code === FALLBACK_LANGUAGE) ??
    languages[0]
  );
}

function toLanguage(file: LanguageFile, fallbackCode: string, source: LanguageSource): Language {
  const meta = file._meta ?? {};
  const code = meta.code?.trim() || fallbackCode;
  return {
    code,
    name: meta.name?.trim() || code,
    abbr: meta.abbr?.trim() || code.toUpperCase(),
    dir: meta.dir === "rtl" ? "rtl" : "ltr",
    version: Number(meta.version) || 1,
    source,
    currency: toCurrency(meta.currency),
  };
}

/** Reads `_meta.currency`; an invalid code falls back to FALLBACK_CURRENCY, a non-boolean `minorUnit` is ignored. */
export function toCurrency(meta: LanguageMeta["currency"]): LanguageCurrency {
  const code = typeof meta?.default === "string" && CURRENCY_ID.test(meta.default) ? meta.default : FALLBACK_CURRENCY;
  return typeof meta?.minorUnit === "boolean" ? { default: code, minorUnit: meta.minorUnit } : { default: code };
}

/** Adds or replaces a language. Built-in languages are never replaced by downloads. */
function register(file: LanguageFile, fallbackCode: string, source: LanguageSource): Language | null {
  const language = toLanguage(file, fallbackCode, source);
  const existing = allLanguages.find((item) => item.code === language.code);
  if (existing?.source === "builtin") {
    if (source === "builtin") console.warn(`[i18n] Language "${language.code}" is defined twice, extra file skipped.`);
    return null;
  }

  // deep=false, overwrite=true: replace the whole language, e.g. after an update.
  if (i18n.hasResourceBundle(language.code, NAMESPACE)) i18n.removeResourceBundle(language.code, NAMESPACE);
  i18n.addResourceBundle(language.code, NAMESPACE, file, false, true);
  setLanguages([...allLanguages.filter((item) => item.code !== language.code), language]);
  return language;
}

// ---------------------------------------------------------------------------
// Installing and removing downloaded languages

export interface CatalogEntry {
  code: string;
  name: string;
  abbr: string;
  dir: TextDirection;
  version: number;
}

/** Languages offered by the language server. Throws a `RustMessage` on failure. */
export function fetchLanguageCatalog(): Promise<CatalogEntry[]> {
  return invoke<CatalogEntry[]>("get_language_catalog");
}

/** Downloads (or updates) a language. Throws a `RustMessage` on failure. */
export async function installLanguage(code: string): Promise<void> {
  const file = await invoke<LanguageFile>("install_language", { code });
  register(file, code, "installed");
}

/**
 * Removes a language. A downloaded one is deleted; a built-in one is only hidden
 * (see `restoreLanguage`). The language in use cannot be removed.
 */
export async function removeLanguage(code: string): Promise<void> {
  const language = languages.find((item) => item.code === code);
  if (!language) return;
  if (language.code === i18n.resolvedLanguage) throw new Error(`The active language "${code}" cannot be removed.`);

  if (language.source === "builtin") {
    setHiddenCodes(new Set([...hiddenCodes, code]));
    return;
  }
  await invoke("remove_language", { code });
  i18n.removeResourceBundle(code, NAMESPACE);
  setLanguages(allLanguages.filter((item) => item.code !== code));
}

/** Adds back a removed built-in language. */
export function restoreLanguage(code: string): void {
  if (!hiddenCodes.has(code)) return;
  setHiddenCodes(new Set([...hiddenCodes].filter((item) => item !== code)));
}

// ---------------------------------------------------------------------------
// Startup

function readSavedLanguage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function applyLanguage(code: string) {
  const language = getLanguage(code);
  document.documentElement.lang = language.code;
  document.documentElement.dir = language.dir;
  try {
    localStorage.setItem(STORAGE_KEY, language.code);
  } catch {
    // Storage unavailable: the choice just won't be remembered.
  }
}

/** Loads all languages and selects the saved one. Call once before rendering. */
export async function initI18n(): Promise<void> {
  await i18n.use(initReactI18next).init({
    resources: {},
    fallbackLng: FALLBACK_LANGUAGE,
    interpolation: {
      // React already escapes rendered text.
      escapeValue: false,
    },
  });

  const builtIn = import.meta.glob<LanguageFile>("../locales/*.json", { eager: true, import: "default" });
  for (const [path, file] of Object.entries(builtIn)) {
    register(file, path.slice(path.lastIndexOf("/") + 1, -".json".length), "builtin");
  }

  try {
    const installed = await invoke<LanguageFile[]>("list_installed_languages");
    for (const file of installed) register(file, file._meta?.code ?? "", "installed");
  } catch (error) {
    // Not running inside Tauri (plain browser) or the folder is unreadable: built-in languages still work.
    console.warn("[i18n] Could not load installed languages:", error);
  }

  const saved = readSavedLanguage();
  const has = (code: string | null) => !!code && languages.some((language) => language.code === code);
  const initial = has(saved) ? saved! : has(DEFAULT_LANGUAGE) ? DEFAULT_LANGUAGE : (languages[0]?.code ?? FALLBACK_LANGUAGE);
  // E.g. Persian was removed and the downloaded language in use is gone: bring Persian back.
  if (!has(initial)) restoreLanguage(initial);

  i18n.on("languageChanged", applyLanguage);
  await i18n.changeLanguage(initial);
}

export default i18n;
