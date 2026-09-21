import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Only run against an owned preview:worktree candidate. No desktop input or private shares.
const [pidText, portText = "9333"] = process.argv.slice(2);
const pid = Number(pidText), port = Number(portText);
assert(Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(port) && port > 0 && port < 65536);
const receipt = JSON.parse((await readFile(".internal/preview-target/preview-receipt.json", "utf8")).replace(/^\uFEFF/u, ""));
assert(["standalone-tauri-release-no-bundle", "standalone-tauri-debug-no-bundle"].includes(receipt.kind));
const executable = resolve(".internal/preview-target", receipt.kind.includes("release") ? "release" : "debug", "modeleaf.exe");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).replace(/\r?\n$/u, "");
assert.equal(receipt.source.head, git("rev-parse", "HEAD"));
assert.equal(receipt.branch, git("branch", "--show-current"));
assert.equal(receipt.source.statusSha256, hash(git("status", "--porcelain=v1")));
assert.equal(receipt.source.diffSha256, hash(git("diff", "--binary", "HEAD")));
assert.equal(receipt.executableSha256, hash(await readFile(executable)));
const processPath = execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).Path`], { encoding: "utf8", timeout: 30000 }).trim();
assert.equal(processPath.toLowerCase(), executable.toLowerCase());
const evidence = resolve(".internal/evidence/pdf-failure-native", new Date().toISOString().replaceAll(":", "-"));
await mkdir(evidence, { recursive: true });
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((item) => item.type === "page" && item.url.startsWith("http://tauri.localhost"));
assert(target, "Owned WebView target unavailable");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id); clearTimeout(entry.timer);
  if (message.error) entry.reject(new Error("CDP command failed")); else entry.done(message.result);
};
socket.onclose = () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("WebView disconnected")); } pending.clear(); };
function call(method, params = {}) {
  return new Promise((done, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP timeout")); }, 10000);
    pending.set(id, { done, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  assert(!result.exceptionDetails, "WebView evaluation failed");
  return result.result.value;
}
async function wait(check, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise((done) => setTimeout(done, 100)); }
  throw new Error(`Timed out: ${label}`);
}
assert(process.env.LOCALAPPDATA, "Local app data unavailable");
const logs = join(process.env.LOCALAPPDATA, "com.dsargus.modeleaf", "diagnostics");
async function hasObservation(start, code) {
  for (const name of ["diagnostics.jsonl", "diagnostics.jsonl.1", "diagnostics.jsonl.2"]) {
    let text;
    try { text = await readFile(join(logs, name), "utf8"); } catch (error) { if (error.code === "ENOENT") continue; throw new Error("Diagnostic log read failed"); }
    for (const line of text.split(/\r?\n/u).filter(Boolean)) {
      let event; try { event = JSON.parse(line); } catch { throw new Error("Diagnostic log JSON invalid"); }
      if (event.epochMs >= start && event.event === "PDF_RENDER" && event.rendererCode === code) {
        assert.equal(event.stage, undefined); assert.equal(event.osCode, undefined);
        return true;
      }
    }
  }
  return false;
}
const results = [];
try {
  assert.equal(await evaluate(`window.__TAURI_INTERNALS__.invoke('report_pdf_failure',{failure:{code:'PDF_LOAD',osCode:5}}).then(()=>false,()=>true)`), true, "renderer cannot forge native evidence");
  results.push({ case: "renderer-provenance", passed: true });
  for (const [id, length] of [["small-invalid", 128], ["large-invalid", 2 * 1048576 + 1]]) {
    const bytes = Buffer.alloc(length, 32);
    bytes.write("%PDF-1.7\nnot a valid PDF structure\n");
    const fixture = join(evidence, `${id}.pdf`);
    await writeFile(fixture, bytes, { flag: "wx" });
    const start = Date.now();
    execFileSync(executable, [fixture], { timeout: 15000 });
    await wait(() => evaluate(`document.querySelector('.status-message')?.textContent.includes('[PDF_LOAD_INVALID]')`), `${id} visible code`);
    await wait(() => hasObservation(start, "PDF_LOAD_INVALID"), `${id} native log`);
    assert.equal(hash(await readFile(fixture)), hash(bytes), "source bytes changed");
    results.push({ case: id, length, sha256: hash(bytes), code: "PDF_LOAD_INVALID", logObserved: true, sourceUnchanged: true });
  }
  await writeFile(join(evidence, "result.json"), JSON.stringify({ passed: true, receipt, results, limitations: ["Synthetic malformed PDFs, not private SMB evidence", "No diagnostic durability guarantee", "Owned preview left open for its parent to close"] }, null, 2));
  console.log(JSON.stringify({ passed: true, scenarios: results.length, evidence, ownedPreviewLeftOpen: pid }));
} finally { socket.close(); }
