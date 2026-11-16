import { BanknoteIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCurrency, useCurrencyName } from "@/i18n/currency";
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

/** Picks the currency amounts are shown and typed in; "auto" follows the language. */
export function CurrencySwitcher() {
  const { t } = useTranslation();
  const { choice, currency, languageCurrency, options, setChoice } = useCurrency();
  const name = useCurrencyName();

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
        <DropdownMenuRadioGroup value={choice} onValueChange={setChoice}>
          <DropdownMenuRadioItem value="auto">
            {t("currency.auto")}
            <span className="ms-4 text-xs text-muted-foreground">{name(languageCurrency.id)}</span>
          </DropdownMenuRadioItem>
          {options.map((id) => (
            <DropdownMenuRadioItem key={id} value={id}>
              {name(id)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
