import { createServer } from "vite";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Real browser preparation measurement only. Never sends Ctrl+P, invokes
// window.print, changes the default printer, or submits any printer job.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = resolve(root, ".internal/evidence/issue-83", new Date().toISOString().replaceAll(":", "-"));
const profile = resolve(evidence, "edge-profile");
await mkdir(profile, { recursive: true });
const allowed = ["fixture-B-blank.pdf", "fixture-F-raster-12.pdf", "fixture-L-text-300.pdf", "print-mixed-rotation-4.pdf"];
const verification = process.argv[2] === "--verify-output";
const outputPath = verification ? resolve(process.argv[4] ?? "") : "";
if (verification && (!allowed.includes(process.argv[3]) || !relative(root, outputPath).replaceAll("\\", "/").startsWith(".internal/evidence/issue-83/native/") || !outputPath.endsWith("output.pdf"))) throw new Error("Only owned native fixture output can be verified");
const fixtures = verification ? [process.argv[3]] : allowed.slice(0, 3);
const shaFile = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const manifest = JSON.parse(await readFile(resolve(root, "fixtures/manifest.json"), "utf8"));
const hash = async (name) => createHash("sha256").update(await readFile(resolve(root, "fixtures/pdf", name))).digest("hex");
const hashes = Object.fromEntries(await Promise.all(fixtures.map(async (name) => [name, await hash(name)])));
for (const name of fixtures) {
  if (manifest.files.find((entry) => entry.name === name)?.sha256 !== hashes[name]) throw new Error(`Fixture hash mismatch: ${name}`);
}
const server = await createServer({ configFile: false, root, cacheDir: resolve(evidence, "vite-cache"),
  server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, watch: null },
  plugins: [{ name: "print-probe-entry", configureServer(vite) {
    vite.middlewares.use((req, res, next) => {
      if (req.url !== "/__print-candidate") { next(); return; }
      res.setHeader("Content-Type", "text/html");
      res.end('<!doctype html><html><head><title>Non-printing fixture probe</title></head><body></body></html>');
    });
  } }],
});
let browser;
let socket;
const pending = new Map();
let sequence = 0;
let browserError;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = async (operation, milliseconds, message) => {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
};
const call = (method, params = {}) => deadline(new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
}), 120_000, `CDP timeout: ${method}`);
try {
  await server.listen();
  const address = server.httpServer.address();
  const url = `http://127.0.0.1:${address.port}/__print-candidate`;
  const executable = process.env.PRINT_PROBE_EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
  browser = spawn(executable, ["--headless=new", "--no-first-run", "--disable-extensions", "--disable-background-networking",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  browser.on("error", (error) => { browserError = error; });
  let port;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (browserError) throw browserError;
    if (browser.exitCode !== null) throw new Error("Probe browser exited before DevTools opened");
    try { port = Number((await readFile(resolve(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; }
    catch { await delay(100); }
  }
  if (!port) throw new Error("Probe browser DevTools port unavailable");
  const endpoint = `http://127.0.0.1:${port}`;
  const version = await (await fetch(`${endpoint}/json/version`)).json();
  const pages = await (await fetch(`${endpoint}/json/list`)).json();
  const page = pages.find((entry) => entry.type === "page");
  if (!page) throw new Error("Probe browser page unavailable");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await deadline(new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; }), 10_000, "CDP connection timeout");
  socket.onclose = () => {
    for (const request of pending.values()) request.reject(new Error("Probe browser disconnected"));
    pending.clear();
  };
  socket.onmessage = (event) => {
    const value = JSON.parse(event.data);
    const request = pending.get(value.id);
    if (request) { pending.delete(value.id); if (value.error) request.reject(new Error(JSON.stringify(value.error))); else request.resolve(value.result); }
  };
  await call("Page.enable");
  await call("Page.navigate", { url });
  // Wait for navigation, not a fixed preparation delay.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await call("Runtime.evaluate", { expression: "({url:location.href,ready:document.readyState})", returnByValue: true });
    if (state.result?.value?.url === url && state.result.value.ready === "complete") break;
    if (attempt === 99) throw new Error("Probe page navigation timeout");
    await delay(100);
  }
  const result = [];
  for (const fixture of fixtures) {
    const started = await call("Runtime.evaluate", {
      expression: `(() => { window.printCandidateOutcome = null; window.printCandidateProgress = null; return import(${JSON.stringify(verification ? '/tools/qa/print-output-verification.ts' : '/tools/qa/print-candidate.ts')}).then(module => { void ${verification ? `module.verify(${JSON.stringify(fixture)}, ${JSON.stringify('/' + relative(root, outputPath).replaceAll('\\', '/'))})` : `module.measure(${JSON.stringify(fixture)})`}.then(value => { window.printCandidateOutcome = { value }; }, error => { window.printCandidateOutcome = { error: String(error) }; }); }); })()`,
      awaitPromise: true, returnByValue: true,
    });
    if (started.exceptionDetails) throw new Error(JSON.stringify(started.exceptionDetails));
    let measurement;
    let lastProgress = "";
    const measurementDeadline = Date.now() + 600_000;
    while (Date.now() < measurementDeadline) {
      const sample = await call("Runtime.evaluate", { expression: "({outcome:window.printCandidateOutcome,progress:window.printCandidateProgress})", returnByValue: true });
      if (sample.exceptionDetails) throw new Error(JSON.stringify(sample.exceptionDetails));
      const state = sample.result.value;
      if (state.outcome?.error) throw new Error(state.outcome.error);
      if (state.outcome?.value) { measurement = state.outcome.value; break; }
      if (state.progress) {
        const key = `${state.progress.repetition}:${Math.floor(state.progress.preparedPages / 25)}`;
        if (key !== lastProgress) { console.log(JSON.stringify(state.progress)); lastProgress = key; }
      }
      await delay(1000);
    }
    if (!measurement) throw new Error(`Measurement did not complete: ${fixture}`);
    if (await hash(fixture) !== hashes[fixture]) throw new Error("Fixture changed during measurement");
    await writeFile(resolve(evidence, `${fixture}.json`), JSON.stringify({ fixture, sourceSha256: hashes[fixture], browser: version.Browser, measurement }, null, 2));
    result.push(measurement);
    if (!verification) console.log(JSON.stringify({ fixture, runs: measurement.runs.map((run) => ({
      cache: run.cache, startCallbackMs: run.startCallbackMs, consumerFinishedMs: run.consumerFinishedMs, deliveredPages: run.deliveredPages.length,
      firstPage: run.deliveredPages[0], lastPage: run.deliveredPages.at(-1), peakPagePayloadBytes: run.peakPagePayloadBytes,
    })) }));
  }
  const afterHashes = Object.fromEntries(await Promise.all(fixtures.map(async (name) => [name, await hash(name)])));
  if (JSON.stringify(hashes) !== JSON.stringify(afterHashes)) throw new Error("Fixture changed during probe");
  const output = { kind: verification ? "native-output-browser-pixel-verification" : "browser-only-real-render-non-native-consumer-candidate", recordedAt: new Date().toISOString(),
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    diff: execFileSync("git", ["diff", "--", "src/pdf/PdfPrintService.ts"], { cwd: root, encoding: "utf8" }),
    browser: version.Browser, node: process.version, sourceHashesBefore: hashes, sourceHashesAfter: afterHashes,
    limitations: ["Not packaged Windows evidence", "No action-to-feedback paint measurement", "Invocation callback is not native dialog display",
      "No actual native output", "No measured decoded image or process memory", "Fresh PDF pages are not OS-cold cache"], result };
  if (verification) {
    output.outputSha256 = await shaFile(outputPath);
    output.limitations = ["Checks actual Microsoft Print to PDF output against fixed source pixel templates", "Does not invoke a printer or certify OS keyboard delivery"];
    await writeFile(resolve(dirname(outputPath), "output-verification.json"), JSON.stringify(output, null, 2));
  }
  await writeFile(resolve(evidence, "candidate.json"), `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Evidence: ${resolve(evidence, "candidate.json")}`);
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    try { await deadline(call("Browser.close"), 5000, "Browser close timeout"); } catch { /* owned process fallback below */ }
    socket.close();
  }
  if (browser && browser.exitCode === null) {
    try { await deadline(new Promise((resolve) => browser.once("exit", resolve)), 5000, "Owned browser exit timeout"); }
    catch { execFileSync("taskkill", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore" }); }
  }
  await server.close();
}
