import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hashText = (value) => createHash("sha256").update(value).digest("hex");
// Run against this worktree's already launched npm run preview:worktree candidate.
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 must be set at launch.
// All renderer input below is CDP input; this is not an OS or human keyboard proof.
const [pidArgument, portArgument = "9333"] = process.argv.slice(2);
const pid = Number(pidArgument);
assert(Number.isSafeInteger(pid) && pid > 0, "Usage: node tools/qa/run-password-prompt.mjs <preview-pid> [port]");
const port = Number(portArgument);
assert(Number.isSafeInteger(port) && port > 0 && port < 65_536, "CDP port must be between 1 and 65535");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = resolve(root, ".internal/evidence/password-prompt", new Date().toISOString().replaceAll(":", "-"));
await mkdir(evidence, { recursive: true });

const executable = resolve(root, ".internal/preview-target/debug/modeleaf.exe");
const receiptPath = resolve(root, ".internal/preview-target/preview-receipt.json");
const fixturePaths = {
  locked: resolve(root, "fixtures/pdf/locked.pdf"),
  healthy: resolve(root, "fixtures/pdf/text-3-page.pdf"),
};
let persistencePaths = [];
const gitSourceIdentity = () => {
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).replace(/\r?\n$/u, "");
  const status = git(["status", "--porcelain=v1"]);
  const diff = git(["diff", "--binary", "HEAD"]);
  return {
    branch: git(["branch", "--show-current"]),
    head: git(["rev-parse", "HEAD"]),
    statusSha256: hashText(status),
    diffSha256: hashText(diff),
  };
};
const fixtureNames = Object.fromEntries(Object.entries(fixturePaths).map(([name, path]) => [name, path.slice(root.length + 1).replaceAll("\\", "/")]));
const hashFile = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

let password = "";
const incorrectSentinel = `qa-password-invalid-${pid}-${Date.now()}-${randomBytes(8).toString("hex")}`;
const sanitize = (value, limit = 240) => {
  let text = String(value ?? "").replaceAll("\r", " ").replaceAll("\n", " ").trim();
  if (password.length > 0) text = text.replaceAll(password, "[redacted]");
  text = text.replaceAll(incorrectSentinel, "[redacted]");
  return text.slice(0, limit);
};
const failureText = (error) => sanitize(error instanceof Error ? error.message : "QA failure", 320) || "QA failure";

const ps = (expression) => execFileSync("powershell.exe", ["-NoProfile", "-Command", expression], {
  cwd: root,
  encoding: "utf8",
  timeout: 30_000,
});

const readJson = async (path) => JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
const wait = async (predicate, label, timeout = 15_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch {
      // The renderer can transiently replace the queried element while an open settles.
    }
    await delay(50);
  }
  throw new Error(label);
};

let socket;
let sequence = 0;
const pending = new Map();
const call = (method, params = {}) => new Promise((done, reject) => {
  assert(socket !== undefined, "CDP socket unavailable");
  const id = ++sequence;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`CDP timeout: ${method}`));
  }, 15_000);
  pending.set(id, {
    method,
    done: (result) => { clearTimeout(timer); done(result); },
    reject: (error) => { clearTimeout(timer); reject(error); },
  });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error("CDP renderer evaluation failed");
  return result.result?.value;
};
async function captureClearedScreenshot(name) {
  const sample = await snapshot();
  assert.equal(sample.inputCleared, true, `${name}: screenshot requires cleared password input`);
  const image = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(resolve(evidence, `${name}.png`), Buffer.from(image.data, "base64"));
  return `${name}.png`;
}

