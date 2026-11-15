// Asks for the next app version, saves it in the project, builds the app and
// copies the installers into <root>/build.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

const { version: currentVersion } = JSON.parse(readFileSync(path.join(tauriDir, "tauri.conf.json"), "utf8"));
console.log(`Current version: ${currentVersion}\nPress Enter to accept the value in brackets.\n`);
const version = await askVersion(currentVersion.split(".").map(Number));
rl.close();

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

const { status } = spawnSync("pnpm exec tauri build", { cwd: root, stdio: "inherit", shell: true });
if (status !== 0) fail("Build failed.", status ?? 1);

const installers = findInstallers(version);
if (installers.length === 0) fail(`No installers found for version ${version} in ${bundleDir}.`);

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir);

console.log("");
for (const installer of installers) {
  const destination = path.join(outputDir, `${INSTALLER_NAME}${path.extname(installer)}`);
  copyFileSync(installer, destination);
  console.log(`Installer: ${destination}`);
}
console.log(`Version ${version} is saved. Commit the changed version files.`);
