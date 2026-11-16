import { BanknoteIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCurrency } from "@/i18n/currency";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Picks the currency amounts are shown and typed in. Hidden when the language has only one. */
export function CurrencySwitcher() {
  const { t } = useTranslation();
  const { currency, currencies, defaultCurrency, setCurrency } = useCurrency();
  if (currencies.length < 2) return null;

  // Only languages with named currencies (Persian: Rial, Toman) offer a choice today.
  const name = (id: string) => t(`currency.${id as "IRR" | "IRT"}`);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label={t("currency.label")} title={t("currency.label")}>
          <BanknoteIcon data-icon="inline-start" />
          {name(currency.id)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t("currency.label")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={currency.id} onValueChange={setCurrency}>
          {currencies.map((item) => (
            <DropdownMenuRadioItem key={item.id} value={item.id}>
              {name(item.id)}
              {item.id === defaultCurrency.id && (
                <span className="ms-4 text-xs text-muted-foreground">{t("currency.default")}</span>
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
