import { useState, type ComponentProps } from "react";
import { Input } from "@/components/ui/input";
import { parseAmount, storedToInputText, toStored, useCurrency, useCurrencyUnit } from "@/i18n/currency";
import { useLanguage } from "@/i18n/use-language";
import { cn } from "@/lib/utils";

interface MoneyInputProps extends Omit<ComponentProps<typeof Input>, "value" | "onChange" | "type"> {
  /** Stored amount (base unit, e.g. Rial), or null when empty. */
  value: number | null;
  /** Called with the stored amount: typing 125,000 with Toman gives 1,250,000. */
  onChange: (stored: number | null) => void;
}

/**
 * Amount input in the currency chosen in the header. Takes and returns stored
 * numbers; the user sees and types the chosen currency (see src/i18n/currency.ts).
 * Accepts Persian, Arabic and Latin digits.
 */
export function MoneyInput({ value, onChange, className, ...inputProps }: MoneyInputProps) {
  const { language } = useLanguage();
  const { currency } = useCurrency();
  const unit = useCurrencyUnit();
  const [text, setText] = useState(() => storedToInputText(value, currency, language.code));
  const [shownFor, setShownFor] = useState({ value, currency });

  // The amount changed from outside, or the currency was switched: show it again.
  if (shownFor.value !== value || shownFor.currency !== currency) {
    setShownFor({ value, currency });
    const typed = parseAmount(text);
    const typedStored = typed === null || Number.isNaN(typed) ? null : toStored(typed, currency);
    if (shownFor.currency !== currency || typedStored !== value) {
      setText(storedToInputText(value, currency, language.code));
    }
  }

  function handleChange(next: string) {
    const shown = parseAmount(next);
    if (shown !== null && (Number.isNaN(shown) || tooManyDecimals(next, currency.decimals))) return;
    setText(next);
    const stored = shown === null ? null : toStored(shown, currency);
    setShownFor({ value: stored, currency });
    onChange(stored);
  }

  return (
    <div className="relative">
      <Input
        {...inputProps}
        inputMode="decimal"
        autoComplete="off"
        className={cn("pe-16", className)}
        value={text}
        onChange={(event) => handleChange(event.target.value)}
      />
      <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-xs text-muted-foreground">
        {unit}
      </span>
    </div>
  );
}

function tooManyDecimals(text: string, decimals: number): boolean {
  const point = text.search(/[.٫]/);
  return point !== -1 && text.length - point - 1 > decimals;
}