const keyCodes = {
  Escape: 0x1b,
  Enter: 0x0d,
  Tab: 0x09,
  Backspace: 0x08,
};
const modifiersFor = ({ ctrl = false, alt = false, meta = false, shift = false } = {}) =>
  (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
async function dispatchKey(name, options = {}) {
  const letter = /^[a-z]$/iu.test(name);
  const key = letter ? (options.shift ? name.toUpperCase() : name.toLowerCase()) : name;
  const code = letter ? `Key${name.toUpperCase()}` : name;
  const params = {
    key,
    code,
    windowsVirtualKeyCode: keyCodes[name] ?? name.toUpperCase().charCodeAt(0),
    nativeVirtualKeyCode: keyCodes[name] ?? name.toUpperCase().charCodeAt(0),
    modifiers: modifiersFor(options),
  };
  if (letter && !options.ctrl && !options.alt && !options.meta) params.text = key;
  await call("Input.dispatchKeyEvent", { type: "keyDown", ...params });
  await call("Input.dispatchKeyEvent", { type: "keyUp", ...params });
}
async function click(selector) {
  const point = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
  })()`);
  assert(point && point.width > 0 && point.height > 0 && Number.isFinite(point.x) && Number.isFinite(point.y), `CDP target unavailable: ${selector}`);
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
}

const snapshotRaw = () => evaluate(`(() => {
  const dialog = document.querySelector("#password-dialog");
  const input = document.querySelector("#password-input");
  const error = document.querySelector("#password-error");
  const open = document.querySelector("#password-open");
  const cancel = document.querySelector("#password-cancel");
  const active = document.activeElement;
  const selected = document.querySelector("#tab-strip [role=tab][aria-selected='true']");
  const activeKind = active instanceof HTMLElement
    ? (active.closest(".tab-host") ? "tab-host" : active.id || (active.closest("#password-dialog") ? "password-dialog-descendant" : active.tagName.toLowerCase()))
    : null;
  return {
    dialogOpen: dialog instanceof HTMLDialogElement && dialog.open,
    dialogPresent: dialog !== null,
    controlsPresent: {
      input: input?.id === "password-input",
      error: error?.id === "password-error",
      open: open?.id === "password-open",
      cancel: cancel?.id === "password-cancel",
    },
    inputType: input instanceof HTMLInputElement ? input.type : null,
    inputFocused: active === input,
    inputCleared: input instanceof HTMLInputElement ? input.value.length === 0 : false,
    inputDisabled: input instanceof HTMLInputElement ? input.disabled : true,
    errorVisible: error instanceof HTMLElement ? !error.hidden : false,
    inputInvalid: input?.getAttribute("aria-invalid") === "true",
    describedByError: input?.getAttribute("aria-describedby") === "password-error",
    openDisabled: open instanceof HTMLButtonElement ? open.disabled : true,
    cancelDisabled: cancel instanceof HTMLButtonElement ? cancel.disabled : true,
    activeKind,
    selectedTab: selected?.getAttribute("title") ?? selected?.textContent ?? null,
    activePage: document.querySelector(".tab-host:not([hidden]) .pdf-page-frame[data-active-page='true']")?.getAttribute("data-page") ?? null,
    scrollTop: document.querySelector(".tab-host:not([hidden])")?.scrollTop ?? 0,
    scrollLeft: document.querySelector(".tab-host:not([hidden])")?.scrollLeft ?? 0,
    tabCount: document.querySelectorAll("#tab-strip [role=tab]").length,
    selectedTabCount: document.querySelectorAll("#tab-strip [role=tab][aria-selected='true']").length,
    emptyVisible: !(document.querySelector("#empty-reader") instanceof HTMLElement) || !document.querySelector("#empty-reader").hidden,
    renderedPages: document.querySelectorAll(".tab-host:not([hidden]) .pdf-page-frame").length,
    openDialogs: [...document.querySelectorAll("dialog[open]")].map((element) => element.id).filter(Boolean),
    status: document.querySelector("#status")?.textContent ?? "",
  };
})()`);
const snapshot = async () => {
  const raw = await snapshotRaw();
  return { ...raw, selectedTab: sanitize(raw.selectedTab), status: sanitize(raw.status) };
};

function axProperty(node, name) {
  const property = (node.properties ?? []).find((entry) => entry.name === name);
  return property?.value?.value;
}
function sanitizeAxTree(tree) {
  const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
  return nodes.slice(0, 20).map((node) => ({
    role: typeof node.role?.value === "string" ? node.role.value : "",
    name: sanitize(node.name?.value, 120),
    focused: axProperty(node, "focused") === true,
    disabled: axProperty(node, "disabled") === true,
    modal: axProperty(node, "modal") === true,
  }));
}
async function axFor(selector) {
  const documentNode = await call("DOM.getDocument", { depth: 1 });
  const nodeId = (await call("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector })).nodeId;
  if (!nodeId) return [];
  return sanitizeAxTree(await call("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: true }));
}
async function passwordAxSemantics() {
  // DOM.getDocument resets frontend node IDs; do not race independent AX lookups.
  const dialog = await axFor("#password-dialog");
  const input = await axFor("#password-input");
  const open = await axFor("#password-open");
  const cancel = await axFor("#password-cancel");
  const first = (nodes, roles = []) => nodes.find((node) => roles.length === 0 || roles.includes(node.role)) ?? nodes[0] ?? null;
  return {
    dialog: first(dialog, ["dialog"]),
    input: first(input, ["textbox", "input", "textField"]),
    open: first(open, ["button"]),
    cancel: first(cancel, ["button"]),
    valuesOmitted: true,
  };
}

async function nativeInvoke(command, args = {}) {
  return evaluate(`(async () => {
    const bridge = globalThis.__TAURI_INTERNALS__;
    if (!bridge || typeof bridge.invoke !== "function") throw new Error("TAURI_INVOKE_UNAVAILABLE");
    return bridge.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)});
  })()`);
}
async function pendingIngressCount() {
  const value = await nativeInvoke("list_pending_open_ingress");
  assert(Array.isArray(value), "Native ingress list contract invalid");
  return value.length;
}

const transientChildren = new Set();
function childResult(child, label) {
  return new Promise((done, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} secondary instance did not settle`));
    }, 15_000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else done(value);
    };
    child.once("error", (error) => finish(new Error(`${label} secondary instance failed`), undefined));
    child.once("exit", (code, signal) => finish(null, { code, signal }));
  });
}
async function launchSecondary(path, label) {
  const child = spawn(executable, [path], { cwd: root, stdio: "ignore", windowsHide: true });
  transientChildren.add(child);
  try {
    const result = await childResult(child, label);
    assert.equal(result.signal, null, `${label} secondary instance was signalled`);
    assert.equal(result.code, 0, `${label} secondary instance exit code was not zero`);
    return { label, settled: true, exitCode: result.code };
  } finally {
    if (child.exitCode !== null || child.signalCode !== null) transientChildren.delete(child);
  }
}

