import { useCallback, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useLanguage } from "./use-language";

/**
 * Currencies for showing and entering money.
 *
 * Amounts are always stored, compared and sent to Rust and the server as plain
 * numbers in the language's base unit (its currency with factor 1, e.g. Rial for
 * Persian), whatever currency is shown. A currency only changes how such a number is shown and typed:
 * `fromStored` turns a stored number into the number the user sees, `toStored`
 * turns what the user typed back into a stored number. Nothing else should apply
 * `factor` by hand.
 *
 * Example in Persian: the stored number 1,250,000 is "1,250,000 ریال" with Rial
 * and "125,000 تومان" with Toman; typing 125,000 with Toman saves 1,250,000.
 *
 * There is no exchange rate between currencies of different languages: switching
 * from Persian to English shows the same stored numbers with the English currency.
 */

export interface Currency {
  /** "IRR", "IRT" (Toman, not an ISO code), "USD", ... */
  id: string;
  /** ISO 4217 code for Intl. Toman uses IRR. */
  iso: string;
  /** Stored units per shown unit: Rial 1, Toman 10. */
  factor: number;
  /** Most decimal places shown and accepted. */
  decimals: number;
  /**
   * Shown as "<amount> <translated name>" (`currency.<id>` in the language file)
   * instead of the Intl currency format, which has no Toman and puts "ریال" first.
   */
  named?: boolean;
}

const CURRENCIES = {
  IRR: { id: "IRR", iso: "IRR", factor: 1, decimals: 0, named: true },
  // 1 Toman = 10 Rial. One decimal so amounts that are not a multiple of 10 Rial still show exactly.
  IRT: { id: "IRT", iso: "IRR", factor: 10, decimals: 1, named: true },
  USD: { id: "USD", iso: "USD", factor: 1, decimals: 2 },
  EUR: { id: "EUR", iso: "EUR", factor: 1, decimals: 2 },
} satisfies Record<string, Currency>;

export type CurrencyId = keyof typeof CURRENCIES;

interface LanguageCurrencies {
  /** Currencies the user can pick from; amounts are stored in the one with factor 1. */
  currencies: readonly CurrencyId[];
  /** Used until the user picks another one. */
  default: CurrencyId;
}

/** Currencies of each language. A language not listed uses OTHER_LANGUAGES. */
const LANGUAGE_CURRENCIES: Record<string, LanguageCurrencies> = {
  // Stored in Rial, shown in Toman by default as people usually say prices in Toman.
  fa: { currencies: ["IRR", "IRT"], default: "IRT" },
  en: { currencies: ["USD"], default: "USD" },
  de: { currencies: ["EUR"], default: "EUR" },
};
const OTHER_LANGUAGES: LanguageCurrencies = { currencies: ["USD"], default: "USD" };

function languageSettings(languageCode: string): LanguageCurrencies {
  return LANGUAGE_CURRENCIES[languageCode] ?? OTHER_LANGUAGES;
}

export function languageCurrencies(languageCode: string): readonly Currency[] {
  return languageSettings(languageCode).currencies.map((id) => CURRENCIES[id]);
}

/** The currency a language starts with, before the user picks one. */
export function languageDefaultCurrency(languageCode: string): Currency {
  return CURRENCIES[languageSettings(languageCode).default];
}

// ---------------------------------------------------------------------------
// Converting between stored and shown numbers

/** Removes floating-point noise, e.g. 1.1 * 10 = 11.000000000000002 → 11. */
function round(value: number, decimals: number): number {
  const scale = 10 ** Math.max(0, decimals);
  return Math.round(value * scale) / scale;
}

/** Decimal places of the stored number: Toman has 1 decimal × 10 → whole Rials. */
function storedDecimals(currency: Currency): number {
  return Math.max(0, currency.decimals - Math.round(Math.log10(currency.factor)));
}

/** Stored number → number shown in `currency`. */
export function fromStored(stored: number, currency: Currency): number {
  return round(stored / currency.factor, currency.decimals);
}

/** Number typed in `currency` → number to store. */
export function toStored(shown: number, currency: Currency): number {
  return round(round(shown, currency.decimals) * currency.factor, storedDecimals(currency));
}

