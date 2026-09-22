import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createPhase0Pdf } from "../fixtures/generate-phase0-pdf.mjs";
import { createRangeAssemblyPdf } from "../fixtures/generate-range-assembly-pdf.mjs";

// Owned preview only. Public generated fixtures; no private shares or native mocking.
const root = resolve(".internal/evidence/issue147-native");
const fixtureRoot = join(root, "fixtures");
const fixturePaths = { normal: join(fixtureRoot, "normal-100.pdf"), image: join(fixtureRoot, "large-image.pdf") };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
if (process.argv[2] === "--prepare") {
  await mkdir(fixtureRoot, { recursive: true });
  const fixtures = { normal: createPhase0Pdf(), image: createRangeAssemblyPdf() };
  const manifest = {};
  for (const [name, bytes] of Object.entries(fixtures)) {
    try { await writeFile(fixturePaths[name], bytes, { flag: "wx" }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    assert.equal(hash(await readFile(fixturePaths[name])), hash(bytes), "Existing controlled fixture differs; not overwritten");
    manifest[name] = { bytes: bytes.length, sha256: hash(bytes) };
  }
  await writeFile(join(fixtureRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ prepared: true, fixtures: manifest }));
  process.exit(0);
}

const pid = Number(process.argv[2]), port = Number(process.argv[3] ?? "9333");
assert(Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(port) && port > 0 && port < 65536);
const receipt = JSON.parse((await readFile(".internal/preview-target/preview-receipt.json", "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(receipt.kind, "standalone-tauri-release-no-bundle", "Requires the final optimized preview candidate");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).replace(/\r?\n$/u, "");
assert.equal(receipt.source.head, git("rev-parse", "HEAD"));
assert.equal(receipt.source.statusSha256, hash(git("status", "--porcelain=v1")));
assert.equal(receipt.source.diffSha256, hash(git("diff", "--binary", "HEAD")));
const executable = resolve(".internal/preview-target/release/modeleaf.exe");
assert.equal(hash(await readFile(executable)), receipt.executableSha256);
assert.equal(execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).Path`], { encoding: "utf8", timeout: 30000 }).trim().toLowerCase(), executable.toLowerCase());
const fixtureHashes = {};
for (const [name, path] of Object.entries(fixturePaths)) fixtureHashes[name] = hash(await readFile(path));
assert.equal(fixtureHashes.normal, "e9d6b79062e01d6914742f17f00bea4576852f374e8f2851e90004dbca020ed8");
assert.equal(fixtureHashes.image, "ab53e214edfc196078d83dde9001fe302055bbb6b1e056a5bf3b738e372d1d82");
const evidence = join(root, new Date().toISOString().replaceAll(":", "-"));
await mkdir(evidence, { recursive: true });
const delay = ms => new Promise(done => setTimeout(done, ms));
async function wait(check, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(50); }
  throw new Error(`Controlled QA timed out: ${label}`);
}
async function targets() { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(target => target.type === "page" && target.url.startsWith("http://tauri.localhost")); }
async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  let sequence = 0, paused;
  const pending = new Map(), scripts = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data), entry = pending.get(message.id);
    if (entry) { pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error("CDP command failed")) : entry.done(message.result); }
    else if (message.method === "Debugger.scriptParsed") scripts.push(message.params);
    else if (message.method === "Debugger.paused") paused = message.params;
  };
  socket.onclose = () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Owned WebView disconnected")); } pending.clear(); };
  const call = (method, params = {}) => new Promise((done, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP command timeout")); }, 30000);
    pending.set(id, { done, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    assert(!response.exceptionDetails, "Controlled WebView evaluation failed; raw payload omitted");
    return response.result.value;
  };
  const capture = async () => {
    scripts.length = 0; paused = undefined;
    await evaluate("window.rangeAssemblyQA ??= {failures:[]}");
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
    assert(breakpoint, "Owned session inspection point unavailable");
    await evaluate("document.querySelector('.tab-host:not([hidden])').focus({preventScroll:true})");
    const input = (async () => {
      await call("Input.dispatchKeyEvent", { type: "keyDown", key: "w", code: "KeyW", windowsVirtualKeyCode: 87 });
      await call("Input.dispatchKeyEvent", { type: "keyUp", key: "w", code: "KeyW", windowsVirtualKeyCode: 87 });
    })();
    try {
      await wait(() => paused, "existing session inspection");
      const frame = paused.callFrames.find(frame => frame.functionName === "settleCurrentView"); assert(frame);
      const result = await call("Debugger.evaluateOnCallFrame", { callFrameId: frame.callFrameId, expression: "window.rangeAssemblyQA.controller=this.pdfReader" });
      assert(!result.exceptionDetails);
    } finally {
      await call("Debugger.removeBreakpoint", { breakpointId: breakpoint.breakpointId });
      if (paused) await call("Debugger.resume");
      await input; await call("Debugger.disable");
    }
  };
  return { call, evaluate, capture, close: () => socket.close() };
}
const pages = await targets(); assert.equal(pages.length, 1, "Start a fresh one-window preview with normal-100.pdf");
const primary = await connect(pages[0]); let secondary;
const checks = [];
async function loaded(client, count) {
  return wait(async () => {
    const state = await client.evaluate(`(()=>{const t=document.querySelector('.status-message')?.textContent??'',m=t.match(/\\[(PDF_[A-Z_]+)(?::([0-9]{3}))?\\]/),p=document.querySelector('.status-page')?.textContent??'',c=document.querySelector('.tab-host:not([hidden]) canvas');return {code:m?.[1]??null,page:p,canvas:Boolean(c&&c.width>0&&c.height>0&&c.getBoundingClientRect().height>0),tabs:document.querySelectorAll('[role=tab]').length}})()`);
    assert.equal(state.code, null, "Natural public fixture failed");
    return state.canvas && new RegExp('\\/\\s*' + count + '$').test(state.page.trim()) ? state : false;
  }, `natural ${count}-page render`);
}
async function stats(client) {
  const value = await client.evaluate("window.__TAURI_INTERNALS__.invoke('pdf_assembly_stats',{})");
  assert(Number.isSafeInteger(value.currentBytes) && value.currentBytes >= 0 && value.currentBytes <= 512 * 1048576);
  assert(Number.isSafeInteger(value.peakBytes) && value.peakBytes >= value.currentBytes && value.peakBytes <= 512 * 1048576);
  assert(value.activeLeases <= 8 && value.pendingRequests <= 8);
  return value;
}
try {
  const normal = await loaded(primary, 100); assert.equal(normal.tabs, 1);
  await wait(async () => (await stats(primary)).currentBytes === 0, "normal fixture assembly settlement");
  checks.push({ case: "fresh-one-public-100-page-natural-load", observed: normal, stats: await stats(primary), injectedRangeRequests: 0 });
  await primary.evaluate(`(()=>{const q=window.rangeAssemblyQA={failures:[]};q.observer=new MutationObserver(()=>{const t=document.querySelector('.status-message')?.textContent??'',m=t.match(/\\[(PDF_[A-Z_]+)(?::([0-9]{3}))?\\]/);if(m)q.failures.push({code:m[1],httpStatus:m[2]?Number(m[2]):undefined})});q.observer.observe(document.querySelector('#status'),{subtree:true,characterData:true,childList:true});})()`);
  execFileSync(executable, [fixturePaths.image], { timeout: 15000 });
  const image = await loaded(primary, 1); assert.equal(image.tabs, 2);
  await wait(async () => (await stats(primary)).currentBytes === 0, "large logical reply settlement");
  const imageStats = await stats(primary); assert(imageStats.peakBytes >= 10 * 1048576, "Expected real >4MiB logical reply reservation");
  const imagePainted = await primary.evaluate("(()=>{const c=document.querySelector('.tab-host:not([hidden]) .pdf-page-frame[data-active-page=\"true\"] canvas')??document.querySelector('.tab-host:not([hidden]) canvas');const p=c.getContext('2d').getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data;return p[0]<100&&p[1]<100&&p[2]<100&&p[3]>0})()");
  assert.equal(imagePainted, true, "Large image was not painted");
  await primary.capture();
  checks.push({ case: "natural-large-image-exact-logical-reply", observed: image, stats: imageStats, imagePainted, injectedRangeRequests: 0 });

  // Separate CONTROLLED native-credit test, not evidence of natural PDF demand.
  await primary.evaluate("window.__TAURI_INTERNALS__.invoke('create_app_window',{})");
  const next = await wait(async () => (await targets()).find(target => target.id !== pages[0].id), "owned second window");
  secondary = await connect(next);
  await wait(() => secondary.evaluate("Boolean(window.__TAURI_INTERNALS__)"), "second window native boundary");
  const claimed = await secondary.evaluate(`(async()=>{const i=window.__TAURI_INTERNALS__.invoke,r=await i('list_recents',{});const e=r.entries?.find(e=>e.displayPath.toLowerCase()===${JSON.stringify(fixturePaths.normal.toLowerCase())});if(!e)return false;const opened=await i('open_recent',{recentId:e.recentId});if(opened.tag!=='ADMITTED')return false;const c=await i('claim_open_request',{requestId:opened.requestId});window.rangeAssemblyQA={claimed:c,requestId:opened.requestId};return Boolean(c.sessionId&&c.ownerGeneration)})()`);
  assert.equal(claimed, true, "Controlled second-owner native claim failed");
  const aBytes = await primary.evaluate("(async()=>{const c=rangeAssemblyQA.controller.current,s=c.session;rangeAssemblyQA.identity={sessionId:s.sessionId,documentGeneration:s.documentGeneration,ownerGeneration:c.ownerGeneration};rangeAssemblyQA.lease=await window.__TAURI_INTERNALS__.invoke('reserve_pdf_assembly',{request:{...rangeAssemblyQA.identity,requestSequence:1000000,begin:0,end:s.length}});return rangeAssemblyQA.lease.byteLength})()");
  const aLease = await primary.evaluate("rangeAssemblyQA.lease.leaseId");
  const bBytes = await secondary.evaluate("(async()=>{const c=rangeAssemblyQA.claimed;rangeAssemblyQA.identity={sessionId:c.sessionId,documentGeneration:c.documentGeneration,ownerGeneration:c.ownerGeneration};rangeAssemblyQA.lease=await window.__TAURI_INTERNALS__.invoke('reserve_pdf_assembly',{request:{...rangeAssemblyQA.identity,requestSequence:1000000,begin:0,end:c.length}});return rangeAssemblyQA.lease.byteLength})()");
  const together = await stats(primary); assert.equal(together.currentBytes, aBytes + bBytes); assert.equal(together.activeLeases, 2);
  const foreignRejected = await secondary.evaluate(`window.__TAURI_INTERNALS__.invoke('release_pdf_assembly',{...rangeAssemblyQA.identity,leaseId:${aLease},proof:'UNALLOCATED'}).then(()=>false,()=>true)`);
  assert.equal(foreignRejected, true); assert.equal((await stats(primary)).currentBytes, aBytes + bBytes);
  await primary.evaluate("window.__TAURI_INTERNALS__.invoke('release_pdf_assembly',{...rangeAssemblyQA.identity,leaseId:rangeAssemblyQA.lease.leaseId,proof:'UNALLOCATED'})");
  assert.equal((await stats(secondary)).currentBytes, bBytes);
  await secondary.evaluate("window.__TAURI_INTERNALS__.invoke('release_pdf_assembly',{...rangeAssemblyQA.identity,leaseId:rangeAssemblyQA.lease.leaseId,proof:'UNALLOCATED'})");
  await secondary.evaluate("window.__TAURI_INTERNALS__.invoke('reject_open_request',{requestId:rangeAssemblyQA.requestId})");
  await wait(async () => (await stats(primary)).currentBytes === 0, "cross-window credit settlement");
  checks.push({ case: "controlled-cross-window-native-credit-ownership", reservedBytes: together.currentBytes, activeLeases: together.activeLeases, foreignReleaseRejected: foreignRejected, final: await stats(primary), allocatedAssemblyBuffers: false });
  assert.deepEqual(await primary.evaluate("rangeAssemblyQA.failures"), []);
  for (const [name, path] of Object.entries(fixturePaths)) assert.equal(hash(await readFile(path)), fixtureHashes[name]);
  const result = { passed: true, receipt, checks, fixtureHashes, limitations: ["Public local fixtures, not owner private V validation", "Stats are native assembly reservation bytes, not total RSS", "Cross-window case intentionally grants credits without allocating payload and releases UNALLOCATED", "Owned windows left open for parent-controlled cleanup"] };
  await writeFile(join(evidence, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: true, cases: checks.length, evidence }));
} catch (error) {
  await writeFile(join(evidence, "failure.json"), JSON.stringify({ passed: false, receipt, checks, reason: "Native logical-range QA did not complete; private payload omitted" }, null, 2));
  throw error;
} finally {
  await primary.evaluate("window.rangeAssemblyQA?.observer?.disconnect()").catch(() => undefined);
  primary.close(); secondary?.close();
}
