import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { getLanguage, getLanguages, subscribeLanguages } from "./index";

/** Current language, the list of all languages, and a way to switch. */
export function useLanguage() {
  const { i18n } = useTranslation();
  const languages = useSyncExternalStore(subscribeLanguages, getLanguages);

  return {
    language: getLanguage(i18n.resolvedLanguage),
    languages,
    setLanguage: (code: string) => i18n.changeLanguage(code),
  };
}
