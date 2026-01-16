import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// scripts/ -> project root is one level up
const projectDir = path.resolve(__dirname, ".."); // .../apps/desktop/jobhunt
const srcTauriDir = path.join(projectDir, "src-tauri");
const engineDir = path.resolve(projectDir, "..", "..", "..", "engine");

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

function run(cmd, args, cwd) {
  console.log(`[dev-tauri] cwd=${cwd}`);
  console.log(`[dev-tauri] ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// 1) Build engine from module directory
const outExe = path.join(srcTauriDir, "bin", "engine-x86_64-pc-windows-msvc.exe");
run("go", ["build", "-o", outExe, "./cmd/engine"], engineDir);

// 2) Run tauri dev using local cli via npx, from project directory
run("npx", ["tauri", "dev"], projectDir);

