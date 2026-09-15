import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Browser ImageDecoder avoids the slow software-only Node PDF image path.
// The shared runner validates fixture/output paths, hashes and owned cleanup.
const child = spawn(process.execPath, [fileURLToPath(new URL("./run-print-candidate.mjs", import.meta.url)),
  "--verify-output", ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
child.once("error", (error) => { console.error(error); process.exitCode = 1; });
child.once("exit", (code, signal) => { process.exitCode = signal === null ? code ?? 1 : 1; });
