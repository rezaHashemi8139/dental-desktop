import { useState } from "react";
import { LanguagesIcon, SettingsIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLanguage } from "@/i18n/use-language";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LanguageManagerDialog } from "@/components/language-manager-dialog";

export function LanguageSwitcher() {
  const { t } = useTranslation();
  const { language, languages, setLanguage } = useLanguage();
  const [managerOpen, setManagerOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" aria-label={t("language.label")}>
            <LanguagesIcon data-icon="inline-start" />
            {language.abbr}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{t("language.label")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup value={language.code} onValueChange={setLanguage}>
            {languages.map((item) => (
              <DropdownMenuRadioItem key={item.code} value={item.code} dir={item.dir}>
                <span className="flex-1 whitespace-nowrap">{item.name}</span>
                <span className="ms-4 text-xs text-muted-foreground">{item.abbr}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setManagerOpen(true)}>
            <SettingsIcon />
            {t("language.manage")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <LanguageManagerDialog open={managerOpen} onOpenChange={setManagerOpen} />
    </>
  );
}
