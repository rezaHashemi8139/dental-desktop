import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";

/**
 * Multi-language setup.
 *
 * A language is one JSON file that describes itself in its `_meta` section
 * (code, full name, abbreviation, text direction, version). Languages come from
 * two places:
 * - built-in: every file in `src/locales`, bundled into the app;
 * - installed: downloaded from the language server and saved by the Rust side
 *   (see `src-tauri/src/languages.rs`). These can be removed again.
 * See `src/locales/README.md`.
 */

export type TextDirection = "ltr" | "rtl";
export type LanguageSource = "builtin" | "installed";

export interface Language {
  /** Language code, e.g. "fa". */
  code: string;
  /** Full name in the language itself, e.g. "فارسی". */
  name: string;
  /** Short label, e.g. "FA". */
  abbr: string;
  dir: TextDirection;
  version: number;
  source: LanguageSource;
}

type LanguageMeta = Partial<Omit<Language, "source">>;
export type LanguageFile = { _meta?: LanguageMeta } & Record<string, unknown>;

/** Used on first launch, before the user has picked a language. */
const DEFAULT_LANGUAGE = "fa";
/** Used for any text missing from the selected language's file. */
const FALLBACK_LANGUAGE = "en";
const STORAGE_KEY = "language";
const NAMESPACE = "translation";

// ---------------------------------------------------------------------------
// Language list (a tiny store React subscribes to via useLanguage)

let languages: readonly Language[] = [];
const listeners = new Set<() => void>();

export function getLanguages(): readonly Language[] {
  return languages;
}

export function subscribeLanguages(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setLanguages(next: Language[]) {
  languages = next.sort((a, b) => a.code.localeCompare(b.code));
  listeners.forEach((listener) => listener());
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
  };
}

/** Adds or replaces a language. Built-in languages are never replaced by downloads. */
function register(file: LanguageFile, fallbackCode: string, source: LanguageSource): Language | null {
  const language = toLanguage(file, fallbackCode, source);
  const existing = languages.find((item) => item.code === language.code);
  if (existing?.source === "builtin") {
    if (source === "builtin") console.warn(`[i18n] Language "${language.code}" is defined twice, extra file skipped.`);
    return null;
  }

  // deep=false, overwrite=true: replace the whole language, e.g. after an update.
  if (i18n.hasResourceBundle(language.code, NAMESPACE)) i18n.removeResourceBundle(language.code, NAMESPACE);
  i18n.addResourceBundle(language.code, NAMESPACE, file, false, true);
  setLanguages([...languages.filter((item) => item.code !== language.code), language]);
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

/** Removes a downloaded language. The language in use and built-in languages cannot be removed. */
export async function removeLanguage(code: string): Promise<void> {
  const language = languages.find((item) => item.code === code);
  if (!language) return;
  if (language.source === "builtin") throw new Error(`Built-in language "${code}" cannot be removed.`);
  if (language.code === i18n.resolvedLanguage) throw new Error(`The active language "${code}" cannot be removed.`);

  await invoke("remove_language", { code });
  i18n.removeResourceBundle(code, NAMESPACE);
  setLanguages(languages.filter((item) => item.code !== code));
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
  const initial = has(saved) ? saved! : has(DEFAULT_LANGUAGE) ? DEFAULT_LANGUAGE : FALLBACK_LANGUAGE;

  i18n.on("languageChanged", applyLanguage);
  await i18n.changeLanguage(initial);
}

export default i18n;
