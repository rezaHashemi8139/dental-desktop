import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { getHiddenLanguages, getLanguage, getLanguages, subscribeLanguages } from "./index";

/** Current language, the languages to pick from, removed built-in ones, and a way to switch. */
export function useLanguage() {
  const { i18n } = useTranslation();
  const languages = useSyncExternalStore(subscribeLanguages, getLanguages);
  const hiddenLanguages = useSyncExternalStore(subscribeLanguages, getHiddenLanguages);

  return {
    language: getLanguage(i18n.resolvedLanguage),
    languages,
    hiddenLanguages,
    setLanguage: (code: string) => i18n.changeLanguage(code),
  };
}
