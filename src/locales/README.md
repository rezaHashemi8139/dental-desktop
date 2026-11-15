# Translations

Each `.json` file in this folder is one language. The app finds them automatically:
drop a new file in and it appears in the language menu with its name and abbreviation.

## Adding a language

1. Give `en.json` to an AI with the prompt below (replace the language).
2. Save the result here as `<code>.json`, e.g. `de.json`, `ar.json`, `tr.json`.
3. Restart `pnpm start` (or just save — the dev server reloads).

Any text missing from a file falls back to English, so a partial translation still works.

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
- This is a dental clinic management app: use the standard terms a clinic in that country would use.
```

## For developers

- `en.json` is the reference: new keys are added there first, and TypeScript checks every `t("...")` call against it.
- Use text in components with `const { t } = useTranslation();` then `t("section.key")`.
- Values with variables: `"hello": "Hello {{name}}"` → `t("hello", { name })`.
