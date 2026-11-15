import i18n from "i18next";
import { initReactI18next } from "react-i18next";

/**
 * Multi-language setup.
 *
 * Every JSON file in `src/locales` is one language. A file describes itself in
 * its `_meta` section (code, full name, abbreviation, text direction), so adding
 * a language only means dropping a new file into that folder — nothing here has
 * to change. See `src/locales/README.md`.
 */

export type TextDirection = "ltr" | "rtl";

export interface Language {
  /** Language code, e.g. "fa". */
  code: string;
  /** Full name in the language itself, e.g. "فارسی". */
  name: string;
  /** Short label, e.g. "FA". */
  abbr: string;
  dir: TextDirection;
}

type LocaleFile = { _meta?: Partial<Language> } & Record<string, unknown>;

/** Used on first launch, before the user has picked a language. */
const DEFAULT_LANGUAGE = "fa";
/** Used for any text missing from the selected language's file. */
const FALLBACK_LANGUAGE = "en";
const STORAGE_KEY = "language";

const files = import.meta.glob<LocaleFile>("../locales/*.json", {
  eager: true,
  import: "default",
});

const resources: Record<string, { translation: LocaleFile }> = {};
const found: Language[] = [];

for (const [path, file] of Object.entries(files)) {
  const fileCode = path.slice(path.lastIndexOf("/") + 1, -".json".length);
  const meta = file._meta ?? {};
  const code = meta.code?.trim() || fileCode;

  if (resources[code]) {
    console.warn(`[i18n] ${path}: language "${code}" is already loaded, file skipped.`);
    continue;
  }

  resources[code] = { translation: file };
  found.push({
    code,
    name: meta.name?.trim() || code,
    abbr: meta.abbr?.trim() || code.toUpperCase(),
    dir: meta.dir === "rtl" ? "rtl" : "ltr",
  });
}

/** All available languages, sorted by code. */
export const languages: readonly Language[] = found.sort((a, b) => a.code.localeCompare(b.code));

export function getLanguage(code: string | undefined): Language {
  return (
    languages.find((language) => language.code === code) ??
    languages.find((language) => language.code === FALLBACK_LANGUAGE) ??
    languages[0]
  );
}

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

const saved = readSavedLanguage();
const initialLanguage =
  saved && resources[saved] ? saved : resources[DEFAULT_LANGUAGE] ? DEFAULT_LANGUAGE : FALLBACK_LANGUAGE;

i18n.on("languageChanged", applyLanguage);

i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage,
  fallbackLng: FALLBACK_LANGUAGE,
  supportedLngs: Object.keys(resources),
  initAsync: false,
  interpolation: {
    // React already escapes rendered text.
    escapeValue: false,
  },
});

export default i18n;
