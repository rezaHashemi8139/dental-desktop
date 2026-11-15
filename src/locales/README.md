# Translations

Each `.json` file is one language and describes itself in its `_meta` section
(code, full name, abbreviation, direction, version). There are two ways to ship one:

- **Built into the app:** put the file in this folder. It is always available and cannot be removed.
- **Downloadable:** put the file on the language server (see `languages-server/README.md`).
  Users download it from *Language → Manage languages...* and can remove it again,
  except for the language they are using.

Any text missing from a file falls back to English, so a partial translation still works.

Text coming from Rust is translated here too: Rust sends a key such as
`greet.message` plus values, never finished text (see `src-tauri/src/message.rs`).

## Adding a language

1. Give `en.json` to an AI with the prompt below (replace the language).
2. Save the result as `<code>.json`, e.g. `de.json`, `ar.json`, `tr.json`,
   in this folder or on the language server.

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
- This is a dental clinic management app: use the standard terms a clinic in that country would use.
```

## For developers

- `en.json` is the reference: new keys are added there first, and TypeScript checks every `t("...")` call against it.
- Use text in components with `const { t } = useTranslation();` then `t("section.key")`.
- Values with variables: `"hello": "Hello {{name}}"` → `t("hello", { name })`.
