import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectDir  = path.resolve(__dirname, "..");
const srcTauriDir = path.join(projectDir, "src-tauri");
const binDir      = path.join(srcTauriDir, "bin");
const engineDir   = path.resolve(projectDir, "..", "..", "..", "engine");
const fillerSrc   = path.resolve(projectDir, "..", "..", "..", "filler");

// Tauri looks for resources relative to src-tauri, so we stage filler/ there.
// The engine binary looks for filler.js relative to itself via findFillerScript().
const fillerStage = path.join(srcTauriDir, "filler");
const fillerInBin = path.join(binDir, "filler");

function assertExists(p) {
  if (!fs.existsSync(p)) {
    console.error(`[dev-tauri] Missing: ${p}`);
    process.exit(1);
  }
}

assertExists(path.join(srcTauriDir, "tauri.conf.json"));
assertExists(path.join(engineDir, "go.mod"));
assertExists(path.join(fillerSrc, "filler.js"));

function run(cmd, args, cwd) {
  console.log(`[dev-tauri] ${cmd} ${args.join(" ")}  (cwd: ${cwd})`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// Recursively copy src → dest, skipping node_modules
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

fs.mkdirSync(binDir, { recursive: true });

// 1) Build engine sidecar
const engineExe = path.join(binDir, "engine-x86_64-pc-windows-msvc.exe");
console.log("[dev-tauri] Building engine...");
run("go", ["build", "-o", engineExe, "./cmd/engine"], engineDir);

// 2) Install filler node_modules in the SOURCE filler/ directory
if (!fs.existsSync(path.join(fillerSrc, "node_modules"))) {
  console.log("[dev-tauri] Installing filler dependencies...");
  run("npm", ["install"], fillerSrc);
}

// 3) Download Playwright Chromium if not already present
const chromiumMarker = path.join(
  fillerSrc, "node_modules", "playwright-core", ".local-browsers"
);
if (!fs.existsSync(chromiumMarker)) {
  console.log("[dev-tauri] Downloading Playwright Chromium...");
  run("npx", ["playwright", "install", "chromium"], fillerSrc);
}

// 4) Stage filler/ into src-tauri/filler/ (includes node_modules this time
//    so the staged copy is self-contained for the production bundle).
//    Skip if filler.js is already up to date.
const stagedJs = path.join(fillerStage, "filler.js");
const srcJs = path.join(fillerSrc, "filler.js");
const needsUpdate = !fs.existsSync(stagedJs) ||
  fs.statSync(srcJs).mtimeMs > fs.statSync(stagedJs).mtimeMs;

if (needsUpdate) {
  console.log("[dev-tauri] Staging filler/ into src-tauri/filler/ ...");
  if (fs.existsSync(fillerStage)) fs.rmSync(fillerStage, { recursive: true });
  // Full copy including node_modules for production bundle
  function copyDirFull(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isDirectory()) copyDirFull(s, d);
      else fs.copyFileSync(s, d);
    }
  }
  copyDirFull(fillerSrc, fillerStage);
}

// 5) Also make filler accessible from bin/filler so the engine can find it
//    in dev (engine binary is in bin/, findFillerScript looks for bin/filler/filler.js)
if (!fs.existsSync(fillerInBin)) {
  console.log("[dev-tauri] Linking bin/filler -> src-tauri/filler ...");
  try {
    fs.symlinkSync(fillerStage, fillerInBin, "junction");
  } catch {
    // If symlink fails (permissions), do a plain copy
    copyDir(fillerSrc, fillerInBin);
  }
}

// 6) Launch Tauri dev
run("npx", ["tauri", "dev"], projectDir);