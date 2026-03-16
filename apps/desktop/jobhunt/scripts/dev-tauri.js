import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const projectDir  = path.resolve(__dirname, "..");           // .../apps/desktop/jobhunt
const srcTauriDir = path.join(projectDir, "src-tauri");
const engineDir   = path.resolve(projectDir, "..", "..", "..", "engine");
const fillerSrc   = path.resolve(projectDir, "..", "..", "..", "filler"); // repo root /filler

function assertExists(p) {
  if (!fs.existsSync(p)) {
    console.error(`[dev-tauri] Missing: ${p}`);
    process.exit(1);
  }
}

assertExists(projectDir);
assertExists(srcTauriDir);
assertExists(path.join(srcTauriDir, "tauri.conf.json"));
assertExists(engineDir);
assertExists(path.join(engineDir, "go.mod"));
assertExists(fillerSrc);
assertExists(path.join(fillerSrc, "filler.js"));
assertExists(path.join(fillerSrc, "package.json"));

function run(cmd, args, cwd) {
  console.log(`[dev-tauri] cwd=${cwd}`);
  console.log(`[dev-tauri] ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// ── 1. Build Go engine ────────────────────────────────────────────────────────
const outExe = path.join(srcTauriDir, "bin", "engine-x86_64-pc-windows-msvc.exe");
run("go", ["build", "-o", outExe, "./cmd/engine"], engineDir);

// ── 2. Install filler dependencies if needed ──────────────────────────────────
const fillerModules = path.join(fillerSrc, "node_modules");
if (!fs.existsSync(fillerModules)) {
  console.log("[dev-tauri] Installing filler npm dependencies…");
  run("npm", ["install"], fillerSrc);
}

// ── 3. Install Playwright Chromium if needed ──────────────────────────────────
const chromiumMarker = path.join(fillerSrc, "node_modules", "playwright-core", ".local-chromium");
if (!fs.existsSync(chromiumMarker)) {
  console.log("[dev-tauri] Installing Playwright Chromium…");
  run("npx", ["playwright", "install", "chromium"], fillerSrc);
}

// ── 4. Stage filler into src-tauri/filler/ ───────────────────────────────────
// Tauri bundles everything under src-tauri/ as a resource.
// We copy filler.js + package.json (NOT node_modules — Playwright bundles its own).
// package.json MUST be present so Node uses "type": "commonjs" and require() works.
const fillerDest = path.join(srcTauriDir, "filler");
fs.mkdirSync(fillerDest, { recursive: true });

const filesToStage = ["filler.js", "package.json"];
for (const file of filesToStage) {
  const src  = path.join(fillerSrc, file);
  const dest = path.join(fillerDest, file);
  fs.copyFileSync(src, dest);
  console.log(`[dev-tauri] staged ${file} → src-tauri/filler/${file}`);
}

// Create a junction (Windows) or symlink to node_modules so Node can resolve
// require('playwright') without copying gigabytes of files on every run.
// A junction works without admin rights on Windows and is instant to create.
const nmSrc  = path.join(fillerSrc, "node_modules");
const nmDest = path.join(fillerDest, "node_modules");

if (!fs.existsSync(nmDest)) {
  try {
    // "junction" works on Windows without elevated privileges
    fs.symlinkSync(nmSrc, nmDest, "junction");
    console.log(`[dev-tauri] linked node_modules → ${nmSrc}`);
  } catch (e) {
    // Fallback: write a small package.json that redirects Node to the source dir
    // by setting NODE_PATH in a .npmrc — but simpler: just note the path
    console.warn(`[dev-tauri] symlink failed (${e.message}), filler may not find playwright`);
    console.warn(`[dev-tauri] Manual fix: copy ${nmSrc} to ${nmDest}`);
  }
} else {
  console.log("[dev-tauri] filler/node_modules already linked, skipping.");
}

// ── 5. Launch tauri dev ───────────────────────────────────────────────────────
run("npx", ["tauri", "dev"], projectDir);