async function loadFixturePassword() {
  const generator = await readFile(resolve(root, "tools/fixtures/generate-adversarial-pdfs.mjs"), "utf8");
  const match = /(?:^|\n)\s*const PASSWORD\s*=\s*(["'])(.*?)\1/u.exec(generator);
  assert(match?.[2], "Fixture password source is unavailable");
  return match[2];
}

async function persistenceSentinelPresent(value) {
  const needle = Buffer.from(value, "utf8");
  for (const path of persistencePaths) {
    try {
      if ((await readFile(path)).includes(needle)) return true;
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error("Persistence read failed");
    }
  }
  return false;
}

function postOwnedWindowClose(ownerPid) {
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ModeleafPasswordQaClose {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lparam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
  public static IntPtr Find(uint owner) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hwnd, _) => {
      uint processId;
      GetWindowThreadProcessId(hwnd, out processId);
      if (processId == owner && found == IntPtr.Zero) found = GetAncestor(hwnd, 2);
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$hwnd = [ModeleafPasswordQaClose]::Find([uint32]${ownerPid})
if ($hwnd -eq [IntPtr]::Zero) { throw 'Owned Modeleaf window unavailable' }
if (-not [ModeleafPasswordQaClose]::PostMessageW($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Owned WM_CLOSE post failed' }
`;
  ps(script);
}
function waitOwnedProcessExit(ownerPid) {
  const script = `
$deadline = [DateTime]::UtcNow.AddSeconds(15)
while ($null -ne (Get-Process -Id ${ownerPid} -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
if ($null -ne (Get-Process -Id ${ownerPid} -ErrorAction SilentlyContinue)) { throw 'Modeleaf did not exit after WM_CLOSE' }
`;
  ps(script);
}

let receipt;
let sourceIdentity;
let executableHash;
let processInfo;
let page;
let fixtureHashesBefore;
let fixtureHashesAfter;
let persistence;
let closeObserved = false;
let primaryVerified = false;
let failure;
const scenarios = [];
const secondary = [];

try {
  receipt = await readJson(receiptPath);
  assert.equal(receipt.kind, "standalone-tauri-debug-no-bundle", "Preview receipt kind is not standalone");
  executableHash = await hashFile(executable);
  assert.equal(executableHash, receipt.executableSha256, "Preview executable does not match its receipt");
  processInfo = JSON.parse(ps(`$p=Get-Process -Id ${pid}; [pscustomobject]@{path=$p.Path;workingSet=$p.WorkingSet64} | ConvertTo-Json -Compress`));
  assert.equal(String(processInfo.path).toLowerCase(), executable.toLowerCase(), "Preview PID is not the isolated candidate executable");
  primaryVerified = true;

  fixtureHashesBefore = Object.fromEntries(await Promise.all(Object.entries(fixturePaths).map(async ([name, path]) => [name, await hashFile(path)])));
  const manifest = await readJson(resolve(root, "fixtures/manifest.json"));
  for (const [name, hash] of Object.entries(fixtureHashesBefore)) {
    const entry = manifest.files?.find((candidate) => candidate.name === `${name === "locked" ? "locked" : "text-3-page"}.pdf`);
    assert.equal(entry?.sha256, hash, `${name} fixture does not match its manifest`);
  }
  sourceIdentity = gitSourceIdentity();
  assert.equal(receipt.branch, sourceIdentity.branch, "Preview receipt branch is stale");
  assert.equal(receipt.source?.head, sourceIdentity.head, "Preview receipt HEAD is stale");
  assert.equal(receipt.source?.statusSha256, sourceIdentity.statusSha256, "Preview receipt worktree status is stale");
  assert.equal(receipt.source?.diffSha256, sourceIdentity.diffSha256, "Preview receipt worktree diff is stale");
  const tauriConfig = await readJson(resolve(root, "src-tauri/tauri.conf.json"));
  const nativeSource = await readFile(resolve(root, "src-tauri/src/lib.rs"), "utf8");
  assert(typeof tauriConfig.identifier === "string" && tauriConfig.identifier.length > 0, "Tauri identifier unavailable");
  assert(nativeSource.includes("app_config_directory.join(\"config.toml\")") && nativeSource.includes("app_local_data_directory.join(\"state.json\")") && nativeSource.includes("app_local_data_directory.join(\"diagnostics\")"), "Tauri persistence paths unavailable");
  const appRoots = [process.env.LOCALAPPDATA, process.env.APPDATA].filter((directory) => typeof directory === "string" && directory.length > 0).map((directory) => join(directory, tauriConfig.identifier));
  assert(appRoots.length > 0, "Tauri application data roots unavailable");
  persistencePaths = appRoots.flatMap((appRoot) => [
    join(appRoot, "state.json"), join(appRoot, "state.json.bak"), join(appRoot, "config.toml"), join(appRoot, "config.toml.bak"),
    join(appRoot, "diagnostics", "diagnostics.jsonl"), join(appRoot, "diagnostics", "diagnostics.jsonl.1"), join(appRoot, "diagnostics", "diagnostics.jsonl.2"), join(appRoot, "diagnostics", "diagnostics.jsonl.3"),
  ]);
  persistence = { before: await persistenceSentinelPresent(incorrectSentinel) };
  assert.equal(persistence.before, false, "Incorrect sentinel was already persisted");
  password = await loadFixturePassword();

  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  page = pages.find((entry) => entry.type === "page" && entry.url.startsWith("http://tauri.localhost"));
  assert(page?.webSocketDebuggerUrl, "Native Tauri WebView target unavailable");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = () => reject(new Error("CDP connection failed")); });
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`CDP ${request.method}: ${sanitize(message.error.message)}`));
    else request.done(message.result);
  };
  socket.onclose = () => {
    for (const request of pending.values()) request.reject(new Error("WebView disconnected"));
    pending.clear();
  };
  await call("DOM.enable");
  await call("Accessibility.enable");
  await call("Page.enable");

  const prompt = async (label) => {
    let sample;
    await wait(async () => {
      sample = await snapshot();
      return sample.dialogOpen && sample.dialogPresent && Object.values(sample.controlsPresent).every(Boolean);
    }, label);
    assert.equal(sample.inputType, "password", `${label}: password input type`);
    assert(sample.openDialogs.includes("password-dialog"), `${label}: password dialog is not the only modal owner`);
    return sample;
  };
  const documentReady = async (name, label) => {
    let sample;
    await wait(async () => {
      sample = await snapshot();
      return !sample.dialogOpen && sample.selectedTab === name && sample.renderedPages > 0;
    }, label, 20_000);
    assert.equal(sample.selectedTabCount, 1, `${label}: selected tab cardinality`);
    return sample;
  };
  const emptyReady = async (label) => {
    let sample;
    await wait(async () => {
      sample = await snapshot();
      return !sample.dialogOpen && sample.emptyVisible && sample.tabCount === 0;
    }, label);
    return sample;
  };
  const submitPassword = async (value, label, incorrect = false, viaButton = false) => {
    await click("#password-input");
    await dispatchKey("a", { ctrl: true });
    await dispatchKey("Backspace");
    assert.equal(await evaluate("document.querySelector('#password-input')?.value.length === 0"), true, `${label}: input did not clear before entry`);
    await call("Input.insertText", { text: value });
    const inputReceived = await evaluate("document.querySelector('#password-input')?.value.length > 0");
    assert.equal(inputReceived, true, `${label}: CDP input was not received`);
    if (viaButton) await click("#password-open"); else await dispatchKey("Enter");
    if (incorrect) {
      let sample;
      await wait(async () => {
        sample = await snapshot();
        return sample.dialogOpen && sample.errorVisible && sample.inputCleared && !sample.inputDisabled;
      }, label);
      assert.equal(sample.inputInvalid, true, `${label}: invalid state`);
      assert.equal(sample.describedByError, true, `${label}: described-by state`);
      return { ...sample, inputReceived };
    }
    await wait(async () => !(await snapshot()).dialogOpen, label);
    const after = await snapshot();
    return { ...after, inputReceived };
  };
  const modalSemantics = async (label) => {
    const dom = await prompt(label);
    assert.equal(dom.inputFocused, true, `${label}: input focus`);
    assert.equal(dom.inputCleared, true, `${label}: input must start cleared`);
    const ax = await passwordAxSemantics();
    assert.equal(ax.valuesOmitted, true, `${label}: AX values must be omitted`);
    assert(ax.dialog?.role === "dialog" || ax.dialog?.name === "Enter the password", `${label}: AX dialog semantics`);
    assert(ax.input?.name === "Enter the password" || ax.input?.role === "textbox" || ax.input?.role === "input", `${label}: AX password semantics`);
    assert(ax.open?.role === "button" && ax.cancel?.role === "button", `${label}: AX action semantics`);
    return { dom, ax };
  };
  const blockedModalShortcuts = async () => {
    const before = await prompt("modal shortcut baseline");
    const focusTargets = [];
    for (const [label, name, options] of [
      ["N", "n", { shift: true }],
      ["P", "p", { shift: true }],
      ["Ctrl+O", "o", { ctrl: true }],
      ["Ctrl+Shift+O", "o", { ctrl: true, shift: true }],
      ["Ctrl+W", "w", { ctrl: true }],
    ]) {
      await dispatchKey(name, options);
      const sample = await snapshot();
      focusTargets.push({ key: label, active: sample.activeKind });
      assert.equal(sample.dialogOpen, true, `${label} closed the password dialog`);
      assert.equal(sample.tabCount, before.tabCount, `${label} changed tab count during password modal`);
      assert.equal(sample.selectedTab, before.selectedTab, `${label} changed active document during password modal`);
      assert.deepEqual(sample.openDialogs, ["password-dialog"], `${label} opened another dialog`);
    }
    for (let index = 0; index < 4; index += 1) {
      await dispatchKey("Tab");
      const sample = await snapshot();
      focusTargets.push({ key: "Tab", active: sample.activeKind });
      assert.equal(sample.dialogOpen, true, "Tab escaped the password modal");
      assert(["password-input", "password-open", "password-cancel", "password-dialog-descendant"].includes(sample.activeKind), "Tab focus escaped password controls");
    }
    scenarios.push({ name: "modal-shortcut-blocking", passed: true, tabCount: before.tabCount, focusTargets });
  };

  const initialPrompt = await modalSemantics("initial password prompt");
  const initialScreenshot = await captureClearedScreenshot("initial-password-modal");
  scenarios.push({ name: "initial-prompt-ax-focus", passed: true, screenshot: initialScreenshot, assertions: { dialogOpen: initialPrompt.dom.dialogOpen, inputFocused: initialPrompt.dom.inputFocused, inputCleared: initialPrompt.dom.inputCleared, controlsPresent: initialPrompt.dom.controlsPresent }, ax: { dialogRole: initialPrompt.ax.dialog?.role ?? null, dialogName: initialPrompt.ax.dialog?.name ?? null, inputRole: initialPrompt.ax.input?.role ?? null, inputName: initialPrompt.ax.input?.name ?? null, openRole: initialPrompt.ax.open?.role ?? null, cancelRole: initialPrompt.ax.cancel?.role ?? null, valuesOmitted: true } });
  const initialCorrect = await submitPassword(password, "first correct password", false, true);
  const initialDocument = await documentReady("locked.pdf", "first correct password opens locked fixture");
  scenarios.push({ name: "first-correct-opens", passed: true, document: initialDocument, inputReceived: initialCorrect.inputReceived, clearedAfterSubmit: initialCorrect.inputCleared });

  await dispatchKey("w", { ctrl: true });
  const emptyAfterClose = await emptyReady("close initial document before start-cancel case");
  await launchSecondary(fixturePaths.locked, "start-cancel").then((result) => secondary.push(result));
  await prompt("start-cancel password prompt");
  await dispatchKey("Escape");
  const startCancelled = await emptyReady("Escape restores empty start state");
  scenarios.push({ name: "escape-start-restoration", passed: true, before: emptyAfterClose, after: startCancelled });

  await launchSecondary(fixturePaths.locked, "reopen-before-prior").then((result) => secondary.push(result));
  await prompt("reopen-before-prior password prompt");
  await submitPassword(password, "reopen-before-prior correct password");
  await documentReady("locked.pdf", "reopen-before-prior document");
  await launchSecondary(fixturePaths.healthy, "healthy-prior").then((result) => secondary.push(result));
  await documentReady("text-3-page.pdf", "healthy prior document");
  await dispatchKey("n");
  let healthyView;
  await wait(async () => { healthyView = await snapshot(); return healthyView.activePage === "2"; }, "healthy prior page two", 10_000);

  await launchSecondary(fixturePaths.locked, "wrong-password-retry").then((result) => secondary.push(result));
  await modalSemantics("wrong-password retry prompt");
  await blockedModalShortcuts();
  const beforeExternalIngress = await snapshot();
  const pendingBeforeExternal = await pendingIngressCount();
  await launchSecondary(fixturePaths.healthy, "external-modal-ingress").then((result) => secondary.push(result));
  await delay(300);
  await wait(async () => (await pendingIngressCount()) <= pendingBeforeExternal, "external ingress rejection settled", 10_000);
  const pendingAfterExternal = await pendingIngressCount();
  assert.equal(pendingAfterExternal, pendingBeforeExternal, "External ingress changed pending native request count");
  const afterExternalIngress = await snapshot();
  assert.equal(afterExternalIngress.dialogOpen, true, "External ingress dismissed the password modal");
  assert.equal(afterExternalIngress.tabCount, beforeExternalIngress.tabCount, "External ingress changed tab count during password modal");
  assert.equal(afterExternalIngress.selectedTab, beforeExternalIngress.selectedTab, "External ingress changed active document during password modal");
  scenarios.push({ name: "external-ingress-rejected-without-replay", passed: true, pendingBefore: pendingBeforeExternal, pendingAfter: pendingAfterExternal, before: beforeExternalIngress, after: afterExternalIngress });

  const wrongAttempts = [];
  let incorrectScreenshot;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const result = await submitPassword(incorrectSentinel, `wrong password attempt ${attempt}`, true);
    wrongAttempts.push({ attempt, inputReceived: result.inputReceived, errorVisible: result.errorVisible, inputCleared: result.inputCleared, inputInvalid: result.inputInvalid, describedByError: result.describedByError });
    if (attempt === 1) incorrectScreenshot = await captureClearedScreenshot("incorrect-password-cleared");
  }
  persistence.afterWrong = await persistenceSentinelPresent(incorrectSentinel);
  assert.equal(persistence.afterWrong, false, "Incorrect password sentinel was persisted");
  const retryCorrect = await submitPassword(password, "correct password after six wrong attempts");
  const reopenedDocument = await documentReady("locked.pdf", "correct password after six wrong attempts opens");
  await delay(750);
  const afterRejectedReplay = await snapshot();
  assert.equal(afterRejectedReplay.selectedTab, "locked.pdf", "Rejected external ingress replayed after password success");
  assert.equal(afterRejectedReplay.tabCount, beforeExternalIngress.tabCount, "Rejected external ingress added a tab after password success");
  scenarios.push({ name: "six-wrong-then-correct", passed: true, screenshot: incorrectScreenshot, attempts: wrongAttempts, document: reopenedDocument, inputReceived: retryCorrect.inputReceived, clearedAfterSubmit: retryCorrect.inputCleared, noReplay: true });

  // Move to the healthy tab so cancellation has a real prior-document owner to restore.
  await dispatchKey("p", { shift: true });
  const healthyFocused = await documentReady("text-3-page.pdf", "select healthy prior document");
  await launchSecondary(fixturePaths.locked, "prior-cancel").then((result) => secondary.push(result));
  const priorPrompt = await modalSemantics("prior-document cancel prompt");
  await click("#password-cancel");
  const priorRestored = await documentReady("text-3-page.pdf", "Cancel restores prior document");
  assert.equal(priorRestored.tabCount, healthyFocused.tabCount, "Cancel did not remove the staged password candidate");
  assert.equal(priorRestored.activeKind, "tab-host", "Cancel did not restore reader focus");
  assert.equal(priorRestored.activePage, healthyView.activePage, "Cancel did not restore the prior page");
  assert(Math.abs(priorRestored.scrollTop - healthyView.scrollTop) <= 1, "Cancel did not restore the prior viewport");
  scenarios.push({ name: "cancel-prior-document-restoration", passed: true, prompt: { dialogOpen: priorPrompt.dom.dialogOpen, inputFocused: priorPrompt.dom.inputFocused, inputCleared: priorPrompt.dom.inputCleared }, restored: { selectedTab: priorRestored.selectedTab, tabCount: priorRestored.tabCount, activePage: priorRestored.activePage, scrollTop: priorRestored.scrollTop, activeKind: priorRestored.activeKind } });
  // Bound document cleanup before exercising native WM_CLOSE with a pending password prompt.
  const tabsBeforeClose = (await snapshot()).tabCount;
  let closeCount = 0;
  while ((await snapshot()).tabCount > 0) {
    if (++closeCount > tabsBeforeClose) throw new Error("Document close loop exceeded bounded tab count");
    const beforeClose = await snapshot();
    await dispatchKey("w", { ctrl: true });
    await wait(async () => (await snapshot()).tabCount < beforeClose.tabCount, "close document before native window close", 10_000);
  }
  await emptyReady("empty state before pending native window close");
  await launchSecondary(fixturePaths.locked, "window-close-pending").then((result) => secondary.push(result));
  const pendingClosePrompt = await prompt("pending native window close password prompt");
  scenarios.push({ name: "native-wm-close-with-pending-password", passed: true, assertions: { dialogOpen: pendingClosePrompt.dialogOpen, inputFocused: pendingClosePrompt.inputFocused, inputCleared: pendingClosePrompt.inputCleared } });
  postOwnedWindowClose(pid);
  waitOwnedProcessExit(pid);
  closeObserved = true;
} catch (error) {
  failure = failureText(error);
} finally {
  password = "";
  for (const child of transientChildren) {
    try {
      await childResult(child, "owned secondary instance cleanup");
    } catch {
      failure ??= "owned secondary instance did not settle";
    }
  }
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  for (const request of pending.values()) request.reject(new Error("CDP connection closed"));
  pending.clear();
  try {
    fixtureHashesAfter = Object.fromEntries(await Promise.all(Object.entries(fixturePaths).map(async ([name, path]) => [name, await hashFile(path)])));
    if (fixtureHashesBefore !== undefined && JSON.stringify(fixtureHashesBefore) !== JSON.stringify(fixtureHashesAfter)) failure ??= "Source fixture SHA-256 changed";
  } catch {
    failure ??= "Source fixture hash could not be verified after the run";
  }
  if (persistence !== undefined) {
    try {
      persistence.after = await persistenceSentinelPresent(incorrectSentinel);
      if (persistence.after) failure ??= "Incorrect password sentinel was persisted";
    } catch {
      failure ??= "Persistence sentinel check failed";
    }
  }
  if (primaryVerified && !closeObserved) {
    try {
      postOwnedWindowClose(pid);
      waitOwnedProcessExit(pid);
      closeObserved = true;
    } catch {
      failure ??= "Native WM_CLOSE did not settle the candidate process";
    }
  }
  const report = {
    schemaVersion: 1,
    kind: "native-preview-webview2-password-prompt-regression",
    status: failure === undefined && closeObserved ? "passed" : "failed",
    command: `node tools/qa/run-password-prompt.mjs ${pid} ${port}`,
    candidate: {
      pid,
      port,
      pageUrl: page?.url ?? null,
      executable,
      executableHash: executableHash ?? null,
      processInfo: processInfo ?? null,
      receipt: receipt ?? null,
      sourceIdentity: sourceIdentity ?? null,
      closeObserved,
    },
    fixtures: {
      paths: fixtureNames,
      before: fixtureHashesBefore ?? null,
      after: fixtureHashesAfter ?? null,
      unchanged: fixtureHashesBefore !== undefined && JSON.stringify(fixtureHashesBefore) === JSON.stringify(fixtureHashesAfter),
    },
    persistence: persistence ?? { before: null, after: null },
    secondaryInstances: secondary,
    scenarios,
    unsupportedChecks: ["OS/human keyboard delivery", "installed-release-package behavior"],
    limitations: [
      "CDP Input.dispatchKeyEvent/Input.insertText and CDP mouse input are trusted WebView input, not OS or human keyboard verification.",
      "The candidate is the isolated debug preview executable, not an installed release package.",
      "The bounded persistence check inspects the expected Tauri state, config, and diagnostics paths for the exact injected sentinel without recording values or file contents.",
    ],
    failure: failure ?? null,
  };
  try {
    await writeFile(resolve(evidence, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  } catch {
    failure ??= "Evidence write failed";
  }
  console.log(evidence);
}
if (failure !== undefined) throw new Error("Password prompt regression failed");
