// Starts `tauri dev` so that only the app window can open the dev server.
//
// A random key is made for this run and passed to Vite (env DEV_ACCESS_KEY).
// The app window opens the dev URL with that key once; Vite then sets a cookie
// and refuses every request without it (see vite.config.ts). A browser opening
// http://localhost:1424 gets 403. Release builds have no dev server and no port.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const conf = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));

const key = randomBytes(32).toString("hex");
const devUrl = new URL(conf.build.devUrl);
devUrl.searchParams.set("dev-key", key);

// `--config` is merged into tauri.conf.json; arrays are replaced, so repeat every window.
const windows = conf.app.windows.map((window, index) => (index === 0 ? { ...window, url: devUrl.href } : window));

const dir = mkdtempSync(path.join(tmpdir(), "dental-dev-"));
const overrides = path.join(dir, "tauri.dev.json");
writeFileSync(overrides, JSON.stringify({ app: { windows } }));

const extraArgs = process.argv.slice(2).join(" ");
const { status } = spawnSync(`pnpm exec tauri dev --config "${overrides}" ${extraArgs}`, {
  cwd: root,
  stdio: "inherit",
  shell: true,
  env: { ...process.env, DEV_ACCESS_KEY: key },
});

rmSync(dir, { recursive: true, force: true });
process.exit(status ?? 1);
