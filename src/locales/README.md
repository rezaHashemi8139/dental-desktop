# Translations

Each `.json` file is one language and describes itself in its `_meta` section
(code, full name, abbreviation, direction, version). There are two ways to ship one:

- **Built into the app:** put the file in this folder. It is always available and cannot be removed.
- **Downloadable:** put the file in the server repository, `dental-server/internal/languages/files/`
  (see the README there). The app gets the list and the file from the server's `LanguageService`;
  users download it from *Language → Manage languages...* and can remove it again,
  except for the language they are using.

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
- This is a clinic management app: use the standard terms a clinic in that country would use.
```

## For developers

- `fa.json` is the reference: new keys are added there first, and TypeScript checks every `t("...")` call against it.
  Add the same keys to the files in `dental-server/internal/languages/files/` and raise their `version`.
- Use text in components with `const { t } = useTranslation();` then `t("section.key")`.
- Values with variables: `"hello": "Hello {{name}}"` → `t("hello", { name })`.
