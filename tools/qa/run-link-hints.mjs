import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Run against this worktree's already launched npm run preview:worktree candidate.
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 must be set at launch.
// Every renderer input below is CDP input. It is trusted WebView input, not a human or OS/native keyboard proof.
const [pidArgument, portArgument = "9333"] = process.argv.slice(2);
const pid = Number(pidArgument);
assert(Number.isSafeInteger(pid) && pid > 0, "Usage: node tools/qa/run-link-hints.mjs <preview-pid> [port]");
const port = Number(portArgument);
assert(Number.isSafeInteger(port) && port > 0 && port < 65_536, "CDP port must be between 1 and 65535");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = resolve(root, ".internal/preview-target/debug/modeleaf.exe");
const receiptPath = resolve(root, ".internal/preview-target/preview-receipt.json");
const evidence = resolve(root, ".internal/evidence/link-hints", new Date().toISOString().replaceAll(":", "-"));
await mkdir(evidence, { recursive: true });

const fixturePaths = {
  links: resolve(root, "fixtures/pdf/links.pdf"),
  duplicates: resolve(root, "fixtures/pdf/link-duplicates.pdf"),
  landing: resolve(root, "fixtures/pdf/link-landing-3-page.pdf"),
};
const fixtureNames = Object.fromEntries(Object.entries(fixturePaths).map(([name, path]) => [
  name,
  path.slice(root.length + 1).replaceAll("\\", "/"),
]));
const expectedFixtureHashes = {
  links: "dd5e2d598fa9e0bcae25e488541a898220d38b791991bc95796d7ba5f30044d4",
  duplicates: "ac62a9e27b4084a928407e5a1f6ac2448fcb845a846c2383adeac9571a7aa2da",
  landing: "ad70f508a6d012d891cd2f73fc2dde456f6b17bdd33e47464a3cf708a8b3a748",
};
// links.pdf has three actionable occurrences; duplicates coalesces only exact source-page/geometry/target matches.
const expectedCandidateCounts = { links: 3, duplicates: 4, landing: 3 };
const textOnlySentinel = "https://example.invalid/text-only-url";
const allowedExternalUrl = "https://example.invalid/allowed";

const hashText = (value) => createHash("sha256").update(value).digest("hex");
const hashFile = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const readJson = async (path) => JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/u, ""));
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const ps = (expression) => execFileSync("powershell.exe", ["-NoProfile", "-Command", expression], {
  cwd: root,
  encoding: "utf8",
  timeout: 30_000,
});
const sanitize = (value, limit = 320) => {
  let text = String(value ?? "").replaceAll("\r", " ").replaceAll("\n", " ").trim();
  text = text.replaceAll(root, "<worktree>");
  text = text.replace(/https?:\/\/[^\s)]+/giu, "[url]");
  text = text.replace(/file:\/\/[^\s)]+/giu, "[path]");
  return text.slice(0, limit);
};
const failureText = (error) => sanitize(error instanceof Error ? error.message : "QA failure") || "QA failure";

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

