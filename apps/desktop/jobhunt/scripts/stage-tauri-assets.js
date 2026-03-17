import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectDir = path.resolve(__dirname, ".."); // apps/desktop/jobhunt
const srcTauriDir = path.join(projectDir, "src-tauri");

const repoRoot = path.resolve(projectDir, "..", "..", "..");
const fillerSrc = path.join(repoRoot, "filler");
const extensionSrc = path.join(repoRoot, "extension");

const fillerDest = path.join(srcTauriDir, "filler");
const extensionDest = path.join(srcTauriDir, "extension");

function assertExists(p, label = p) {
  if (!fs.existsSync(p)) {
    console.error(`[stage-tauri-assets] Missing ${label}: ${p}`);
    process.exit(1);
  }
}

function run(cmd, args, cwd) {
  console.log(`[stage-tauri-assets] cwd=${cwd}`);
  console.log(`[stage-tauri-assets] ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    shell: true,
  });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

function ensureDirClean(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
}

function copyDirContents(srcDir, destDir) {
  ensureDirClean(destDir);

  for (const entry of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, entry);
    const dest = path.join(destDir, entry);

    if (fs.statSync(src).isDirectory()) {
      fs.cpSync(src, dest, { recursive: true });
    } else {
      fs.copyFileSync(src, dest);
    }

    console.log(`[stage-tauri-assets] staged ${src} -> ${dest}`);
  }
}

function stageFiller() {
  assertExists(fillerSrc, "filler source directory");
  assertExists(path.join(fillerSrc, "filler.js"), "filler.js");
  assertExists(path.join(fillerSrc, "package.json"), "filler package.json");

  const fillerModules = path.join(fillerSrc, "node_modules");
  if (!fs.existsSync(fillerModules)) {
    console.log("[stage-tauri-assets] Installing filler npm dependencies...");
    run("npm", ["install"], fillerSrc);
  }

  const chromiumMarker = path.join(
    fillerSrc,
    "node_modules",
    "playwright-core",
    ".local-chromium",
  );
  if (!fs.existsSync(chromiumMarker)) {
    console.log("[stage-tauri-assets] Installing Playwright Chromium...");
    run("npx", ["playwright", "install", "chromium"], fillerSrc);
  }

  ensureDirClean(fillerDest);

  for (const file of ["filler.js", "package.json"]) {
    const src = path.join(fillerSrc, file);
    const dest = path.join(fillerDest, file);
    fs.copyFileSync(src, dest);
    console.log(`[stage-tauri-assets] staged ${src} -> ${dest}`);
  }

  const nmSrc = path.join(fillerSrc, "node_modules");
  const nmDest = path.join(fillerDest, "node_modules");

  try {
    fs.symlinkSync(nmSrc, nmDest, "junction");
    console.log(`[stage-tauri-assets] linked ${nmDest} -> ${nmSrc}`);
  } catch (e) {
    console.warn(
      `[stage-tauri-assets] node_modules link failed (${e.message}), copying instead...`,
    );
    fs.cpSync(nmSrc, nmDest, { recursive: true });
    console.log(`[stage-tauri-assets] copied ${nmSrc} -> ${nmDest}`);
  }
}

function stageExtension() {
  assertExists(extensionSrc, "extension source directory");
  assertExists(path.join(extensionSrc, "manifest.json"), "extension manifest.json");
  copyDirContents(extensionSrc, extensionDest);
}

assertExists(projectDir, "project directory");
assertExists(srcTauriDir, "src-tauri directory");
assertExists(path.join(srcTauriDir, "tauri.conf.json"), "tauri.conf.json");

stageFiller();
stageExtension();

console.log("[stage-tauri-assets] Done.");