// Keeps the server's downloadable languages in line with the built-in Persian file.
//
//   pnpm sync-locales            update the server files
//   pnpm sync-locales --check    only report; exits 1 if anything is out of sync
//
// `src/locales/fa.json` is the reference. In `dental-server/internal/languages/files`:
// - fa.json becomes a copy of it;
// - every other file gets the same keys in the same order: keys Persian no longer
//   has are removed. Missing keys and {{placeholders}} that differ cannot be fixed
//   automatically (they need a translation), so they are reported and the script
//   exits 1.
// The `version` of every file that changes is raised, so installed copies update.
// Pass another folder as the first argument if the server repository is elsewhere.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const check = args.includes("--check");
const serverDir = path.resolve(
  args.find((arg) => !arg.startsWith("--")) ?? path.join(root, "..", "dental-server", "internal", "languages", "files"),
);

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const toText = (value) => JSON.stringify(value, null, 2) + "\n";
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const placeholders = (text) => [...String(text).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort().join(", ");

const { _meta: referenceMeta, ...reference } = readJson(path.join(root, "src", "locales", "fa.json"));

/** Rebuilds `node` with the keys of `ref` in its order; collects what can't be fixed. */
function align(ref, node, prefix, report) {
  const out = {};
  for (const [key, refValue] of Object.entries(ref)) {
    const name = prefix + key;
    const value = isObject(node) ? node[key] : undefined;
    if (value === undefined) {
      report.missing.push(name);
    } else if (isObject(refValue)) {
      out[key] = align(refValue, value, name + ".", report);
    } else {
      if (isObject(value)) report.missing.push(name);
      else {
        out[key] = value;
        if (placeholders(refValue) !== placeholders(value)) report.placeholders.push(name);
      }
    }
  }
  if (isObject(node)) {
    for (const key of Object.keys(node)) if (!(key in ref)) report.removed.push(prefix + key);
  }
  return out;
}

let problems = 0;
let outOfSync = 0;

for (const fileName of readdirSync(serverDir).filter((name) => name.endsWith(".json")).sort()) {
  const file = path.join(serverDir, fileName);
  const before = readFileSync(file, "utf8");
  const { _meta: meta = {}, ...content } = JSON.parse(before);
  const report = { missing: [], placeholders: [], removed: [] };

  const aligned =
    meta.code === referenceMeta.code ? structuredClone(reference) : align(reference, content, "", report);
  const nextMeta =
    meta.code === referenceMeta.code
      ? { ...meta, name: referenceMeta.name, abbr: referenceMeta.abbr, dir: referenceMeta.dir }
      : meta;

  const changed = toText({ _meta: nextMeta, ...aligned }) !== toText({ _meta: meta, ...content });
  const notes = [];
  if (report.removed.length) notes.push(`  removed (not in fa.json): ${report.removed.join(", ")}`);
  if (report.missing.length) notes.push(`  MISSING, translate: ${report.missing.join(", ")}`);
  if (report.placeholders.length) notes.push(`  PLACEHOLDERS differ from fa.json: ${report.placeholders.join(", ")}`);
  problems += report.missing.length + report.placeholders.length;

  if (changed) {
    outOfSync++;
    const version = (Number(meta.version) || 0) + 1;
    if (!check) writeFileSync(file, toText({ _meta: { ...nextMeta, version }, ...aligned }));
    console.log(`${fileName}: ${check ? "out of sync" : `updated, version ${version}`}`);
  } else {
    console.log(`${fileName}: in sync`);
  }
  notes.forEach((note) => console.log(note));
}

if (problems) console.log(`\n${problems} key(s) need a translation; fix them by hand.`);
process.exit(problems || (check && outOfSync) ? 1 : 0);