const wait = async (predicate, label, timeout = 20_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch {
      // The renderer can replace a page or tab while an open settles.
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
  }, 20_000);
  pending.set(id, {
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

const keyCodes = { Enter: 0x0d, Escape: 0x1b, Backspace: 0x08 };
const modifiersFor = ({ ctrl = false, alt = false, meta = false, shift = false } = {}) =>
  (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
const focusReader = async () => {
  await evaluate("document.querySelector('.tab-host:not([hidden])')?.focus({preventScroll:true})");
};
async function dispatchKey(name, options = {}) {
  await focusReader();
  const letter = /^[a-z]$/iu.test(name);
  const key = letter ? (options.shift || name === name.toUpperCase() ? name.toUpperCase() : name.toLowerCase()) : name;
  const code = letter ? `Key${name.toUpperCase()}` : name;
  const virtualKey = keyCodes[name] ?? name.toUpperCase().charCodeAt(0);
  const params = {
    key,
    code,
    windowsVirtualKeyCode: virtualKey,
    nativeVirtualKeyCode: virtualKey,
    modifiers: modifiersFor(options),
    autoRepeat: options.autoRepeat === true || options.repeat === true,
  };
  if (letter && !options.ctrl && !options.alt && !options.meta) params.text = key;
  await call("Input.dispatchKeyEvent", { type: "keyDown", ...params });
  await call("Input.dispatchKeyEvent", { type: "keyUp", ...params, autoRepeat: false });
}
async function dispatchRepeatEnter() {
  await focusReader();
  const params = {
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: keyCodes.Enter,
    nativeVirtualKeyCode: keyCodes.Enter,
    modifiers: 0,
    autoRepeat: true,
  };
  // A repeat key-down is intentionally the only Enter sent for a valid external URL.
  await call("Input.dispatchKeyEvent", { type: "keyDown", ...params });
  await call("Input.dispatchKeyEvent", { type: "keyUp", ...params, autoRepeat: false });
}

async function assertAutoRepeatDelivery() {
  await evaluate(`(() => {
    const state = globalThis.__modeleafLinkHintsQaRepeat ?? { events: [], handler: undefined };
    state.events = [];
    state.handler = (event) => state.events.push({ key: event.key, repeat: event.repeat, isTrusted: event.isTrusted });
    globalThis.__modeleafLinkHintsQaRepeat = state;
    window.addEventListener("keydown", state.handler, true);
  })()`);
  try {
    await dispatchKey("Escape", { autoRepeat: true });
    const observed = await evaluate(`(() => globalThis.__modeleafLinkHintsQaRepeat?.events?.find((event) => event.key === "Escape") ?? null)()`);
    assert(observed?.repeat === true && observed?.isTrusted === true, "CDP autoRepeat was not observed as a trusted repeated key event");
    return observed;
  } finally {
    await evaluate(`(() => {
      const state = globalThis.__modeleafLinkHintsQaRepeat;
      if (state?.handler !== undefined) window.removeEventListener("keydown", state.handler, true);
      delete globalThis.__modeleafLinkHintsQaRepeat;
    })()`);
  }
}
const transientChildren = new Set();
function childResult(child, label) {
  return new Promise((done, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} secondary instance did not settle`));
    }, 20_000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else done(value);
    };
    child.once("error", () => finish(new Error(`${label} secondary instance failed`), undefined));
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
  } finally {
    if (child.exitCode !== null || child.signalCode !== null) transientChildren.delete(child);
  }
}

function postOwnedWindowClose(ownerPid) {
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ModeleafLinkHintsQaClose {
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
$hwnd = [ModeleafLinkHintsQaClose]::Find([uint32]${ownerPid})
if ($hwnd -eq [IntPtr]::Zero) { throw 'Owned Modeleaf window unavailable' }
if (-not [ModeleafLinkHintsQaClose]::PostMessageW($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Owned WM_CLOSE post failed' }
`;
  ps(script);
}
function waitOwnedProcessExit(ownerPid) {
  const script = `
$deadline = [DateTime]::UtcNow.AddSeconds(20)
while ($null -ne (Get-Process -Id ${ownerPid} -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
if ($null -ne (Get-Process -Id ${ownerPid} -ErrorAction SilentlyContinue)) { throw 'Modeleaf did not exit after WM_CLOSE' }
`;
  ps(script);
}

const processSample = () => {
  const value = JSON.parse(ps(`$p=Get-Process -Id ${pid}; [pscustomobject]@{workingSetBytes=[long]$p.WorkingSet64;cpuMilliseconds=[math]::Round($p.TotalProcessorTime.TotalMilliseconds,3)} | ConvertTo-Json -Compress`));
  return { workingSetBytes: Number(value.workingSetBytes), cpuMilliseconds: Number(value.cpuMilliseconds) };
};

const snapshot = () => evaluate(`(() => {
  const host = document.querySelector('.tab-host:not([hidden])');
  const selected = document.querySelector("#tab-strip [role=tab][aria-selected='true']");
  const statusPage = document.querySelector('#status .status-page');
  const fitPage = document.querySelector('#status .status-badge-fit-page');
  const overlay = document.querySelector(".link-hints-overlay[data-link-hints='overlay']");
  const labels = overlay === null ? [] : [...overlay.querySelectorAll('.link-hints-label[data-link-hint-label]')].map((node) => ({
    label: node.getAttribute('data-link-hint-label'),
    candidate: node.getAttribute('data-link-hint-candidate'),
    match: node.getAttribute('data-match'),
    text: node.textContent ?? '',
    rect: (() => { const rect = node.getBoundingClientRect(); return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }; })(),
  }));
  const confirmation = document.querySelector(".link-hints-confirmation[data-link-hints-confirmation='url']");
  const confirmationUrl = confirmation?.querySelector("[data-link-hints-confirmation-url='true']");
  const hostRect = host?.getBoundingClientRect();
  const confirmationRect = confirmation?.getBoundingClientRect();
  const indicator = host?.querySelector(".pdf-destination-indicator");
  const indicatorRect = indicator?.getBoundingClientRect();
  const indicatorFrame = indicator?.closest('.pdf-page-frame');
  const pageText = statusPage?.textContent ?? '';
  const pageParts = /^\\s*(\\d+)\\s*\\/\\s*(\\d+)/u.exec(pageText);
  const frames = host === null ? [] : [...host.querySelectorAll('.pdf-page-frame')];
  const textLayers = host === null ? [] : [...host.querySelectorAll('.textLayer')];
  const annotationLayers = host === null ? [] : [...host.querySelectorAll('.annotationLayer')];
  const canvases = host === null ? [] : [...host.querySelectorAll('canvas')];
  const textOnlyPresent = host?.textContent?.includes(${JSON.stringify(textOnlySentinel)}) === true;
  const hostBounds = hostRect === undefined ? null : { width: hostRect.width, height: hostRect.height };
  return {
    selectedTab: selected?.getAttribute('title') ?? selected?.textContent ?? null,
    tabCount: document.querySelectorAll('#tab-strip [role=tab]').length,
    activePage: host?.querySelector(".pdf-page-frame[data-active-page='true']")?.getAttribute("data-page") ?? null,
    page: pageParts === null ? null : Number(pageParts[1]),
    pageCount: pageParts === null ? null : Number(pageParts[2]),
    status: pageText.slice(0, 160),
    fitPage: fitPage !== null && !fitPage.hidden,
    hostBounds,
    scrollTop: host?.scrollTop ?? 0,
    scrollLeft: host?.scrollLeft ?? 0,
    overlay: overlay === null ? null : {
      text: (overlay.textContent ?? '').slice(0, 320),
      labels,
      rect: (() => { const r = overlay.getBoundingClientRect(); return { left:r.left, top:r.top, width:r.width, height:r.height }; })(),
    },
    confirmation: confirmation === null ? null : {
      urlText: confirmationUrl?.textContent ?? '',
      rect: confirmationRect === undefined ? null : { left: confirmationRect.left, top: confirmationRect.top, width: confirmationRect.width, height: confirmationRect.height },
      hostRect: hostRect === undefined ? null : { left: hostRect.left, top: hostRect.top, width: hostRect.width, height: hostRect.height },
    },
    indicator: indicator === null ? null : {
      className: indicator.className,
      page: indicatorFrame?.getAttribute('data-page') ?? null,
      rect: indicatorRect === undefined ? null : { left: indicatorRect.left, top: indicatorRect.top, width: indicatorRect.width, height: indicatorRect.height },
      styleLeft: indicator instanceof HTMLElement ? indicator.style.left : '',
      styleTop: indicator instanceof HTMLElement ? indicator.style.top : '',
      canvasWidth: indicatorFrame?.querySelector('canvas')?.getBoundingClientRect().width ?? 0,
      canvasHeight: indicatorFrame?.querySelector('canvas')?.getBoundingClientRect().height ?? 0,
    },
    textOnlyPresent,
    resources: {
      frames: frames.length,
      textLayers: textLayers.length,
      annotationLayers: annotationLayers.length,
      canvases: canvases.length,
      ordinaryLinks: host?.querySelectorAll('.pdf-link-overlay').length ?? 0,
    },
  };
})()`);

const assertResourceBounds = (sample, label) => {
  assert(sample.resources.frames > 0, `${label}: no resident PDF page`);
  assert(sample.resources.frames <= 16, `${label}: resident page bound exceeded`);
  assert(sample.resources.textLayers <= 16, `${label}: text-layer bound exceeded`);
  assert(sample.resources.annotationLayers <= 16, `${label}: annotation-layer bound exceeded`);
  assert(sample.resources.canvases <= 16, `${label}: canvas bound exceeded`);
  assert(sample.resources.ordinaryLinks <= 256, `${label}: ordinary link bound exceeded`);
};

const results = [];
const secondary = [];
let receipt;
let sourceIdentity;
let executableHash;
let processInfo;
let page;
let fixtureHashesBefore;
let fixtureHashesAfter;
let failure;
let primaryVerified = false;
let closeObserved = false;
let metricsOverride = false;

try {
  receipt = await readJson(receiptPath);
  assert.equal(receipt.kind, "standalone-tauri-debug-no-bundle", "Preview receipt kind is not standalone");
  executableHash = await hashFile(executable);
  assert.equal(executableHash, receipt.executableSha256, "Preview executable does not match its receipt");
  processInfo = JSON.parse(ps(`$p=Get-Process -Id ${pid}; [pscustomobject]@{path=$p.Path;workingSetBytes=[long]$p.WorkingSet64} | ConvertTo-Json -Compress`));
  assert.equal(String(processInfo.path).toLowerCase(), executable.toLowerCase(), "Preview PID is not the isolated candidate executable");
  primaryVerified = true;

  fixtureHashesBefore = Object.fromEntries(await Promise.all(Object.entries(fixturePaths).map(async ([name, path]) => [name, await hashFile(path)])));
  const manifest = await readJson(resolve(root, "fixtures/manifest.json"));
  for (const [name, hash] of Object.entries(fixtureHashesBefore)) {
    assert.equal(hash, expectedFixtureHashes[name], `${name} fixture SHA-256 binding mismatch`);
    const entry = manifest.files?.find((candidate) => candidate.name === `${name === "links" ? "links" : name === "duplicates" ? "link-duplicates" : "link-landing-3-page"}.pdf`);
    assert.equal(entry?.sha256, expectedFixtureHashes[name], `${name} fixture manifest binding mismatch`);
  }
  sourceIdentity = gitSourceIdentity();
  assert.equal(receipt.branch, sourceIdentity.branch, "Preview receipt branch is stale");
  assert.equal(receipt.source?.head, sourceIdentity.head, "Preview receipt HEAD is stale");
  assert.equal(receipt.source?.statusSha256, sourceIdentity.statusSha256, "Preview receipt worktree status is stale");
  assert.equal(receipt.source?.diffSha256, sourceIdentity.diffSha256, "Preview receipt worktree diff is stale");

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
    if (message.error) request.reject(new Error(`CDP ${message.method ?? "call"} failed`));
    else request.done(message.result);
  };
  socket.onclose = () => {
    for (const request of pending.values()) request.reject(new Error("WebView disconnected"));
    pending.clear();
  };
  await call("Page.enable");

  async function settledDocument(fileName, label) {
    let sample;
    let previous;
    let stable = 0;
    await wait(async () => {
      sample = await snapshot();
      const signature = JSON.stringify([
        sample.selectedTab, sample.activePage, sample.page, sample.pageCount,
        sample.scrollTop, sample.scrollLeft, sample.resources,
      ]);
      const ready = sample.selectedTab === fileName && sample.pageCount !== null && sample.resources.frames > 0;
      stable = ready && signature === previous ? stable + 1 : 0;
      previous = signature;
      return stable >= 5;
    }, label);
    assert(sample.selectedTab === fileName, `${label}: selected tab mismatch`);
    assert(sample.pageCount !== null && sample.pageCount > 0 && sample.pageCount <= 30, `${label}: page count out of bounds`);
    assertResourceBounds(sample, label);
    const process = processSample();
    assert(process.workingSetBytes <= 768 * 1024 * 1024, `${label}: candidate working-set bound exceeded`);
    return { ...sample, process };
  }

  async function openFixture(name) {
    const fileName = fixtureNames[name].split("/").at(-1);
    await launchSecondary(fixturePaths[name], name);
    const opened = await settledDocument(fileName, `${name}: document settled`);
    secondary.push({ fixture: fixtureNames[name], settled: true });
    return opened;
  }

  async function showHints(name) {
    let previousGeometry;
    let stableSamples = 0;
    await wait(async () => {
      const geometry = await evaluate(`JSON.stringify([...document.querySelectorAll('.tab-host:not([hidden]) .pdf-link-overlay[data-link-index]')].map(e => [e.dataset.annotationId, e.getBoundingClientRect().toJSON()]))`);
      stableSamples = geometry !== '[]' && geometry === previousGeometry ? stableSamples + 1 : 0;
      previousGeometry = geometry;
      return stableSamples >= 4;
    }, `${name}: visible annotation authority did not settle`);
    await dispatchKey("f");
    let sample;
    await wait(async () => {
      sample = await snapshot();
      return sample.overlay !== null && sample.overlay.labels.length > 0;
    }, `${name}: hint overlay did not appear`);
    assert.equal(sample.overlay.labels.length, expectedCandidateCounts[name], `${name}: PDF candidate count`);
    assert.equal(sample.overlay.labels[0]?.label?.toLowerCase(), "f", `${name}: first PDF hint label`);
    assert(sample.overlay.labels.every((entry) => typeof entry.label === "string" && /^[a-z]+$/u.test(entry.label)), `${name}: hint label alphabet`);
    assert(sample.overlay.labels.every((entry) => typeof entry.candidate === "string" && entry.candidate.length > 0), `${name}: opaque candidate identity`);
    assert.equal(new Set(sample.overlay.labels.map((entry) => entry.candidate)).size, sample.overlay.labels.length, `${name}: candidate identities are unique`);
    assert(sample.overlay.labels.every((entry) => entry.text.toLocaleLowerCase() === entry.label?.toLocaleUpperCase().toLocaleLowerCase()), `${name}: label text is shell-derived`);
    assertResourceBounds(sample, `${name}: hints`);
    return sample;
  }

  const links = await openFixture("links");
  await dispatchKey("F");
  await wait(async () => (await snapshot()).fitPage, "links: fit-page mode did not settle");
  const linksFit = await snapshot();
  const repeatInput = await assertAutoRepeatDelivery();
  const linksHints = await showHints("links");
  assert.equal(linksHints.textOnlyPresent, true, "links: rendered PDF text sentinel is unavailable");
  assert(!linksHints.overlay.text.includes(textOnlySentinel), "links: text-only URL was inferred as a hint");
  assert.equal(linksHints.resources.ordinaryLinks, 4, "links: PDF.js display annotation count");
  assert.equal(linksHints.overlay.labels.length, 3, "links: only supported PDF annotations receive hints");
  assert.equal(linksHints.fitPage, true, "links: lowercase hint command changed Fit Page");

  const externalLabel = linksHints.overlay.labels[0].label.toLocaleLowerCase();
  await dispatchKey(externalLabel);
  let externalPrompt;
  await wait(async () => {
    externalPrompt = await snapshot();
    return externalPrompt.confirmation !== null;
  }, "links: external confirmation did not appear");
  assert.equal(hashText(externalPrompt.confirmation.urlText), hashText(allowedExternalUrl), "links: confirmation URL is not the PDF annotation URL");
  assert(externalPrompt.confirmation.hostRect !== null && externalPrompt.confirmation.rect !== null, "links: confirmation anchor geometry unavailable");
  const promptRect = externalPrompt.confirmation.rect;
  const hostRect = externalPrompt.confirmation.hostRect;
  const selectedLabel = externalPrompt.overlay?.labels.find((entry) => entry.label?.toLocaleLowerCase() === externalLabel);
  assert(selectedLabel?.rect !== undefined, "links: selected hint geometry unavailable for confirmation anchor");
  assert(promptRect.left >= selectedLabel.rect.left - 16 && promptRect.left <= selectedLabel.rect.left + selectedLabel.rect.width + 64, "links: confirmation popup is not horizontally anchored to the selected hint");
  assert(promptRect.top >= selectedLabel.rect.top + selectedLabel.rect.height - 4, "links: confirmation popup is not below the selected hint");
  assert(promptRect.left >= hostRect.left - 2 && promptRect.top >= hostRect.top - 2, "links: confirmation popup is not anchored inside the reader");
  assert(promptRect.left <= hostRect.left + hostRect.width + 2 && promptRect.top <= hostRect.top + hostRect.height + 2, "links: confirmation popup anchor escaped the reader");
  assert.equal(externalPrompt.tabCount, links.tabCount, "links: external hint changed tab count before confirmation");
  assert.equal(externalPrompt.fitPage, true, "links: external hint changed Fit Page before confirmation");
  const confirmationBeforeRepeat = externalPrompt.confirmation;
  await dispatchRepeatEnter();
  await delay(150);
  const repeatExternal = await snapshot();
  assert(repeatExternal.confirmation !== null, "links: repeated Enter confirmed an external URL");
  assert.equal(repeatExternal.tabCount, externalPrompt.tabCount, "links: repeated Enter changed tab count");
  assert.equal(repeatExternal.fitPage, true, "links: repeated Enter changed Fit Page");
  assert.equal(hashText(repeatExternal.confirmation.urlText), hashText(allowedExternalUrl), "links: repeated Enter changed the confirmation target");
  await dispatchKey("Escape");
  await wait(async () => (await snapshot()).overlay === null && (await snapshot()).confirmation === null, "links: Escape did not cancel external confirmation");
  const linksCancelled = await snapshot();
  assert.equal(linksCancelled.fitPage, true, "links: Escape did not preserve Fit Page");
  results.push({
    fixture: fixtureNames.links,
    settled: { page: links.page, pageCount: links.pageCount, resources: links.resources, process: links.process },
    fitPage: { beforeHints: linksFit.fitPage, whileHints: linksHints.fitPage, afterCancel: linksCancelled.fitPage },
    hints: { count: linksHints.overlay.labels.length, ordinaryLinks: linksHints.resources.ordinaryLinks, textOnlySentinelRendered: linksHints.textOnlyPresent, textOnlyHintAbsent: !linksHints.overlay.text.includes(textOnlySentinel) },
    externalConfirmation: { anchored: true, urlHash: hashText(allowedExternalUrl), repeatInputObserved: repeatInput, noLaunchBeforeConfirmation: true, repeatEnterIgnored: true, escapeCancelled: true, popupWasPresent: confirmationBeforeRepeat !== null },
  });

  await showHints("links");
  const beforeViewportCancel = await snapshot();
  const width = Math.max(320, Math.floor((beforeViewportCancel.hostBounds?.width ?? 900) - 16));
  const height = Math.max(240, Math.floor((beforeViewportCancel.hostBounds?.height ?? 600) - 16));
  try {
    await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    metricsOverride = true;
    await wait(async () => (await snapshot()).overlay === null, "links: viewport change did not cancel hints");
  } finally {
    if (metricsOverride) {
      try { await call("Emulation.clearDeviceMetricsOverride"); } finally { metricsOverride = false; }
    }
  }
  results.push({ fixture: fixtureNames.links, viewportCancellation: { started: true, cancelled: true, baselineLabels: beforeViewportCancel.overlay.labels.length } });

  const duplicates = await openFixture("duplicates");
  await dispatchKey("F");
  await wait(async () => (await snapshot()).fitPage, "duplicates: fit-page mode did not settle");
  const duplicateHints = await showHints("duplicates");
  assert.equal(duplicateHints.textOnlyPresent, true, "duplicates: rendered text-only sentinel");
  assert(!duplicateHints.overlay.text.includes(textOnlySentinel), "duplicates: text-only URL was inferred as a hint");
  assert.equal(duplicateHints.overlay.labels.length, 4, "duplicates: exact-geometry duplicates were not coalesced");
  assert.equal(duplicateHints.resources.ordinaryLinks, 4, "duplicates: display annotation count");
  assert.equal(new Set(duplicateHints.overlay.labels.map((entry) => entry.candidate)).size, 4, "duplicates: opaque identities were not retained per geometry/target group");
  await dispatchKey("Escape");
  await wait(async () => (await snapshot()).overlay === null, "duplicates: Escape did not cancel hints");
  results.push({
    fixture: fixtureNames.duplicates,
    settled: { page: duplicates.page, pageCount: duplicates.pageCount, resources: duplicates.resources, process: duplicates.process },
    hints: { count: duplicateHints.overlay.labels.length, ordinaryLinks: duplicateHints.resources.ordinaryLinks, exactDuplicatesCoalesced: true, adjacentAndWrappedOccurrencesRetained: true, uniqueCandidateIds: true },
  });

  const landing = await openFixture("landing");
  await dispatchKey("F");
  await wait(async () => (await snapshot()).fitPage, "landing: fit-page mode did not settle");
  const landingHints = await showHints("landing");
  assert.equal(landingHints.resources.ordinaryLinks, 3, "landing: display annotation count");
  const landingLabel = landingHints.overlay.labels[0].label.toLocaleLowerCase();
  assert.equal(landing.page, 1, "landing: source page is not page one");
  await dispatchKey(landingLabel);
  let landingResult;
  let indicator;
  await wait(async () => {
    landingResult = await snapshot();
    if (landingResult.indicator !== null) indicator = landingResult.indicator;
    return landingResult.page === 2 && indicator !== undefined;
  }, "landing: internal hint did not reach page two with an indicator", 20_000);
  assert.equal(landingResult.pageCount, 3, "landing: page count changed");
  assert(indicator?.rect !== null && indicator.rect.width > 0 && indicator.rect.height > 0, "landing: actual-coordinate indicator geometry unavailable");
  assert.equal(indicator?.page, "2", "landing: transient indicator is not on the destination page");
  assert(Number.isFinite(indicator?.rect.left) && Number.isFinite(indicator?.rect.top), "landing: transient indicator coordinates are not finite");
  const expectedMarkerX = indicator.canvasWidth * 306 / 612;
  const expectedMarkerY = indicator.canvasHeight * (792 - 40) / 792;
  assert(Math.abs(Number.parseFloat(indicator.styleLeft) - expectedMarkerX) < 1, "landing: marker does not match the explicit PDF x coordinate");
  assert(Math.abs(Number.parseFloat(indicator.styleTop) - expectedMarkerY) < 1, "landing: marker does not match the explicit PDF y coordinate");
  await wait(async () => (await snapshot()).indicator === null, "landing: destination marker did not expire", 3_000);
  assertResourceBounds(landingResult, "landing: settled internal activation");
  await dispatchKey("F");
  await wait(async () => (await snapshot()).fitPage, "landing: Fit Page did not remain available after internal activation");
  const landingAfter = await snapshot();
  results.push({
    fixture: fixtureNames.landing,
    settled: { page: landing.page, pageCount: landing.pageCount, resources: landing.resources, process: landing.process },
    hints: { count: landingHints.overlay.labels.length, ordinaryLinks: landingHints.resources.ordinaryLinks },
    internalLanding: { destinationPage: landingResult.page, indicatorObserved: true, indicatorPage: indicator.page, indicatorGeometry: indicator.rect, requestedPdfPoint: { x: 306, y: 40 }, coordinateVerified: true, expired: true, fitPageAfterActivation: landingAfter.fitPage },
  });
} catch (error) {
  failure = failureText(error);
} finally {
  if (metricsOverride && socket?.readyState === WebSocket.OPEN) {
    try { await call("Emulation.clearDeviceMetricsOverride"); } catch { /* Preserve the original failure. */ }
  }
  for (const child of transientChildren) {
    try { await childResult(child, "owned secondary instance cleanup"); } catch { failure ??= "owned secondary instance did not settle"; }
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
    kind: "native-preview-webview2-pdf-link-hints",
    status: failure === undefined && closeObserved ? "passed" : "failed",
    command: `node tools/qa/run-link-hints.mjs ${pid} ${port}`,
    candidate: {
      pid,
      port,
      pageUrl: page?.url?.startsWith("http://tauri.localhost") ? "http://tauri.localhost" : null,
      executable: ".internal/preview-target/debug/modeleaf.exe",
      executableHash: executableHash ?? null,
      process: processInfo === undefined ? null : { workingSetBytes: Number(processInfo.workingSetBytes) },
      receipt: receipt === undefined ? null : {
        kind: receipt.kind ?? null,
        branch: receipt.branch ?? null,
        executableSha256: receipt.executableSha256 ?? null,
        source: receipt.source === undefined ? null : {
          head: receipt.source.head ?? null,
          statusSha256: receipt.source.statusSha256 ?? null,
          diffSha256: receipt.source.diffSha256 ?? null,
        },
      },
      sourceIdentity: sourceIdentity ?? null,
      closeObserved,
    },
    fixtures: {
      paths: fixtureNames,
      expected: expectedFixtureHashes,
      before: fixtureHashesBefore ?? null,
      after: fixtureHashesAfter ?? null,
      unchanged: fixtureHashesBefore !== undefined && JSON.stringify(fixtureHashesBefore) === JSON.stringify(fixtureHashesAfter),
    },
    secondaryInstances: secondary,
    resourceBounds: {
      maxResidentFrames: 16,
      maxTextLayers: 16,
      maxAnnotationLayers: 16,
      maxCanvases: 16,
      maxOrdinaryLinks: 256,
      maxCandidateWorkingSetBytes: 768 * 1024 * 1024,
    },
    scenarios: results,
    unsupportedChecks: ["Positive external OS launch and shell authorization", "Human or OS keyboard delivery", "Installed-release-package behavior"],
    warnings: [
      "CDP Input.dispatchKeyEvent and Emulation viewport input are trusted WebView input, not human or native OS input.",
      "A nonrepeat Enter was intentionally not dispatched for a valid external URL; native authorization tests own the positive OS-launch contract.",
      "Settled-resource bounds use bounded DOM resident counts and candidate working set; they do not prove browser-wide or OS resource ownership.",
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
if (failure !== undefined) throw new Error(failure);
