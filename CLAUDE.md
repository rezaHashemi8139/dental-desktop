# CLAUDE.md

## Project Consistency & English-Only Codebase

### Project architecture and coding style

- The entire project must follow a unified and consistent architecture.
- Maintain the same folder structure, naming conventions, coding patterns, and architectural principles
  across all modules (`src`, `src-tauri`, and the sibling `dental-server` repository).
- Follow the existing coding style throughout the project.
- Before implementing anything, inspect existing implementations and follow their conventions.
- Do not introduce alternative patterns or inconsistent approaches without explicit approval.
- Reuse existing components, utilities, services, hooks, and shared logic whenever possible
  (e.g. `src/components/ui`, `src/i18n`, `useFormatMoney()`, `<MoneyInput>`).

### Dependency installation approval

- Always ask for explicit approval before installing any new package, library, framework, or development tool
  (pnpm packages, Rust crates, Go modules alike).
- Never install, upgrade, replace, or remove dependencies without permission.
- When asking, explain why the dependency is necessary and why existing project resources are insufficient.
- Always prefer existing libraries and built-in project capabilities.

### English-only project content

**All written content inside the project must be in English.** This applies to:

- Source code comments.
- Variable, function, class, and file names.
- UI labels and descriptions.
- Error messages and validation messages.
- Logs and debugging messages.
- Documentation and README files.
- Tests.
- Commit messages and other developer-facing text.
- Any other written content added to the codebase.

Do not introduce Persian or any other non-English language directly into source code, comments, documentation,
or project interfaces.

### Important localization distinction

- The project's source code, documentation, and developer-facing content must remain English-only.
- The application must still support all languages configured in its existing localization system.
- User-facing translations must be stored in the appropriate localization resources, and only there:
  `src/locales/*.json` and `../dental-server/internal/languages/files/*.json`, whose values are written in each
  file's own language. Code refers to them through English keys such as `t("settings.title")`.
- Whenever new Persian translations are required, provide equivalent translations for every currently supported
  language.
- Follow the existing frontend and backend localization architecture (see the section below).

**Final rule:** one unified architecture, one consistent coding style, English-only source and documentation,
approval before every new dependency, and complete multilingual support through the existing localization system.

## Localization & Multi-Language Support

Whenever adding new Persian (Farsi) text, labels, messages, descriptions, notifications, validation errors,
or any other user-facing content:

1. Add the corresponding translations for **all languages currently supported by the project**.
2. Make sure translations are added to the server-side localization files as well.
3. Never add Persian-only text while leaving other supported languages incomplete.
4. Follow the existing localization architecture, translation keys, naming conventions, and file structure.
5. Reuse the existing translation mechanism (i18next / react-i18next) instead of introducing a new localization library.
6. Keep translation keys consistent across all supported languages.
7. Do not hardcode user-facing text in components, Rust code, API responses, or backend logic.
8. Before finishing, verify that every newly added key exists in every supported language, on both the desktop
   app and the server.

**General rule:** every new Persian text must have equivalent translations in all existing supported languages,
including the server-side language files.

**Always inspect the existing languages before making changes; do not assume which ones exist.**
List both folders below each time.

### How it works in this project

- **Reference file:** [src/locales/fa.json](src/locales/fa.json). It is the only built-in language; new keys are
  added here first. TypeScript checks every `t("...")` call against it.
- **Server-side languages:** `../dental-server/internal/languages/files/*.json` (a separate repository next to
  this one). Every file there except `fa.json` needs a real translation of each new key.
- **Rust (`src-tauri`)** never sends finished text: it sends a key plus values (see
  [src-tauri/src/message.rs](src-tauri/src/message.rs)), so its text also lives in the locale files.
- **dental-server** never sends finished text either: errors carry a stable reason code
  (`internal/service/common.go`). A new reason needs a matching translated key in the locale files.
- Keep `{{placeholders}}` identical across languages, and keep keys in the same order as `fa.json`.
- Full details: [src/locales/README.md](src/locales/README.md).

### Checklist when adding text

1. Add the key and Persian text to `src/locales/fa.json`.
2. Add the translated value under the same key to every other file in
   `../dental-server/internal/languages/files/`.
3. Run `pnpm sync-locales`: it copies `fa.json` to the server, aligns key order, removes stale keys and raises
   `version` on changed files so installed copies update.
4. Run `pnpm sync-locales --check` and confirm it exits 0 (no missing keys, no placeholder mismatches).
