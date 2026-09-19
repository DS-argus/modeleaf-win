import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

// Launch with npm run preview:worktree and WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333.
// Trusted CDP WebView2 input, not physical mouse/keyboard or installed-release evidence.
const pid = Number(process.argv[2]);
assert(Number.isSafeInteger(pid) && pid > 0, "Usage: node tools/qa/run-empty-open.mjs <preview-pid>");
const root = process.cwd();
const executable = resolve(root, ".internal/preview-target/debug/modeleaf.exe");
const receipt = JSON.parse((await readFile(".internal/preview-target/preview-receipt.json", "utf8")).replace(/^\uFEFF/u, ""));
const hash = (data) => createHash("sha256").update(data).digest("hex");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).replace(/\r?\n$/u, "");
assert.equal(receipt.branch, git("branch", "--show-current"));
assert.equal(receipt.source.head, git("rev-parse", "HEAD"));
assert.equal(receipt.source.statusSha256, hash(git("status", "--porcelain=v1")));
assert.equal(receipt.source.diffSha256, hash(git("diff", "--binary", "HEAD")));
assert.equal(receipt.executableSha256, hash(await readFile(executable)));
const processPath = execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).Path`], { encoding: "utf8" }).trim();
assert.equal(processPath.toLowerCase(), executable.toLowerCase(), "QA must own this worktree's preview");
const fixture = resolve(root, "fixtures/pdf/links.pdf");
const fixtureHash = hash(await readFile(fixture));
const evidence = resolve(root, ".internal/evidence/empty-open", new Date().toISOString().replaceAll(":", "-"));
await mkdir(evidence, { recursive: true });
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function wait(probe, label) {
  for (let n = 0; n < 100; n++) { if (await probe()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
let socket;
let serial = 0;
const pending = new Map();
function call(method, params = {}) {
  return new Promise((done, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { done: (r) => { clearTimeout(timer); done(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function key(key, code, virtualKey, modifiers = 0) {
  for (const type of ["keyDown", "keyUp"]) await call("Input.dispatchKeyEvent", {
    type, key, code, windowsVirtualKeyCode: virtualKey, modifiers,
    ...(type === "keyDown" && modifiers === 0 && (key === "Enter" || key === " ") ? { text: key === "Enter" ? "\r" : " " } : {}),
  });
  await evaluate("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))");
}
async function click(selector, padding = false) {
  const point = await evaluate(`(() => {
    const target=document.querySelector(${JSON.stringify(selector)}), r=target.getBoundingClientRect();
    const x=r.x+${padding ? "6" : "r.width/2"}, y=r.y+r.height/2;
    const hit=document.elementFromPoint(x,y);
    return {x,y,hit:hit?.id,inside:target===hit || target.contains(hit)};
  })()`);
  assert(point.inside, `Pointer interception at ${selector}: ${point.hit}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await call("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 });
  }
  return point;
}
const chooserOpen = () => evaluate("document.querySelector('#file-opener-dialog').open");
async function cancelChooser() {
  await key("Escape", "Escape", 27);
  await wait(async () => !(await chooserOpen()), "chooser closed");
  assert.equal(await evaluate("document.activeElement.id"), "empty-reader-open");
}
const transcript = [];
let observer;
const nativePending = new Map();
let nativeSerial = 0;
let observerReady = false;
function native(op, extra = {}) {
  return new Promise((done, reject) => {
    const id = ++nativeSerial;
    const timer = setTimeout(() => { nativePending.delete(id); reject(new Error(`Native observer timeout: ${op}`)); }, 5000);
    nativePending.set(id, { done: (r) => { clearTimeout(timer); done(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    observer.stdin.write(JSON.stringify({ id, op, ...extra }) + "\n");
  });
}
let passed = false;
try {
  const pages = await (await fetch("http://127.0.0.1:9333/json/list")).json();
  assert.equal(pages.filter((p) => p.type === "page").length, 1, "Only one preview page may own QA input");
  const target = pages.find((p) => p.type === "page");
  assert.match(target.url, /^https?:\/\/tauri\.localhost/u);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  socket.onmessage = ({ data }) => { const m = JSON.parse(data), p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.done(m.result); } };
  assert.equal(await evaluate("document.querySelector('#empty-reader').hidden"), false, "Start on an empty screen");
  assert.equal(await evaluate("document.querySelector('#tab-hosts').hidden"), true);
  await evaluate("globalThis.__emptyOpenClicks=[]; globalThis.__emptyOpenClickHandler=e=>globalThis.__emptyOpenClicks.push({trusted:e.isTrusted,target:e.target.tagName}); document.querySelector('#empty-reader-open').addEventListener('click', globalThis.__emptyOpenClickHandler); true");
  for (const [selector, padding] of [["#empty-reader-open span", false], ["#empty-reader-shortcut", false], ["#empty-reader-open", true]]) {
    const before = await evaluate("globalThis.__emptyOpenClicks.length");
    const point = await click(selector, padding);
    await wait(chooserOpen, "pointer opens chooser");
    assert.equal(await evaluate("globalThis.__emptyOpenClicks.length"), before + 1);
    assert.equal(await evaluate("globalThis.__emptyOpenClicks.at(-1).trusted"), true);
    assert.equal(await evaluate("document.activeElement.id"), "file-opener-input");
    await cancelChooser();
    transcript.push({ action: "pointer-open-cancel", selector, point, passed: true });
  }
  for (const [name, args] of [["Enter", ["Enter", "Enter", 13]], ["Space", [" ", "Space", 32]], ["Ctrl+Shift+O", ["O", "KeyO", 79, 10]]]) {
    await key(...args);
    await wait(chooserOpen, `${name} opens chooser`);
    await cancelChooser();
    transcript.push({ action: "keyboard-open-cancel", name, passed: true });
  }
  const fileSelector = 'details[data-menu-section="application"]';
  const menu = await evaluate(`(() => {
    const group=document.querySelector(${JSON.stringify(fileSelector)});
    return {sections:[...document.querySelectorAll('#windows-menu summary')].map(e=>e.textContent), commands:[...group.querySelectorAll('[data-menu-command]')].map(e=>({id:e.dataset.menuCommand,disabled:e.disabled,shortcut:e.querySelector('.windows-menu-shortcut').textContent}))};
  })()`);
  assert(!menu.sections.includes("Document"));
  for (const id of ["document.open", "document.close", "document.print"]) {
    const commands = menu.commands.filter((c) => c.id === id);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].disabled, id !== "document.open");
  }
  await click(`${fileSelector} summary`);
  await click('[data-menu-command="document.open"]');
  await wait(chooserOpen, "File open chooser");
  // Menu activation restores its invoking item; use pointer cancellation before the next empty action.
  await key("Escape", "Escape", 27);
  await wait(async () => !(await chooserOpen()), "File chooser closed");
  transcript.push({ action: "consolidated-file-menu", menu, passed: true });

  observer = spawn("powershell.exe", ["-NoProfile", "-File", "tools/windows/observe-browse-lifecycle.ps1", "-OwnerProcess", String(pid)], { stdio: ["pipe", "pipe", "inherit"] });
  createInterface({ input: observer.stdout }).on("line", (line) => {
    const m = JSON.parse(line); if (m.ready) { observerReady = true; return; }
    const p = nativePending.get(m.id); if (p) { nativePending.delete(m.id); m.ok ? p.done(m.result) : p.reject(new Error(m.error)); }
  });
  await wait(() => observerReady, "native observer ready");
  await click("#empty-reader-open span");
  await wait(chooserOpen, "chooser before native browse");
  await click(".file-opener-browse");
  let picker;
  await wait(async () => { picker = (await native("snapshot")).windows.find((w) => w.visible && w.class === "#32770"); return !!picker; }, "owned native picker visible");
  assert.equal(await chooserOpen(), false);
  await native("close", { hwnd: picker.hwnd });
  await wait(async () => !(await native("snapshot")).windows.some((w) => w.hwnd === picker.hwnd), "native picker cancelled");
  await wait(async () => await evaluate("document.activeElement.id === 'empty-reader-open' && !document.querySelector('#empty-reader-open').disabled"), "native cancel focus");
  transcript.push({ action: "banner-browse-native-picker-cancel", passed: true });

  // Seed a real recent through the supported second-instance ingress, then reopen it from the banner.
  execFileSync(executable, [fixture], { timeout: 15000 });
  await wait(async () => await evaluate("document.querySelector('#empty-reader').hidden && !document.querySelector('#tab-hosts').hidden && document.querySelectorAll('.pdf-page-frame').length > 0"), "fixture rendered");
  await wait(async () => await evaluate(`window.__TAURI_INTERNALS__.invoke('list_recents',{}).then(r=>r.entries?.some(e=>e.displayPath===${JSON.stringify(fixture)}))`), "fixture recent committed");
  for (const id of ["document.close", "document.print"]) assert.equal(await evaluate(`document.querySelector('[data-menu-command="${id}"]').disabled`), false);
  await click(`${fileSelector} summary`);
  await click('[data-menu-command="document.close"]');
  await wait(async () => !(await evaluate("document.querySelector('#empty-reader').hidden")), "last document closed");
  await click("#empty-reader-shortcut");
  await wait(chooserOpen, "banner reopened after last close");
  await call("Input.insertText", { text: "links.pdf" });
  await wait(async () => await evaluate(`[...document.querySelectorAll('.file-opener-recent')].some(e=>e.title===${JSON.stringify(fixture)})`), "fixture recent available");
  await click(`.file-opener-recent[title=${JSON.stringify(fixture)}]`);
  await wait(async () => await evaluate("document.querySelector('#empty-reader').hidden && !document.querySelector('#tab-hosts').hidden"), "banner recent adopted");
  transcript.push({ action: "last-close-banner-recent-open", fixtureSha256: fixtureHash, passed: true });
  assert.equal(hash(await readFile(fixture)), fixtureHash, "Source PDF remains unchanged");
  const image = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(resolve(evidence, "opened.png"), Buffer.from(image.data, "base64"));
  passed = true;
} catch (error) {
  transcript.push({ action: "failure", message: error.message });
  throw error;
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await evaluate("document.querySelector('#empty-reader-open').removeEventListener('click', globalThis.__emptyOpenClickHandler); delete globalThis.__emptyOpenClickHandler; delete globalThis.__emptyOpenClicks").catch(() => {});
    socket.close();
  }
  observer?.stdin.end();
  await writeFile(resolve(evidence, "result.json"), JSON.stringify({ passed, receipt, pid, input: "trusted CDP WebView2 input; native picker cancellation via owned WM_CLOSE", transcript }, null, 2));
  console.log(JSON.stringify({ passed, evidence, scenarios: transcript.length }));
}