/**
 * Reads a typed amount: accepts Persian and Arabic digits, thousands separators
 * ("," "٬" spaces) and "." or "٫" as decimal point. Empty → null, invalid → NaN.
 */
export function parseAmount(text: string): number | null {
  const latin = text
    .replace(/[۰-۹٠-٩]/g, (d) => String(d.charCodeAt(0) & 0xf))
    .replace(/[\s,٬،‎‏]/g, "")
    .replace(/٫/g, ".");
  if (latin === "") return null;
  return /^-?(\d+\.?\d*|\.\d+)$/.test(latin) ? Number(latin) : NaN;
}

// ---------------------------------------------------------------------------
// The user's choice (per language, saved on this computer)

const STORAGE_KEY = "currency";

/** Language code → chosen currency id. */
let choices: Record<string, string> = readSavedChoices();
const listeners = new Set<() => void>();

function readSavedChoices(): Record<string, string> {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (saved && typeof saved === "object" && !Array.isArray(saved)) return saved;
  } catch {
    // Storage unavailable or unreadable: use the defaults.
  }
  return {};
}

export function setCurrencyChoice(languageCode: string, currencyId: string) {
  choices = { ...choices, [languageCode]: currencyId };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choices));
  } catch {
    // Storage unavailable: the choice just won't be remembered.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The currencies of the current language, the one in use (the user's pick, else
 * the language's default), the default, and a way to change it.
 */
export function useCurrency() {
  const { language } = useLanguage();
  const saved = useSyncExternalStore(subscribe, () => choices);
  const currencies = languageCurrencies(language.code);
  const defaultCurrency = languageDefaultCurrency(language.code);
  const currency = currencies.find((item) => item.id === saved[language.code]) ?? defaultCurrency;
  return {
    currency,
    currencies,
    defaultCurrency,
    setCurrency: (currencyId: string) => setCurrencyChoice(language.code, currencyId),
  };
}

// ---------------------------------------------------------------------------
// Showing amounts

/** Formats a shown number (not a stored one) without the currency, e.g. "۱۲۵٬۰۰۰". */
function formatNumber(languageCode: string, shown: number, currency: Currency): string {
  return new Intl.NumberFormat(languageCode, {
    minimumFractionDigits: 0,
    maximumFractionDigits: currency.decimals,
  }).format(shown);
}

/**
 * Formats stored amounts in the current language and currency, e.g.
 * `formatMoney(1250000)` → "۱۲۵٬۰۰۰ تومان" with Toman.
 */
export function useFormatMoney() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { currency } = useCurrency();
  return useCallback(
    (stored: number) => {
      const shown = fromStored(stored, currency);
      if (currency.named) {
        return t("currency.amount", {
          amount: formatNumber(language.code, shown, currency),
          unit: t(`currency.${currency.id as "IRR" | "IRT"}`),
        });
      }
      return new Intl.NumberFormat(language.code, {
        style: "currency",
        currency: currency.iso,
        minimumFractionDigits: 0,
        maximumFractionDigits: currency.decimals,
      }).format(shown);
    },
    [t, language.code, currency],
  );
}

/** Short unit label for inputs: "تومان", "ریال", "$", "€". */
export function useCurrencyUnit(): string {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { currency } = useCurrency();
  if (currency.named) return t(`currency.${currency.id as "IRR" | "IRT"}`);
  const part = new Intl.NumberFormat(language.code, { style: "currency", currency: currency.iso })
    .formatToParts(0)
    .find((item) => item.type === "currency");
  return part?.value ?? currency.iso;
}

/** A stored amount as editable text in `currency`, without grouping, e.g. "۱۲۵۰۰۰" for Toman in Persian. */
export function storedToInputText(stored: number | null, currency: Currency, languageCode: string): string {
  if (stored === null || !Number.isFinite(stored)) return "";
  return new Intl.NumberFormat(languageCode, {
    useGrouping: false,
    maximumFractionDigits: currency.decimals,
  }).format(fromStored(stored, currency));
}
