import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Run against this worktree's already launched npm run preview:worktree candidate.
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 must be set at launch.
// Input uses Windows key-down/up injection, not DOM dispatch or headless Chromium.
const [pidArgument, pdfArgument, portArgument = "9333"] = process.argv.slice(2);
const pid = Number(pidArgument);
assert(Number.isSafeInteger(pid) && pid > 0 && pdfArgument, "Usage: node tools/qa/run-reader-repeat.mjs <preview-pid> <pdf> [port]");
const port = Number(portArgument);
assert(Number.isSafeInteger(port) && port > 0 && port < 65536);
const evidence = resolve(".internal/evidence/reader-repeat", new Date().toISOString().replaceAll(":", "-"));
await mkdir(evidence, { recursive: true });
const hash = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const pdf = resolve(pdfArgument);
const fixtureBefore = await hash(pdf);
const receipt = JSON.parse((await readFile(".internal/preview-target/preview-receipt.json", "utf8")).replace(/^\uFEFF/, ""));
const executableHash = await hash(".internal/preview-target/debug/modeleaf.exe");
assert.equal(executableHash, receipt.executableSha256);
const ps = expression => execFileSync("powershell.exe", ["-NoProfile", "-Command", expression], { encoding: "utf8", timeout: 30_000 });
const processInfo = JSON.parse(ps(`$p=Get-Process -Id ${pid}; [pscustomobject]@{path=$p.Path;workingSet=$p.WorkingSet64} | ConvertTo-Json -Compress`));
assert.equal(processInfo.path.toLowerCase(), resolve(".internal/preview-target/debug/modeleaf.exe").toLowerCase());
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find(entry => entry.type === "page" && entry.url.startsWith("http://tauri.localhost"));
assert(page, "Native Tauri WebView target unavailable");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
const scripts = [];
let paused;
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  const request = pending.get(message.id);
  if (request) {
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.done(message.result);
  } else if (message.method === "Debugger.scriptParsed") scripts.push(message.params);
  else if (message.method === "Debugger.paused") paused = message.params;
};
socket.onclose = () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("WebView disconnected")); } pending.clear(); };
function call(method, params = {}) {
  return new Promise((done, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30_000);
    pending.set(id, { done, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
async function wait(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt++) { if (await predicate()) return; await delay(50); }
  throw new Error(`Timeout: ${label}`);
}
async function key(key, modifiers = 0) {
  const params = { key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), modifiers };
  await call("Input.dispatchKeyEvent", { type: "keyDown", ...params });
  await call("Input.dispatchKeyEvent", { type: "keyUp", ...params });
}
const results = [];
let failure;
try {
  // Capture existing objects through a bounded debugger breakpoint. No product-only QA API,
  // substituted renderer/native boundary, or altered navigation implementation is involved.
  await call("Debugger.enable");
  let breakpoint;
  for (const script of scripts) {
    if (!script.url.includes("/assets/index-")) continue;
    const { scriptSource } = await call("Debugger.getScriptSource", { scriptId: script.scriptId });
    const start = scriptSource.indexOf("async restoreViewportLanding(");
    if (start < 0) continue;
    const prefix = scriptSource.slice(0, scriptSource.indexOf("{", start) + 1).split("\n");
    breakpoint = await call("Debugger.setBreakpoint", { location: { scriptId: script.scriptId, lineNumber: prefix.length - 1, columnNumber: prefix.at(-1).length } });
    break;
  }
  assert(breakpoint, "Navigation diagnostic breakpoint unavailable");
  await evaluate("document.querySelector('.tab-host:not([hidden])').focus({preventScroll:true})");
  const probe = (async () => { await key("n"); await delay(100); if (!paused) await key("p"); })();
  await wait(() => Boolean(paused), "navigation diagnostic pause");
  for (const frame of paused.callFrames) {
    const name = frame.functionName === "restoreViewportLanding" ? "controller" : frame.functionName === "restoreCanonicalLanding" ? "session" : undefined;
    if (name) await call("Debugger.evaluateOnCallFrame", { callFrameId: frame.callFrameId, expression: `(window.readerRepeatQA??={}).${name}=this` });
  }
  await call("Debugger.removeBreakpoint", { breakpointId: breakpoint.breakpointId });
  await call("Debugger.resume"); await probe; await call("Debugger.disable");
  await evaluate(`(()=>{const q=readerRepeatQA; if(!q.session||!q.controller)throw Error('Missing native owners');
    q.events=[];q.failures=[];q.host=q.controller.options.canvasHost;
    q.recorded=new WeakSet();q.onKey=e=>{if(['n','p','d','u'].includes(e.key)&&!q.recorded.has(e)){q.recorded.add(e);q.events.push({key:e.key,repeat:e.repeat,trusted:e.isTrusted,type:e.type})}};
    q.stop=Event.prototype.stopImmediatePropagation;Event.prototype.stopImmediatePropagation=function(){if(this.type==='keydown')q.onKey(this);return q.stop.call(this)};window.addEventListener('keydown',q.onKey,true);window.addEventListener('keyup',q.onKey,true);
    q.observer=new MutationObserver(()=>{const text=document.querySelector('#status').innerText;if(/failed|could not|unavailable/i.test(text))q.failures.push(text)});
    q.observer.observe(document.querySelector('#status'),{subtree:true,characterData:true,childList:true});
    q.snapshot=()=>({reader:q.session.snapshot.reader,title:q.session.snapshot.title,active:q.session.snapshot.active,
      tab:document.querySelector('[role=tab][aria-selected=true]')?.textContent,top:q.host.scrollTop,left:q.host.scrollLeft,
      status:document.querySelector('#status').innerText,frames:q.host.querySelectorAll('.pdf-page-frame').length,
      text:q.host.querySelectorAll('.textLayer').length,annotations:q.host.querySelectorAll('.annotationLayer').length,
      busy:q.session.pageStepActive||q.session.pendingPageStep!==undefined||q.session.navigationLandingInProgress||q.session.pendingPresentationRenders>0||q.controller.viewportSettlement!==undefined,
      resources:q.session.options.resources.snapshot()});
  })()`);
  async function settled() {
    let previous; let equal = 0; let sample;
    await wait(async () => {
      sample = await evaluate("readerRepeatQA.snapshot()");
      const signature = JSON.stringify(sample);
      equal = !sample.busy && sample.resources.totals.render === 0 && signature === previous ? equal + 1 : 0;
      previous = signature; return equal >= 5;
    }, "queue, layout and reservations settle");
    assert(sample.active); assert(sample.frames > 0 && sample.frames <= 16);
    assert(sample.text <= 16 && sample.annotations <= 16);
    assert.equal(sample.resources.totals.render, 0);
    assert(sample.resources.totals["canvas-bytes"] <= 256 * 1048576);
    assert(sample.resources.totals["text-process-bytes"] <= 128 * 1048576);
    assert(sample.resources.totals["text-page-bytes"] <= 16 * 2 * 1048576);
    return sample;
  }
  const initial = await settled();
  assert.equal(initial.title, pdf.split(/[\\/]/).at(-1));
  assert(initial.reader.pageCount >= 4 && initial.reader.pageCount <= 30, "Use a bounded mixed-geometry fixture (4–30 pages)");
  const tab = initial.tab;
  async function input(keyName, mode, count = 40) {
    await evaluate("readerRepeatQA.events=[];readerRepeatQA.host.focus({preventScroll:true})");
    execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve("tools/windows/send-reader-repeat.ps1"), "-ProcessId", String(pid), "-Key", keyName, "-Mode", mode, "-Count", String(count), "-IntervalMs", mode === "held" ? "15" : "1"], { timeout: 30_000 });
    const sample = await settled();
    const events = await evaluate("readerRepeatQA.events");
    const downs = events.filter(event => event.type === "keydown");
    assert.equal(downs.length, count, "Every OS key-down must reach this reader");
    assert(downs.every(event => event.trusted && event.key === keyName));
    assert.equal(downs.filter(event => event.repeat).length, mode === "held" ? count - 1 : 0);
    assert.equal(sample.tab, tab); assert.equal(await hash(pdf), fixtureBefore);
    results.push({ key: keyName, mode, events, sample });
    return sample;
  }
  for (const mode of ["held", "burst"]) {
    await key("F", 8); await settled();
    await key("g"); await key("g"); await settled();
    for (const direction of ["n", "p", "d", "u"]) {
      // A burst coalesces by design; repeated bounded bursts drive to the edge.
      let sample;
      for (let batch = 0; batch < initial.reader.pageCount; batch++) {
        sample = await input(direction, mode);
        const expected = direction === "n" || direction === "d" ? initial.reader.pageCount : 1;
        if (sample.reader.page === expected) break;
      }
      const expected = direction === "n" || direction === "d" ? initial.reader.pageCount : 1;
      assert.equal(sample.reader.page, expected);
      const boundary = await input(direction, mode);
      assert.equal(boundary.reader.page, expected); assert(Math.abs(boundary.top - sample.top) <= 1);
      assert.equal(boundary.reader.zoomMode, "fit-page");
    }
  }
  // Mixed-width repeated navigation exercises transforms and fractional native scroll edges.
  await key("w"); await settled();
  for (const direction of ["n", "p", "n", "p"]) await input(direction, "held");
  // Custom and continuous fit-width d/u retain viewport-scroll (not page-turn) semantics.
  for (const modeKey of ["w", "0"]) {
    await key(modeKey); await key("g"); await key("g"); const before = await settled();
    const down = await input("d", "burst", 2);
    assert(down.top > before.top); assert.equal(down.reader.zoomMode, before.reader.zoomMode);
    const up = await input("u", "burst", 2);
    assert(up.top < down.top); assert.equal(up.reader.zoomMode, before.reader.zoomMode);
  }
  const errors = await evaluate("readerRepeatQA.failures");
  assert.deepEqual(errors, [], "No transient navigation/compensation failures are allowed");
  const screenshot = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(resolve(evidence, "native.png"), Buffer.from(screenshot.data, "base64"));
} catch (error) { failure = String(error.stack ?? error); }
finally {
  try { await call("Debugger.resume"); } catch { /* Not paused. */ }
  let diagnostics;
  try {
    await call("Debugger.disable");
    diagnostics = await evaluate("window.readerRepeatQA ? {events:readerRepeatQA.events,failures:readerRepeatQA.failures,snapshot:readerRepeatQA.snapshot?.(),dpr:devicePixelRatio} : null");
    await evaluate("if(window.readerRepeatQA){const q=readerRepeatQA;q.observer?.disconnect();if(q.stop)Event.prototype.stopImmediatePropagation=q.stop;window.removeEventListener('keydown',q.onKey,true);window.removeEventListener('keyup',q.onKey,true);delete window.readerRepeatQA}");
  } catch (error) { failure ??= String(error); }
  socket.close();
  const fixtureAfter = await hash(pdf);
  if (fixtureAfter !== fixtureBefore) failure ??= "Source PDF SHA-256 changed";
  await writeFile(resolve(evidence, "result.json"), JSON.stringify({ kind: "native-preview-webview2-os-injected-repeat", receipt, executableHash, fixtureBefore, fixtureAfter, processInfo, results, diagnostics, failure, limitations: "OS-injected held key-down/repeat, not a human hardware typematic test; standalone debug preview, not an installed release package." }, null, 2));
  console.log(evidence);
}
if (failure) throw new Error(failure);
