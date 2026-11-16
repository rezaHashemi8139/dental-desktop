import { useCallback, useEffect, useState } from "react";
import { DownloadIcon, LoaderCircleIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  fetchLanguageCatalog,
  installLanguage,
  removeLanguage,
  restoreLanguage,
  type CatalogEntry,
  type Language,
} from "@/i18n";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { useLanguage } from "@/i18n/use-language";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface LanguageManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Lists installed languages and the ones on the language server; downloads, updates
 * and removes them. Removed built-in languages are listed as available and are
 * added back without a download.
 */
export function LanguageManagerDialog({ open, onOpenChange }: LanguageManagerDialogProps) {
  const { t } = useTranslation();
  const { language: active, languages, hiddenLanguages } = useLanguage();

  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [catalogError, setCatalogError] = useState<RustMessage | null>(null);
  const [actionError, setActionError] = useState<RustMessage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    setCatalog(null);
    setCatalogError(null);
    try {
      setCatalog(await fetchLanguageCatalog());
    } catch (error) {
      setCatalogError(toRustMessage(error));
    }
  }, []);

  useEffect(() => {
    if (open) {
      setActionError(null);
      loadCatalog();
    }
  }, [open, loadCatalog]);

  async function run(code: string, action: (code: string) => Promise<void>) {
    setBusy(code);
    setActionError(null);
    try {
      await action(code);
    } catch (error) {
      setActionError(toRustMessage(error));
    } finally {
      setBusy(null);
    }
  }

  const serverVersion = (code: string) => catalog?.find((entry) => entry.code === code)?.version;
  // A removed built-in language is offered from the app itself, never as a download.
  const known = (code: string) => [...languages, ...hiddenLanguages].some((language) => language.code === code);
  const available = catalog?.filter((entry) => !known(entry.code)) ?? [];

  function renderInstalled(language: Language) {
    const isActive = language.code === active.code;
    const latest = serverVersion(language.code);
    const canUpdate = language.source === "installed" && latest !== undefined && latest > language.version;
    const removeBlockedReason = isActive ? t("languageManager.activeCannotBeRemoved") : null;

    return (
      <li key={language.code} className="flex items-center gap-2 py-2">
        <span className="flex-1 truncate" dir={language.dir}>
          {language.name}
        </span>
        <span className="text-xs text-muted-foreground">{language.abbr}</span>
        {isActive && <Badge>{t("languageManager.active")}</Badge>}
        {language.source === "builtin" && <Badge variant="secondary">{t("languageManager.builtIn")}</Badge>}

        {canUpdate && (
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run(language.code, installLanguage)}>
            {busy === language.code ? <LoaderCircleIcon className="animate-spin" /> : <RefreshCwIcon />}
            {t("languageManager.update")}
          </Button>
        )}
        {/* A disabled button shows no tooltip, so the reason sits on a wrapper. */}
        <span title={removeBlockedReason ?? undefined}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("languageManager.remove")}
            disabled={busy !== null || removeBlockedReason !== null}
            onClick={() => run(language.code, removeLanguage)}
          >
            {busy === language.code && !canUpdate ? <LoaderCircleIcon className="animate-spin" /> : <Trash2Icon />}
          </Button>
        </span>
      </li>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("languageManager.title")}</DialogTitle>
          <DialogDescription>{t("languageManager.description")}</DialogDescription>
        </DialogHeader>

        {actionError && <p className="text-sm text-destructive">{translateMessage(actionError)}</p>}

        <section>
          <h3 className="text-sm font-medium">{t("languageManager.installed")}</h3>
          <ul className="divide-y">{languages.map(renderInstalled)}</ul>
        </section>

        <section>
          <h3 className="text-sm font-medium">{t("languageManager.available")}</h3>
          {hiddenLanguages.length > 0 && (
            <ul className="divide-y">
              {hiddenLanguages.map((language) => (
                <li key={language.code} className="flex items-center gap-2 py-2">
                  <span className="flex-1 truncate" dir={language.dir}>
                    {language.name}
                  </span>
                  <span className="text-xs text-muted-foreground">{language.abbr}</span>
                  <Badge variant="secondary">{t("languageManager.builtIn")}</Badge>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => run(language.code, async (code) => restoreLanguage(code))}
                  >
                    <PlusIcon />
                    {t("languageManager.restore")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {catalogError ? (
            <div className="flex flex-col items-start gap-2 py-2">
              <p className="text-sm text-destructive">{translateMessage(catalogError)}</p>
              <Button size="sm" variant="outline" onClick={loadCatalog}>
                <RefreshCwIcon />
                {t("languageManager.retry")}
              </Button>
            </div>
          ) : catalog === null ? (
            <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <LoaderCircleIcon className="size-4 animate-spin" />
              {t("languageManager.loading")}
            </p>
          ) : available.length === 0 ? (
            hiddenLanguages.length === 0 &&
            <p className="py-2 text-sm text-muted-foreground">{t("languageManager.noneAvailable")}</p>
          ) : (
            <ul className="divide-y">
              {available.map((entry) => (
                <li key={entry.code} className="flex items-center gap-2 py-2">
                  <span className="flex-1 truncate" dir={entry.dir}>
                    {entry.name}
                  </span>
                  <span className="text-xs text-muted-foreground">{entry.abbr}</span>
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run(entry.code, installLanguage)}>
                    {busy === entry.code ? <LoaderCircleIcon className="animate-spin" /> : <DownloadIcon />}
                    {t("languageManager.install")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}
