import { useCallback, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useLanguage } from "./use-language";

/**
 * Currencies for showing and entering money.
 *
 * Amounts are always stored, compared and sent to Rust and the server as plain
 * numbers. A currency only changes how such a number is shown and typed:
 * `fromStored` turns a stored number into the number the user sees, `toStored`
 * turns what the user typed back into a stored number. Nothing else should apply
 * `factor` by hand. Every currency has factor 1 except Toman: amounts are stored
 * in Rial, so the stored number 1,250,000 is "1,250,000 ریال" with Rial and
 * "125,000 تومان" with Toman, and typing 125,000 with Toman saves 1,250,000.
 *
 * Which currency is used: "auto" (the default) follows the language file's
 * `_meta.currency` (read in index.ts), e.g. Persian:
 *
 *   "currency": { "default": "IRT", "minorUnit": false }
 *
 * `minorUnit` says whether that currency is used with small change (cents);
 * left out, the currency's usual decimals apply. The user can pick a fixed
 * currency in Settings instead. There is no exchange rate: picking another
 * currency shows the same stored numbers in it.
 */

export interface Currency {
  /** "IRR", "IRT" (Toman, not an ISO code), "USD", ... */
  id: string;
  /** ISO 4217 code for Intl. Toman uses IRR. */
  iso: string;
  /** Stored units per shown unit: Rial 1, Toman 10. */
  factor: number;
  /** Most decimal places shown and accepted; 0 when the currency has no small change. */
  decimals: number;
  /**
   * Shown as "<amount> <translated name>" (`currency.<id>` in the language file)
   * instead of the Intl currency format, which has no Toman and puts "ریال" first.
   */
  named?: boolean;
}

/** Currencies that need more than Intl knows. Any other id is an ISO 4217 code with factor 1. */
const SPECIAL_CURRENCIES: Record<string, Omit<Currency, "id">> = {
  IRR: { iso: "IRR", factor: 1, decimals: 0, named: true },
  // 1 Toman = 10 Rial: one decimal is the Rial left over (15 Rial = 1.5 Toman).
  IRT: { iso: "IRR", factor: 10, decimals: 1, named: true },
};

/** Offered in Settings besides the language's own currency. */
export const CURRENCY_OPTIONS: readonly string[] = ["IRR", "IRT", "USD", "EUR", "GBP", "TRY", "AED"];

const cache = new Map<string, Currency>();

/**
 * The currency for an id. `minorUnit` false means no small change (0 decimals);
 * otherwise the currency's usual decimals (Intl's, e.g. USD 2, JPY 0).
 * Always the same object for the same arguments.
 */
export function currencyById(id: string, minorUnit?: boolean): Currency {
  const key = `${id}:${minorUnit}`;
  let currency = cache.get(key);
  if (!currency) {
    const base = SPECIAL_CURRENCIES[id] ?? { iso: id, factor: 1, decimals: intlDecimals(id) };
    currency = { id, ...base, decimals: minorUnit === false ? 0 : base.decimals };
    cache.set(key, currency);
  }
  return currency;
}

function intlDecimals(iso: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: iso }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2; // Not a well-formed code (index.ts already filters these).
  }
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
// The user's choice (saved on this computer)

/** "auto" follows the language; any other value is a fixed currency id. */
export type CurrencyChoice = "auto" | string;

const STORAGE_KEY = "currency";
const CURRENCY_ID = /^[A-Z]{3}$/;

let choice: CurrencyChoice = readSavedChoice();
const listeners = new Set<() => void>();

function readSavedChoice(): CurrencyChoice {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && CURRENCY_ID.test(saved)) return saved;
  } catch {
    // Storage unavailable: use the default.
  }
  return "auto";
}

export function setCurrencyChoice(next: CurrencyChoice) {
  choice = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage unavailable: the choice just won't be remembered.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The user's choice, the currency actually in use, the language's own, the ids to offer, and a setter. */
export function useCurrency() {
  const { language } = useLanguage();
  const current = useSyncExternalStore(subscribe, () => choice);
  const { default: languageId, minorUnit } = language.currency;
  // The language's `minorUnit` belongs to its own currency, also when the user picks that one by hand.
  const fromLanguage = currencyById(languageId, minorUnit);
  const currency = current === "auto" || current === languageId ? fromLanguage : currencyById(current);
  const options = CURRENCY_OPTIONS.includes(languageId) ? CURRENCY_OPTIONS : [languageId, ...CURRENCY_OPTIONS];
  return {
    choice: current,
    currency,
    /** The currency "auto" stands for in the current language. */
    languageCurrency: fromLanguage,
    options,
    setChoice: setCurrencyChoice,
  };
}

/** Display name of a currency id in the current language: "تومان", "US Dollar", ... */
export function useCurrencyName() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  return useCallback(
    (id: string) => {
      if (SPECIAL_CURRENCIES[id]?.named) return t(`currency.${id as "IRR" | "IRT"}`);
      try {
        return new Intl.DisplayNames(language.code, { type: "currency" }).of(id) ?? id;
      } catch {
        return id;
      }
    },
    [t, language.code],
  );
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
  const { currency } = useCurrency();
  return useFormatIn(currency);
}

/**
 * Formats amounts that are real Iranian rials whatever the currency setting, e.g.
 * subscription prices (src/lib/billing.ts): in Toman or Rial as chosen, and in
 * Rial when another currency is chosen, since there is no exchange rate.
 */
export function useFormatRials() {
  const { currency } = useCurrency();
  return useFormatIn(currency.id === "IRT" || currency.id === "IRR" ? currency : currencyById("IRR"));
}

function useFormatIn(currency: Currency) {
  const { t } = useTranslation();
  const { language } = useLanguage();
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
