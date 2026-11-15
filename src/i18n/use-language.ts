import { useTranslation } from "react-i18next";
import { getLanguage, languages } from "./index";

/** Current language, the list of all languages, and a way to switch. */
export function useLanguage() {
  const { i18n } = useTranslation();

  return {
    language: getLanguage(i18n.resolvedLanguage),
    languages,
    setLanguage: (code: string) => i18n.changeLanguage(code),
  };
}
