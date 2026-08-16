import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const cli = resolve(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
const child = spawn(process.execPath, [cli, "build", "--debug", "--no-bundle"], {
  cwd: root,
  env: { ...process.env, CI: "true" },
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(`Tauri debug build failed to start: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal !== null) {
    console.error(`Tauri debug build terminated by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
