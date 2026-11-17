# Translations

Each `.json` file is one language and describes itself in its `_meta` section
(code, full name, abbreviation, direction, version, currencies). There are two ways to ship one:

- **Built into the app:** put the file in this folder. It works without the server. Users can remove it
  from the language list (unless it is in use), which only hides it: its text still serves as the fallback,
  and *Manage languages...* adds it back without a download.
- **Downloadable:** put the file in the server repository, `dental-server/internal/languages/files/`
  (see the README there). The app gets the list and the file from the server's `LanguageService`;
  users download it from *Language → Manage languages...* and can remove it again,
  except for the language they are using. On every start the app downloads, in the background, each installed
  language whose `version` on the server is higher, so raise `version` whenever a file changes.

Only Persian (`fa.json`) is built in; every other language (English, German, ...) is downloaded
from the server. Any text missing from a file falls back to Persian, so a partial translation still works.

Text coming from Rust is translated here too: Rust sends a key such as
`greet.message` plus values, never finished text (see `src-tauri/src/message.rs`).

## Adding a language

1. Give `fa.json` (or the English file, `dental-server/internal/languages/files/en.json`)
   to an AI with the prompt below (replace the language).
2. Save the result as `<code>.json`, e.g. `de.json`, `ar.json`, `tr.json`,
   in this folder or in `dental-server/internal/languages/files/`.

## Prompt for the AI

```
Translate this JSON file of app interface text into <LANGUAGE>.

Rules:
- Return only the complete JSON file, nothing else.
- Translate only the values. Never change, add, remove or reorder keys.
- Keep anything inside {{double braces}} exactly as is, e.g. {{name}}, {{count}}.
- Keep the same JSON structure and nesting.
- Update the "_meta" section for the new language:
  - "code": the ISO 639-1 language code (e.g. "de")
  - "name": the language's name written in that language (e.g. "Deutsch")
  - "abbr": a short uppercase label (e.g. "DE")
  - "dir": "rtl" for right-to-left scripts (Arabic, Persian, Hebrew, Urdu), otherwise "ltr"
  - "version": 1
  - "currency": the money people in that country use: "default" is its ISO 4217 code, "minorUnit"
    is true if prices there use small change such as cents, else false (e.g. {"default": "EUR", "minorUnit": true})
- This is a clinic management app: use the standard terms a clinic in that country would use.
```

## For developers

- `fa.json` is the reference: new keys are added there first, and TypeScript checks every `t("...")` call against it.
  Then run `pnpm sync-locales`: it copies `fa.json` to `dental-server/internal/languages/files/`, aligns the other
  languages there with it (key order, removed keys, `version`) and lists the keys you still have to translate.
- Use text in components with `const { t } = useTranslation();` then `t("section.key")`.
- Values with variables: `"hello": "Hello {{name}}"` → `t("hello", { name })`.
- Dates and money are display-only per language: see `src/i18n/calendar.ts` and `src/i18n/currency.ts`.
  A language's own currency comes from its `_meta.currency`, e.g. Persian `{"default": "IRT", "minorUnit": false}`
  (IRT is Toman; anything else is an ISO 4217 code). The currency setting (Settings dialog) follows it ("auto") or
  fixes any other currency. Amounts are stored as plain numbers (Rial, never Toman); show them with
  `useFormatMoney()` and edit them with `<MoneyInput>`, which convert Toman ↔ Rial (×10) for you.
