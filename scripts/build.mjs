// Asks for the next app version, saves it in the project, builds the app and
// copies the installers into <root>/build.
//
// It also writes <root>/build/update: the signed release for the app's built-in
// updater. Copy that folder's files to the server's UPDATES_DIR to publish it
// (see dental-server/internal/releases). The update is signed with the private key
// in TAURI_SIGNING_PRIVATE_KEY (a path or the key itself), by default
// ~/.tauri/dental-updater.key; its public half is plugins.updater.pubkey in
// src-tauri/tauri.conf.json. Keep the private key safe and backed up: installed
// apps accept only updates signed with it.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const INSTALLER_NAME = "DevOps Assistant";
// MSI product versions cannot go beyond these.
const MAX_MAJOR = 255;
const MAX_MINOR = 255;
const MAX_PATCH = 65535;

const root = path.resolve(import.meta.dirname, "..");
const tauriDir = path.join(root, "src-tauri");
const bundleDir = path.join(tauriDir, "target", "release", "bundle");
const outputDir = path.join(root, "build");
// The release for the updater: what the server's UPDATES_DIR holds.
const updateDir = path.join(outputDir, "update");
const releaseFile = path.join(updateDir, "release.json");
const DEFAULT_SIGNING_KEY = path.join(homedir(), ".tauri", "dental-updater.key");
// Updater platform names (Tauri's {{target}}-{{arch}}).
const UPDATER_ARCH = { x64: "x86_64", arm64: "aarch64", ia32: "i686" };

const jsonVersion = /("version":\s*")[^"]+(")/;
const versionFiles = [
  [path.join(root, "package.json"), jsonVersion],
  [path.join(tauriDir, "tauri.conf.json"), jsonVersion],
  [path.join(tauriDir, "Cargo.toml"), /^(version = ")[^"]+(")/m],
];
const cargoLock = path.join(tauriDir, "Cargo.lock");

const rl = createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();

async function ask(prompt) {
  process.stdout.write(prompt);
  const { value, done } = await lines.next();
  if (done) {
    console.error("\nNo input received, build cancelled.");
    process.exit(1);
  }
  return value.trim();
}

async function askNumber(label, max, fallback) {
  for (;;) {
    const answer = await ask(`${label} [${fallback}]: `);
    if (answer === "") return fallback;
    if (/^\d+$/.test(answer) && Number(answer) <= max) return Number(answer);
    console.error(`${label} must be a whole number from 0 to ${max}.`);
  }
}

function isHigher(next, current) {
  const difference = next.map((part, index) => part - current[index]).find((part) => part !== 0);
  return difference > 0;
}

async function askVersion(current) {
  for (;;) {
    const major = await askNumber("Major", MAX_MAJOR, current[0]);
    const minor = await askNumber("Minor", MAX_MINOR, current[1]);
    const nextPatch = major === current[0] && minor === current[1] ? current[2] + 1 : 0;
    const patch = await askNumber("Patch", MAX_PATCH, nextPatch);
    const next = [major, minor, patch];
    if (isHigher(next, current)) return next.join(".");
    console.error(`Version ${next.join(".")} must be higher than ${current.join(".")}.\n`);
  }
}

function findInstallers(version) {
  return ["msi", "nsis"]
    .map((target) => path.join(bundleDir, target))
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => /\.(msi|exe)$/.test(name) && name.includes(`_${version}_`))
        .map((name) => path.join(dir, name)),
    );
}

async function askYesNo(prompt) {
  for (;;) {
    const answer = (await ask(`${prompt} [y/N]: `)).toLowerCase();
    if (answer === "" || answer === "n" || answer === "no") return false;
    if (answer === "y" || answer === "yes") return true;
  }
}

// Without the private key the updater artifacts cannot be signed: stop before asking anything.
const signingKey = process.env.TAURI_SIGNING_PRIVATE_KEY || (existsSync(DEFAULT_SIGNING_KEY) ? DEFAULT_SIGNING_KEY : "");
if (!signingKey) {
  console.error(
    `No update signing key: set TAURI_SIGNING_PRIVATE_KEY, or put the key at ${DEFAULT_SIGNING_KEY}.\n` +
      "Only the original key works: installed apps reject updates signed with any other.",
  );
  process.exit(1);
}

// The previous release's forced minimum stays in force unless this one raises it.
const previousRelease = existsSync(releaseFile) ? JSON.parse(readFileSync(releaseFile, "utf8")) : null;

const { version: currentVersion } = JSON.parse(readFileSync(path.join(tauriDir, "tauri.conf.json"), "utf8"));
console.log(`Current version: ${currentVersion}\nPress Enter to accept the value in brackets.\n`);
const version = await askVersion(currentVersion.split(".").map(Number));
const forced = await askYesNo("Force this update (older versions stop working until they update)?");
const notes = await ask("Release notes for users (one line, optional): ");
rl.close();
const minimumVersion = forced ? version : (previousRelease?.minimumVersion ?? "");

// A failed build was never released, so its version number stays available.
const originals = [...versionFiles.map(([file]) => file), cargoLock]
  .filter((file) => existsSync(file))
  .map((file) => [file, readFileSync(file)]);

function fail(message, exitCode = 1) {
  for (const [file, content] of originals) writeFileSync(file, content);
  console.error(`${message}\nThe version stays at ${currentVersion}.`);
  process.exit(exitCode);
}

for (const [file, pattern] of versionFiles) {
  writeFileSync(file, readFileSync(file, "utf8").replace(pattern, `$1${version}$2`));
}
console.log(`\nBuilding version ${version}...\n`);

const { status } = spawnSync("pnpm exec tauri build", {
  cwd: root,
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: signingKey,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
  },
});
if (status !== 0) fail("Build failed.", status ?? 1);

const installers = findInstallers(version);
if (installers.length === 0) fail(`No installers found for version ${version} in ${bundleDir}.`);
// The updater installs the NSIS setup (.exe), signed next to it as .exe.sig.
const updateInstaller = installers.find((file) => file.endsWith(".exe") && existsSync(`${file}.sig`));
if (!updateInstaller) fail(`No signed NSIS installer (.exe + .exe.sig) found for version ${version}.`);

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(updateDir, { recursive: true });

console.log("");
for (const installer of installers) {
  const destination = path.join(outputDir, `${INSTALLER_NAME}${path.extname(installer)}`);
  copyFileSync(installer, destination);
  console.log(`Installer: ${destination}`);
}

const updateFile = path.basename(updateInstaller);
copyFileSync(updateInstaller, path.join(updateDir, updateFile));
const platform = `windows-${UPDATER_ARCH[process.arch] ?? process.arch}`;
const release = {
  version,
  minimumVersion,
  notes,
  pubDate: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: { [platform]: { file: updateFile, signature: readFileSync(`${updateInstaller}.sig`, "utf8").trim() } },
};
writeFileSync(releaseFile, JSON.stringify(release, null, 2) + "\n");
console.log(`Update:    ${updateDir} (copy its files to the server's UPDATES_DIR to publish)`);
console.log(
  minimumVersion
    ? `Forced:    versions older than ${minimumVersion} must update before they keep working.`
    : "Forced:    no; users are offered the update.",
);
console.log(`Version ${version} is saved. Commit the changed version files.`);
