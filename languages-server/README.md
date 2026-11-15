# Language server

The files in this folder are what goes on the language server. Any static file
host works (nginx, S3, GitHub Pages...): the app only downloads two kinds of file.

```
<server>/index.json   – the list of languages users can download
<server>/<code>.json  – one file per language, e.g. de.json
```

The server address is `LANGUAGE_SERVER_URL` in `src-tauri/src/languages.rs`.

## index.json

```json
{
  "languages": [
    { "code": "de", "name": "Deutsch", "abbr": "DE", "dir": "ltr", "version": 1 }
  ]
}
```

`code`, `name`, `abbr`, `dir` and `version` must match the `_meta` section of `<code>.json`.

## Publishing a language

1. Translate `src/locales/en.json` (see `src/locales/README.md` for the AI prompt).
2. Put the file here as `<code>.json` and add an entry for it in `index.json`.
3. Upload both files to the server.

## Updating a language

When translations change (for example after new texts are added to `en.json`),
increase `version` both in the file's `_meta` and in `index.json`. Users who
installed the language then see an **Update** button.

Languages built into the app (English, Persian) are not downloaded, so they do
not need to be on the server.
