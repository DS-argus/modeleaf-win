import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = process.argv[2] ?? "fixture-B-blank.pdf";
const mode = process.argv[3] ?? "cancel";
if (!["fixture-B-blank.pdf", "fixture-F-raster-12.pdf", "fixture-L-text-300.pdf", "print-mixed-rotation-4.pdf"].includes(fixture)
  || !["cancel", "print", "save-cancel", "reopen"].includes(mode)) throw new Error("Only committed print fixtures and cancel/print modes are allowed");
const inputMethod = process.argv[4] ?? "native";
if (!["native", "cdp"].includes(inputMethod)) throw new Error("Input method must be native or cdp; no automatic fallback");
const exe = resolve(process.env.PRINT_QA_EXE ?? resolve(root, "src-tauri/target/debug/modeleaf.exe"));
if (!exe.toLowerCase().startsWith(`${root.toLowerCase()}\\`) && !exe.toLowerCase().startsWith(`${root.toLowerCase()}/`)) throw new Error("Executable must be in this worktree");
const executableBytes = await readFile(exe);
if (!executableBytes.includes(Buffer.from("com.dsargus.modeleaf.print83qa"))) throw new Error("QA identifier not found; refusing to launch into another worktree's single-instance authority");
const evidence = resolve(root, ".internal/evidence/issue-83/native", `${new Date().toISOString().replaceAll(":", "-")}-${mode}-${fixture}`);
await mkdir(evidence, { recursive: true });
const source = resolve(root, "fixtures/pdf", fixture);
const sha = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const sourceBefore = await sha(source);
const manifest = JSON.parse(await readFile(resolve(root, "fixtures/manifest.json"), "utf8"));
if (manifest.files.find((entry) => entry.name === fixture)?.sha256 !== sourceBefore) throw new Error("Fixture manifest hash mismatch");
const listener = createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const child = spawn(exe, [source], { cwd: root, env: { ...process.env,
  WEBVIEW2_USER_DATA_FOLDER: resolve(evidence, "webview-profile"),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --force-renderer-accessibility`,
}, stdio: "ignore" });
let spawnError;
child.on("error", (error) => { spawnError = error; });
let socket;
let sequence = 0;
const pending = new Map();
const events = [];
const start = performance.now();
const note = (event, details = {}) => { const value = { event, elapsedMs: performance.now() - start, ...details }; events.push(value); console.log(JSON.stringify(value)); };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(operation, seconds, label) {
  const deadline = performance.now() + seconds * 1000;
  while (performance.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Owned application exited: ${child.exitCode}`);
    const result = await operation();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
  pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
  socket.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}
async function ui(action, output) {
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve(root, "tools/windows/print-ui.ps1"),
    "-OwnedProcessId", String(child.pid), "-Action", action];
  if (output) args.push("-OutputPath", output);
  const { stdout } = await exec("powershell", args, { cwd: root, timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(stdout.trim());
}
const snapshotExpression = `({status:document.querySelector('#status')?.textContent,
  tab:document.querySelector('.workspace-tab[aria-selected="true"]')?.textContent,
  page:document.querySelector('.pdf-page-frame[data-active-page="true"]')?.dataset.page,
  canvas:Array.from(document.querySelectorAll('.pdf-page')).map(c=>({page:c.dataset.page,scale:c.dataset.scale,rotation:c.dataset.rotation})),
  scroll:document.querySelector('.tab-host:not([hidden])')?.scrollTop,
  search:document.querySelector('#search-input')?.value,
  progressHidden:document.querySelector('.print-progress')?.hidden,
  focused:document.activeElement?.id})`;
let before;
let after;
let trace;
let failure;
let version;
const memory = [];
let sampling = false;
let sampler;
let sampleInFlight;
try {
  note("launched", { pid: child.pid, fixture, mode });
  const target = await until(async () => {
    try { const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
      return targets.find((target) => target.type === "page" && target.url.startsWith("http://tauri.localhost"));
    } catch { return undefined; }
  }, 40, "packaged WebView2 target");
  version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = (event) => { const message = JSON.parse(event.data); const request = pending.get(message.id);
    if (request) { pending.delete(message.id); if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result); } };
  socket.onclose = () => { for (const request of pending.values()) request.reject(new Error("Owned WebView2 disconnected")); pending.clear(); };
  await until(() => evaluate("!!document.querySelector('.pdf-page')?.width && !document.querySelector('.tab-host:not([hidden])')?.hidden"), 40, "fixture reader presentation");
  await evaluate(`(() => {
    window.printProbeTrace=[];
    const original=window.fetch;
    let lastPhase;
    window.fetch=async function(input,options){
      const url=new URL(typeof input==='string'?input:input.url,location.href);
      const command=decodeURIComponent(url.pathname.slice(1));
      if(url.hostname!=='ipc.localhost'||!command.includes('pdf_print')) return original.call(this,input,options);
      const entry={command,startMs:performance.now()};
      if(command==='submit_pdf_print_page'&&ArrayBuffer.isView(options?.body)) {
        const body=options.body,h=new DataView(body.buffer,body.byteOffset,32);
        entry.page=h.getUint32(4,true);entry.bytes=body.byteLength;
      }
      try {
        const response=await original.call(this,input,options);entry.endMs=performance.now();
        try {const text=await response.clone().text();const value=text?JSON.parse(text):null;
          if(response.headers.get('Tauri-Response')==='ok')entry.result=value;else entry.error=value;
        }catch(error){entry.observationError=String(error);}
        if(command!=='poll_pdf_print'||entry.result?.phase!==lastPhase||entry.error){window.printProbeTrace.push(entry);lastPhase=entry.result?.phase;}
        return response;
      }catch(error){entry.endMs=performance.now();entry.error=String(error);window.printProbeTrace.push(entry);throw error;}
    };
    if(window.fetch===original)throw new Error('FETCH_INSTRUMENTATION_UNAVAILABLE');
    const progress=document.querySelector('.print-progress');
    new MutationObserver(()=>{if(!progress.hidden&&!window.firstPrintFeedback){window.firstPrintFeedback={at:performance.now(),text:progress.textContent};}})
      .observe(progress,{subtree:true,childList:true,attributes:true,characterData:true});
    document.querySelector('.tab-host:not([hidden])').focus();
  })()`);
  const expectedPages = manifest.files.find((entry) => entry.name === fixture).pages;
  if (expectedPages > 1) {
    const key = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
      await call("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode, modifiers });
      await call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode, modifiers });
    };
    await key("G", "KeyG", 71, 8);
    await until(() => evaluate(`document.querySelector('.pdf-page-frame[data-active-page="true"]')?.dataset.page === ${JSON.stringify(String(expectedPages))}`), 30, "nondefault reader page");
    await key("]", "BracketRight", 221);
    await until(() => evaluate("document.querySelector('.pdf-page-frame[data-active-page=\"true\"] canvas')?.dataset.rotation === '90'"), 30, "reader rotation setup");
    const priorScale = await evaluate("Number(document.querySelector('.pdf-page-frame[data-active-page=\"true\"] canvas')?.dataset.scale)");
    await key("=", "Equal", 187);
    await until(() => evaluate(`Number(document.querySelector('.pdf-page-frame[data-active-page="true"] canvas')?.dataset.scale) > ${priorScale}`), 30, "reader zoom setup");
    note("nondefault-reader-state-prepared");
  }
  before = await evaluate(snapshotExpression);
  memory.push(await ui("Memory"));
  sampler = setInterval(() => { if (sampling) return; sampling = true;
    sampleInFlight = ui("Memory").then((sample) => memory.push(sample), (error) => note("memory-sample-error", { error: error.message }))
      .finally(() => { sampling = false; });
  }, 1000);
  if (inputMethod === "native") {
    note("native-ctrl-p-sent", await ui("CtrlP"));
  } else {
    await call("Input.dispatchKeyEvent", { type: "keyDown", key: "p", code: "KeyP", windowsVirtualKeyCode: 80, modifiers: 2 });
    await call("Input.dispatchKeyEvent", { type: "keyUp", key: "p", code: "KeyP", windowsVirtualKeyCode: 80, modifiers: 2 });
    note("webview2-ctrl-p-delivered", { limitation: "Browser-delivered trusted key event; not OS foreground-keyboard proof" });
  }
  const dialog = await until(async () => {
    const nodes = await ui("Inspect");
    return nodes.some((node) => (node.type === "ControlType.Button" || node.type === "ControlType.Window") && /^(Print|인쇄)(\s*\([A-Za-z]\))?$/.test(node.name)) ? nodes : undefined;
  }, 30, "actual native print dialog");
  note("native-dialog-observed");
  await writeFile(resolve(evidence, "dialog-uia.json"), JSON.stringify(dialog, null, 2));
  if (mode === "cancel" || mode === "reopen") {
    await ui("Cancel");
    note("native-dialog-cancelled");
  } else {
    note("printer-selection", await ui("SelectPdf"));
    const printInvocation = ui("Print");
    // Some native providers keep Invoke pending while another modal window is
    // active. Observe and fill only the owned save dialog independently.
    printInvocation.catch(() => undefined);
    const saveWaitStarted = Date.now();
    const saveNodes = await until(async () => {
      const state = await ui("SaveReady");
      await writeFile(resolve(evidence, "last-save-controls.json"), JSON.stringify(state, null, 2));
      if (!state.ready && state.controls.length > 0 && Date.now() - saveWaitStarted > 5000) throw new Error("Native filename control needs identification; see last-save-controls.json");
      return state.ready ? state : undefined;
    }, 60, "Microsoft Print to PDF save dialog");
    await writeFile(resolve(evidence, "save-controls.json"), JSON.stringify(saveNodes, null, 2));
    note("native-save-dialog-observed");
    const output = resolve(evidence, "output.pdf");
    if (mode === "save-cancel") await ui("Cancel");
    else await ui("Save", output);
    await printInvocation;
    note(mode === "save-cancel" ? "native-save-cancelled" : "native-output-path-confirmed");
  }
  await until(() => evaluate("window.printProbeTrace.some(e=>e.command==='release_pdf_print'&&!e.error)"), 600, "native worker settlement and release");
  if (mode === "reopen") {
    await call("Input.dispatchKeyEvent", { type: "keyDown", key: "p", code: "KeyP", windowsVirtualKeyCode: 80, modifiers: 2 });
    await call("Input.dispatchKeyEvent", { type: "keyUp", key: "p", code: "KeyP", windowsVirtualKeyCode: 80, modifiers: 2 });
    await until(async () => { const windows = await ui("Windows"); return windows.some((entry) => entry.windowClass === "#32770" && entry.visible && entry.enabled); }, 30, "reopened system dialog");
    await ui("Cancel");
    await until(() => evaluate("window.printProbeTrace.filter(e=>e.command==='release_pdf_print'&&!e.error).length===2"), 30, "second native cancellation release");
    const ids = await evaluate("window.printProbeTrace.filter(e=>e.command==='start_pdf_print').map(e=>e.result.jobId)");
    if (ids.length !== 2 || new Set(ids).size !== 2) throw new Error("Print reopen did not acquire a fresh job");
    note("native-cancel-reopen-verified");
  }
  trace = await evaluate("({calls:window.printProbeTrace,firstFeedback:window.firstPrintFeedback,timeOrigin:performance.timeOrigin})");
  after = await evaluate(snapshotExpression);
  memory.push(await ui("Memory"));
  await ui("Screenshot", resolve(evidence, "reader-after.png"));
  const terminal = trace.calls.findLast((entry) => entry.result?.phase && ["submitted", "cancelled", "failed"].includes(entry.result.phase))?.result;
  if (terminal?.phase !== (mode === "print" ? "submitted" : "cancelled")) throw new Error(`Unexpected native terminal state: ${JSON.stringify(terminal)}`);
  if (mode === "print") {
    const output = resolve(evidence, "output.pdf");
    const metadata = await stat(output);
    if (metadata.size === 0) throw new Error("Native output is empty");
    note("native-output-created", { bytes: metadata.size, sha256: await sha(output) });
  }
  const sourceAfter = await sha(source);
  if (sourceAfter !== sourceBefore) throw new Error("SOURCE_PDF_CHANGED");
  if (before.tab !== after.tab || before.page !== after.page || before.scroll !== after.scroll
    || before.search !== after.search || JSON.stringify(before.canvas) !== JSON.stringify(after.canvas)) throw new Error("READER_STATE_CHANGED");
  if (!after.progressHidden) throw new Error("PRINT_UI_NOT_RELEASED");
  note("source-and-reader-state-preserved");
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  note("failed", { error: failure });
  if (socket?.readyState === WebSocket.OPEN) {
    try { trace = await evaluate("({calls:window.printProbeTrace,firstFeedback:window.firstPrintFeedback})"); } catch { /* preserve original failure */ }
  }
  if (socket?.readyState === WebSocket.OPEN) {
    try { note("native-command-responsiveness", { responsive: await evaluate("Promise.race([window.__TAURI_INTERNALS__.invoke('read_config').then(()=>true,()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),2000))])") }); } catch { /* original failure retained */ }
  }
  try { await writeFile(resolve(evidence, "failure-windows.json"), JSON.stringify(await ui("Windows"), null, 2)); } catch { /* original failure retained */ }
  try { await writeFile(resolve(evidence, "failure-uia.json"), JSON.stringify(await ui("Inspect"), null, 2)); } catch { /* app may already be gone */ }
} finally {
  clearInterval(sampler);
  await sampleInFlight;
  if (child.exitCode === null && child.pid) {
    try { await ui("Cancel"); } catch { /* no owned native dialog may remain */ }
    try { await ui("Close"); } catch { /* owned tree termination below */ }
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(15000)]);
    if (child.exitCode === null) {
      await exec("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
      note("owned-tree-forced-stop");
      failure ??= "Owned application did not settle normal close";
    }
  }
  socket?.close();
  const sourceAfter = await sha(source);
  if (sourceAfter !== sourceBefore) failure ??= "SOURCE_PDF_CHANGED";
  await writeFile(resolve(evidence, "native.json"), JSON.stringify({ fixture, mode, exeSha256: createHash("sha256").update(executableBytes).digest("hex"),
    qaIdentifier: "com.dsargus.modeleaf.print83qa", inputMethod, browser: version?.Browser, sourceBefore, sourceAfter,
    before, after, events, trace, memory, failure: failure ?? null,
    limitations: ["Reference workstation QA-identifier packaged debug executable, not installer/clean VM", "UIA observation timestamps include polling overhead", "Memory samples include process peak counters but not Windows spooler allocations", "Native output content verification is performed separately"] }, null, 2));
  console.log(`Evidence: ${resolve(evidence, "native.json")}`);
}
if (failure) process.exitCode = 1;
