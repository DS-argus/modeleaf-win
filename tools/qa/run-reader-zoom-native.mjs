import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Bundled WebView2 shell input, real native authority, isolated preview receipt.
// Requires preview:worktree with --remote-debugging-port=9333. Leaves the app open.
const [pidArgument, portArgument = "9333"] = process.argv.slice(2);
const pid = Number(pidArgument), port = Number(portArgument);
assert(Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(port) && port > 0 && port < 65536);
const evidence = resolve(".internal/evidence/reader-zoom-native", new Date().toISOString().replaceAll(":", "-"));
await mkdir(evidence, { recursive: true });
const hash = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const executable = resolve(".internal/preview-target/debug/modeleaf.exe");
const receipt = JSON.parse((await readFile(".internal/preview-target/preview-receipt.json", "utf8")).replace(/^\uFEFF/, ""));
assert.equal(await hash(executable), receipt.executableSha256);
const processPath = execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).Path`], { encoding: "utf8", timeout: 30000 }).trim();
assert.equal(processPath.toLowerCase(), executable.toLowerCase());
const fixtures = ["print-mixed-rotation-4.pdf", "fixture-L-text-300.pdf"];
const hashes = async () => Object.fromEntries(await Promise.all(fixtures.map(async name => [name, await hash(resolve("fixtures/pdf", name))])));
const beforeHashes = await hashes();
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(target => target.type === "page" && target.url.startsWith("http://tauri.localhost"));
assert(page, "Preview WebView unavailable");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
let sequence = 0, paused;
const pending = new Map(), scripts = [], actions = [], results = [];
socket.onmessage = event => {
  const message = JSON.parse(event.data), request = pending.get(message.id);
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
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
    pending.set(id, { done, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? JSON.stringify(response.exceptionDetails));
  return response.result.value;
}
const delay = ms => new Promise(done => setTimeout(done, ms));
async function wait(predicate, label) {
  for (let attempt = 0; attempt < 300; attempt++) { if (await predicate()) return; await delay(50); }
  throw new Error(`Timeout: ${label}`);
}
async function key(value) {
  const vk = value === "-" ? 189 : value === "=" ? 187 : value.toUpperCase().charCodeAt(0);
  const code = value === "-" ? "Minus" : value === "=" ? "Equal" : value === "0" ? "Digit0" : `Key${value.toUpperCase()}`;
  const params = { key: value, code, windowsVirtualKeyCode: vk, modifiers: value === "F" ? 8 : 0 };
  actions.push({ key: value });
  await call("Input.dispatchKeyEvent", { type: "keyDown", ...params });
  await call("Input.dispatchKeyEvent", { type: "keyUp", ...params });
}
async function captureCurrentSession() {
  scripts.length = 0; paused = undefined;
  await call("Debugger.enable");
  let breakpoint;
  for (const script of scripts) {
    if (!script.url.includes("/assets/index-")) continue;
    const { scriptSource } = await call("Debugger.getScriptSource", { scriptId: script.scriptId });
    const start = scriptSource.indexOf("async settleCurrentView(");
    if (start < 0) continue;
    const prefix = scriptSource.slice(0, scriptSource.indexOf("{", start) + 1).split("\n");
    breakpoint = await call("Debugger.setBreakpoint", { location: { scriptId: script.scriptId, lineNumber: prefix.length - 1, columnNumber: prefix.at(-1).length } });
    break;
  }
  assert(breakpoint, "Presentation diagnostic breakpoint unavailable");
  await evaluate("document.querySelector('.tab-host:not([hidden])').focus({preventScroll:true})");
  const probe = key("w");
  try {
    await wait(() => Boolean(paused), "presentation owner capture");
    const frame = paused.callFrames.find(frame => frame.functionName === "settleCurrentView");
    assert(frame, "Presentation owner frame missing");
    const captured = await call("Debugger.evaluateOnCallFrame", { callFrameId: frame.callFrameId, expression: "window.nativeZoomQA.session=this;window.nativeZoomQA.controller=this.pdfReader;" });
    assert(!captured.exceptionDetails);
  } finally {
    await call("Debugger.removeBreakpoint", { breakpointId: breakpoint.breakpointId });
    if (paused) await call("Debugger.resume");
    await probe; await call("Debugger.disable");
  }
}
async function settled(label) {
  let previous, stable = 0, snapshot;
  await wait(async () => {
    snapshot = await evaluate(`(()=>{const q=nativeZoomQA,s=q.session,c=q.controller,h=c.options.canvasHost;return {reader:s.snapshot.reader,active:s.snapshot.active,top:h.scrollTop,frames:h.querySelectorAll('.pdf-page-frame').length,tabs:document.querySelectorAll('[role=tab]').length,selected:[...document.querySelectorAll('[role=tab]')].findIndex(t=>t.getAttribute('aria-selected')==='true'),busy:s.pendingPresentationRenders>0||s.presentationSettlements>0||s.wheelSettlement!==undefined||s.navigationLandingInProgress||c.viewportSettlement!==undefined,resources:s.options.resources.snapshot(),failures:q.failures};})()`);
    const signature = JSON.stringify(snapshot);
    stable = !snapshot.busy && snapshot.resources.totals.render === 0 && signature === previous ? stable + 1 : 0;
    previous = signature; return stable >= 4;
  }, label);
  assert.equal(snapshot.active, true, label);
  assert(snapshot.frames > 0 && snapshot.frames <= 16, label);
  assert(snapshot.resources.totals["canvas-bytes"] <= 256 * 1048576, label);
  assert(snapshot.reader.customScale >= 0.25 && snapshot.reader.customScale <= 4, label);
  assert.deepEqual(snapshot.failures, [], label);
  results.push({ label, snapshot });
  return snapshot;
}
async function wheel(deltaY) {
  const position = await evaluate("(()=>{const r=nativeZoomQA.controller.options.canvasHost.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()");
  actions.push({ wheel: deltaY, modifiers: 2 });
  await call("Input.dispatchMouseEvent", { type: "mouseWheel", ...position, deltaX: 0, deltaY, modifiers: 2 });
}
async function clickTab(index) {
  const position = await evaluate(`(()=>{const e=document.querySelectorAll('[role=tab]')[${index}];const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  actions.push({ tab: index });
  await call("Input.dispatchMouseEvent", { type: "mousePressed", ...position, button: "left", clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...position, button: "left", clickCount: 1 });
  await wait(() => evaluate(`document.querySelectorAll('[role=tab]')[${index}].getAttribute('aria-selected')==='true'`), "tab selection");
  await captureCurrentSession();
  const snapshot = await settled(`tab ${index} activation`);
  assert.equal(snapshot.selected, index);
}
try {
  await wait(() => evaluate("Boolean(document.querySelector('.tab-host:not([hidden]) canvas'))"), "initial PDF");
  await evaluate(`(()=>{window.nativeZoomQA={failures:[]};const q=nativeZoomQA;q.observer=new MutationObserver(()=>{const text=document.querySelector('#status').innerText;if(/failed|could not|unavailable/i.test(text))q.failures.push(text)});q.observer.observe(document.querySelector('#status'),{subtree:true,characterData:true,childList:true});})()`);
  await captureCurrentSession();
  const initial = await settled("initial fit width");
  assert.equal(initial.reader.pageCount, 4, "Launch preview with print-mixed-rotation-4.pdf");
  assert.equal(initial.tabs, 1, "Start this verification with a fresh one-tab preview");
  for (const value of ["w", "w", "-", "=", "F", "-", "=", "w"]) { await key(value); await settled(`key ${value}`); }
  // Exercise the narrow/wide boundary using shell keys and WebView input only.
  await key("g"); await key("g");
  assert.equal((await settled("mixed first-page precondition")).reader.page, 1);
  await key("n"); assert.equal((await settled("mixed page 2")).reader.page, 2);
  await key("n"); assert.equal((await settled("mixed page 3")).reader.page, 3);
  await key("w");
  const fittedWidth = await settled("mixed narrow page fit width");
  const position = await evaluate("(()=>{const h=nativeZoomQA.controller.options.canvasHost,r=h.getBoundingClientRect();return {x:r.left+h.clientWidth/2,y:r.top+h.clientHeight/2,delta:h.clientHeight*0.4};})()");
  actions.push({ plainWheel: -position.delta });
  await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: position.x, y: position.y, deltaX: 0, deltaY: -position.delta, modifiers: 0 });
  const boundary = await settled("mixed boundary passive fit width");
  assert.equal(boundary.reader.customScale, fittedWidth.reader.customScale, "Passive page selection must not refit width");
  await delay(1500);
  assert.equal((await settled("mixed boundary idle")).reader.customScale, fittedWidth.reader.customScale);
  await key("F"); await settled("mixed boundary final fit page");
  const fitGeometry = await evaluate(`(async()=>{
    const s=nativeZoomQA.session,c=nativeZoomQA.controller,h=c.options.canvasHost,r=s.snapshot.reader;
    const size=await c.getPageNaturalSize(r.fitPageReference,r.rotationQuarterTurns*90,()=>true);
    const style=getComputedStyle(h),padding=value=>Number.parseFloat(value)||0;
    const width=h.clientWidth-padding(style.paddingLeft)-padding(style.paddingRight);
    const height=h.clientHeight-padding(style.paddingTop)-padding(style.paddingBottom);
    return {mode:r.zoomMode,topology:c.presentationTopology,scale:r.customScale,renderedScale:c.viewTransform.scale,
      expected:Math.max(0.25,Math.min(4,width/size.width,height/size.height)),
      clientWidth:h.clientWidth,clientHeight:h.clientHeight,scrollWidth:h.scrollWidth,scrollHeight:h.scrollHeight,dpr:devicePixelRatio};
  })()`);
  assert.equal(fitGeometry.mode, "fit-page");
  assert.equal(fitGeometry.topology, "single-page");
  assert(Math.abs(fitGeometry.scale - fitGeometry.expected) < 1e-10, JSON.stringify(fitGeometry));
  assert.equal(fitGeometry.renderedScale, fitGeometry.scale);
  results.push({ label: "final single-page geometry", geometry: fitGeometry });
  await key("w"); await settled("fit width after geometry regression");
  await wheel(-100000);
  assert.equal((await settled("wheel upper bound")).reader.customScale, 4);
  await wheel(100000);
  assert.equal((await settled("wheel lower bound")).reader.customScale, 0.25);
  await wheel(-100);
  assert((await settled("wheel recovery from lower bound")).reader.customScale > 0.25);
  await key("w"); await settled("fit width after wheel extremes");
  const second = spawn(executable, [resolve("fixtures/pdf/fixture-L-text-300.pdf")], { stdio: "ignore" });
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Second-instance forwarding timed out")), 30000);
    second.on("error", error => { clearTimeout(timer); reject(error); });
    second.on("exit", code => { clearTimeout(timer); if (code === 0) done(); else reject(new Error(`Second instance exited ${code}`)); });
  });
  await wait(() => evaluate("document.querySelectorAll('[role=tab]').length===2"), "second PDF tab");
  await captureCurrentSession();
  assert.equal((await settled("second native document")).reader.pageCount, 300);
  for (const index of [0, 1, 0, 1]) {
    await clickTab(index);
    for (const value of ["-", "=", "w"]) { await key(value); await settled(`tab ${index} key ${value}`); }
  }
  const afterHashes = await hashes();
  assert.deepEqual(afterHashes, beforeHashes);
  const screenshot = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(resolve(evidence, "native-zoom.png"), Buffer.from(screenshot.data, "base64"));
  await writeFile(resolve(evidence, "native-zoom.json"), JSON.stringify({ status: "passed", receipt, fixtureHashes: afterHashes, actions, results, limitations: ["Bundled standalone debug WebView2 with CDP input, not physical human keyboard/mouse testing", "Debugger captures owners only; no replaced presentation or native implementation", "App deliberately left open for owner review"] }, null, 2));
  console.log(JSON.stringify({ status: "passed", scenarios: results.length, processId: pid, evidence, leftOpen: true }));
} catch (error) {
  await writeFile(resolve(evidence, "failure.json"), JSON.stringify({ status: "failed", error: String(error.stack ?? error), receipt, actions, results }, null, 2));
  throw error;
} finally {
  if (socket.readyState === WebSocket.OPEN) {
    try { if (paused) await call("Debugger.resume"); } catch { /* May already be resumed. */ }
    await call("Debugger.disable").catch(() => undefined);
    await evaluate("window.nativeZoomQA?.observer?.disconnect();delete window.nativeZoomQA;").catch(() => undefined);
    socket.close();
  }
}
