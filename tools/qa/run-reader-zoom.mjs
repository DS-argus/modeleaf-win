import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// Isolated real PDF.js/DOM QA. Native authority is mocked by reader-stability.ts.
// No Tauri build, installed-app launch, user profile, print, or manual preview.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = resolve(root, ".internal/evidence/reader-zoom", new Date().toISOString().replaceAll(":", "-"));
const profile = resolve(evidence, "edge-profile");
await mkdir(profile, { recursive: true });
const fixtures = ["fixture-L-text-300.pdf", "print-mixed-rotation-4.pdf"];
const hashes = async () => Object.fromEntries(await Promise.all(fixtures.map(async name => [name, createHash("sha256").update(await readFile(resolve(root, "fixtures/pdf", name))).digest("hex")])));
const beforeHashes = await hashes();
const manifest = JSON.parse(await readFile(resolve(root, "fixtures/manifest.json"), "utf8"));
for (const name of fixtures) assert.equal(beforeHashes[name], manifest.files.find(file => file.name === name)?.sha256);
const server = await createServer({ root, configFile: false, cacheDir: resolve(evidence, "vite-cache"), server: { host: "127.0.0.1", port: 0, open: false, watch: null, hmr: false } });
const transcript = [];
const pending = new Map();
let sequence = 0;
let socket;
let browser;
let browserError;
let browserLog = "";
const delay = ms => new Promise(done => setTimeout(done, ms));
async function deadline(promise, milliseconds, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function call(method, params = {}) {
  transcript.push({ method, params });
  return deadline(new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); }), 60_000, `CDP timeout: ${method}`);
}
async function evaluate(expression) {
  const response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? JSON.stringify(response.exceptionDetails));
  return response.result.value;
}
async function wait(expression) {
  for (let attempt = 0; attempt < 300; attempt++) { if (await evaluate(expression)) return; await delay(100); }
  throw new Error(`Browser condition timed out: ${expression}`);
}
const results = [];
let version;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = spawn("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", ["--headless=new", "--no-first-run", "--disable-extensions", "--disable-background-networking", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
  browser.on("error", error => { browserError = error; });
  for (const stream of [browser.stdout, browser.stderr]) stream.on("data", data => { if (browserLog.length < 100_000) browserLog += data.toString(); });
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (browserError) throw browserError;
    if (browser.exitCode !== null) throw new Error("Owned QA browser exited during startup");
    try { port = Number((await readFile(resolve(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; }
    catch { await delay(100); }
  }
  assert(port, "DevTools port unavailable");
  version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find(entry => entry.type === "page");
  assert(page, "QA page unavailable");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await deadline(new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; }), 10_000, "CDP connect timeout");
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (request) { pending.delete(message.id); if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result); }
  };
  socket.onclose = () => { for (const request of pending.values()) request.reject(new Error("QA browser disconnected")); pending.clear(); };
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  async function open(query = "") {
    await call("Page.navigate", { url: `${origin}/tools/qa/reader-stability.html${query}` });
    await wait("!!window.readerHarness");
  }
  await open("?hidden=true");
  const hidden = await evaluate("({opening:window.readerOpening,reference:window.readerHarness.session.snapshot.reader.fitPageReference})");
  assert.equal(hidden.opening.hiddenOpening, true);
  assert.equal(hidden.opening.opening.mode, "fit-page");
  assert.equal(hidden.reference, 1);
  results.push({ scenario: "zero-to-nonzero opening", result: hidden });
  results.push({ scenario: "300-page continuous forward/end/reverse and disposal", result: await evaluate("window.readerHarness.run()") });

  await open();
  const setup = await evaluate(`(async()=>{
    const h=window.readerHarness; await h.session.synchronizeViewport(0,h.host.clientHeight);
    const code=await(await fetch('/src/main.ts')).text();
    const a=code.indexOf('function bindReaderWheelInput('),b=code.indexOf('function createTab(',a);
    if(a<0||b<=a)throw Error('Production wheel binding missing');
    const bind=new Function(code.slice(a,b)+';return bindReaderWheelInput;')();
    window.wheelQA={settled:0,errors:[]};
    window.wheelQA.dispose=bind(h.host,h.session,()=>true,()=>window.wheelQA.settled++,e=>window.wheelQA.errors.push(String(e)));
    const rect=h.host.querySelector('.pdf-page-frame[data-page="1"] canvas').getBoundingClientRect();
    window.wheelQA.pointer={x:rect.left+rect.width/2,y:rect.top+rect.height/2};
    return {before:h.snapshot(),pointer:window.wheelQA.pointer};
  })()`);
  const wheel = async deltaY => call("Input.dispatchMouseEvent", { type: "mouseWheel", x: setup.pointer.x, y: setup.pointer.y, deltaX: 0, deltaY, modifiers: 2 });
  await wheel(-100);
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 0 });
  await wait("window.wheelQA.settled>=1 || window.wheelQA.errors.length>0");
  const zoom = await evaluate(`(()=>{const h=window.readerHarness,r=h.host.querySelector('.pdf-page-frame[data-page="1"] canvas').getBoundingClientRect();return{after:h.snapshot(),center:{x:r.left+r.width/2,y:r.top+r.height/2},errors:window.wheelQA.errors,browserScale:visualViewport.scale};})()`);
  assert.deepEqual(zoom.errors, []);
  assert.equal(zoom.after.mode, "custom");
  assert(Math.abs(zoom.after.scale - setup.before.scale * 1.1) < 1e-10);
  assert(Math.abs(zoom.center.x - setup.pointer.x) <= 1 && Math.abs(zoom.center.y - setup.pointer.y) <= 1);
  assert.equal(zoom.browserScale, 1);
  results.push({ scenario: "trusted Ctrl-wheel and pointer anchor", setup, result: zoom });
  for (let index = 0; index < 9; index++) await wheel(-10);
  await wait("window.wheelQA.settled>=10");
  assert.equal(await evaluate("window.readerHarness.snapshot().scale"), zoom.after.scale);
  await wheel(-10);
  await wait("window.wheelQA.settled>=11");
  const accumulated = await evaluate("window.readerHarness.snapshot().scale");
  assert(Math.abs(accumulated - zoom.after.scale * 1.1) < 1e-10);
  results.push({ scenario: "ten fractional wheel events form one step", scale: accumulated });
  const burst = await evaluate(`(async()=>{const h=window.readerHarness,p=window.wheelQA.pointer,before=h.snapshot().scale;const outcomes=await Promise.all([1,2,3].map(()=>h.session.handleWheelInput({ctrlKey:true,deltaX:0,deltaY:-100,deltaMode:0,timeStamp:performance.now(),clientX:p.x,clientY:p.y})));return{before,after:h.snapshot().scale,outcomes};})()`);
  assert(Math.abs(burst.after - burst.before * 1.1 ** 3) < 1e-9);
  results.push({ scenario: "bounded latest-target burst", result: burst });
  const plainBefore = await evaluate("window.readerHarness.snapshot()");
  await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: setup.pointer.x, y: setup.pointer.y, deltaX: 0, deltaY: 100, modifiers: 0 });
  await wait(`window.readerHarness.host.scrollTop>${plainBefore.top}`);
  const plainAfter = await evaluate("(async()=>{const h=window.readerHarness;await h.session.synchronizeViewport(h.host.scrollTop,h.host.clientHeight);return h.snapshot();})()");
  assert.equal(plainAfter.scale, plainBefore.scale);
  results.push({ scenario: "trusted plain wheel remains continuous scroll", before: plainBefore, after: plainAfter });
  const screenshot = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(resolve(evidence, "wheel-zoom.png"), Buffer.from(screenshot.data, "base64"));
  await evaluate("(async()=>{window.wheelQA.dispose();await window.readerHarness.session.close();window.readerHarness.resources.assertEmpty();})()");

  await open("?fixture=print-mixed-rotation-4.pdf");
  const mixed = await evaluate(`(async()=>{const h=window.readerHarness;const samples=[];const sample=()=>({...h.snapshot(),reference:h.session.snapshot.reader.fitPageReference,rotation:h.session.snapshot.reader.rotationQuarterTurns});samples.push(sample());await h.session.renderPage(2);samples.push(sample());h.session.apply({type:'view.rotate',quarterTurns:1});await h.session.renderCurrentView();samples.push(sample());h.host.style.height='460px';h.session.invalidateViewportSynchronization();await h.session.renderCurrentView();samples.push(sample());h.session.apply({type:'view.fitPage'});await h.session.renderCurrentView();samples.push(sample());await h.session.close();h.resources.assertEmpty();return samples;})()`);
  assert.equal(mixed[1].scale, mixed[0].scale);
  for (const sample of mixed.slice(0, 4)) assert.equal(sample.reference, 1);
  assert.equal(mixed[2].rotation, 1);
  assert.equal(mixed[4].reference, mixed[4].page);
  results.push({ scenario: "mixed pages fixed reference, resize, rotation and explicit re-fit", result: mixed });
  await call("Emulation.setDeviceMetricsOverride", { width: 1100, height: 800, deviceScaleFactor: 2, mobile: false });
  for (const scenario of ["margin", "gap", "other-page", "rotated-margin"]) {
    await open();
    const anchorResult = await evaluate(`(async()=>{
      const h=window.readerHarness, host=h.host, controller=h.session.pdfReader;
      const scenario=${JSON.stringify(scenario)};
      if(scenario==='rotated-margin'){h.session.apply({type:'view.rotate',quarterTurns:1});await h.session.renderCurrentView();}
      if(scenario==='gap')host.scrollTop=300;
      if(scenario==='other-page')host.scrollTop=350;
      await h.session.synchronizeViewport(host.scrollTop,host.clientHeight);
      const origin=host.getBoundingClientRect();
      const first=host.querySelector('.pdf-page-frame[data-page="1"] canvas').getBoundingClientRect();
      const second=host.querySelector('.pdf-page-frame[data-page="2"] canvas')?.getBoundingClientRect();
      const relative=(x,y)=>({x:x-origin.left-host.clientLeft,y:y-origin.top-host.clientTop});
      const offset=scenario==='gap'?relative(first.left+first.width/2,(first.bottom+second.top)/2)
        :scenario==='other-page'?relative(first.left+first.width/2,150)
        :relative(first.left-20,Math.max(40,Math.min(300,first.bottom-20)));
      const before=controller.capturePointerAnchor(offset);
      if(!before)throw Error('No pointer anchor');
      const activeBefore=h.session.snapshot.reader.page;
      const r=host.querySelector('.pdf-page-frame[data-page="'+before.pageNumber+'"] canvas').getBoundingClientRect();
      const normalized={x:(before.viewportOffset.x-(r.left-origin.left-host.clientLeft))/r.width,y:(before.viewportOffset.y-(r.top-origin.top-host.clientTop))/r.height};
      if(scenario.includes('margin')&&(Math.abs(normalized.x*r.width)>1||Math.abs(scenario==='rotated-margin'?before.pagePoint.y:before.pagePoint.x)>1e-6))throw Error('Margin anchor escaped PDF edge: '+JSON.stringify({scenario,before,normalized}));
      if(scenario==='gap'&&(before.pageNumber!==1||Math.abs((normalized.y-1)*r.height)>1||Math.abs(before.pagePoint.y)>1e-6))throw Error('Gap did not select lower-number nearest edge');
      if(scenario==='other-page'&&activeBefore===before.pageNumber)throw Error('Fixture did not cover pointer page different from active page');
      const diagnostics=[];
      const settle=controller.settlePointerAnchor.bind(controller);
      controller.settlePointerAnchor=async(anchor,guard)=>{const ok=await settle(anchor,guard);diagnostics.push({ok,anchor,landing:controller.captureViewportLandingAtOffset(anchor.pageNumber,anchor.viewportOffset),reachable:controller.resolveReachableViewportLanding(anchor),scrollTop:host.scrollTop,scale:h.snapshot().scale});return ok;};
      try {if(!await h.session.zoomAt(1,offset))throw Error('Pointer zoom failed');}
      catch(error){throw Error(String(error)+' '+JSON.stringify({scenario,diagnostics}));}
      const after=host.querySelector('.pdf-page-frame[data-page="'+before.pageNumber+'"] canvas').getBoundingClientRect();
      const clamp=(x,max)=>Math.max(0,Math.min(max,x));
      const expectedLeft=clamp(after.left-origin.left-host.clientLeft+host.scrollLeft+normalized.x*after.width-before.viewportOffset.x,host.scrollWidth-host.clientWidth);
      const expectedTop=clamp(after.top-origin.top-host.clientTop+host.scrollTop+normalized.y*after.height-before.viewportOffset.y,host.scrollHeight-host.clientHeight);
      const error={x:Math.abs(expectedLeft-host.scrollLeft),y:Math.abs(expectedTop-host.scrollTop)};
      if(error.x>1||error.y>1)throw Error('Reachable pointer anchor moved: '+JSON.stringify(error));
      const result={scenario,activeBefore,anchorPage:before.pageNumber,normalized,error,dpr:devicePixelRatio,scale:h.snapshot().scale};
      await h.session.close();h.resources.assertEmpty();return result;
    })()`);
    results.push({ scenario: `${scenario} anchor at DPR2`, result: anchorResult });
  }
  const afterHashes = await hashes();
  assert.deepEqual(afterHashes, beforeHashes);
  const report = { kind: "browser-automation-transcript", status: "passed", browser: version.Browser, node: process.version, recordedAt: new Date().toISOString(), sourceHash: process.env.READER_QA_SOURCE_HASH ?? null, limitations: ["Headless Edge with real PDF.js and production wheel binding", "Native authority is mocked; not packaged WebView2 or physical device QA", "No native build or manual preview"], sourceHashesBefore: beforeHashes, sourceHashesAfter: afterHashes, results, transcript, screenshot: "wheel-zoom.png" };
  await writeFile(resolve(evidence, "reader-zoom.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: "passed", scenarios: results.length, evidence: resolve(evidence, "reader-zoom.json"), screenshot: resolve(evidence, "wheel-zoom.png") }));
} catch (error) {
  await writeFile(resolve(evidence, "failure.json"), JSON.stringify({ status: "failed", error: String(error.stack ?? error), results, transcript }, null, 2));
  console.error(`QA failure evidence: ${resolve(evidence, "failure.json")}`);
  throw error;
} finally {
  await writeFile(resolve(evidence, "browser.log"), browserLog);
  if (socket?.readyState === WebSocket.OPEN) {
    try { await deadline(call("Browser.close"), 5000, "Browser close timeout"); } catch { /* Owned-process cleanup below. */ }
    socket.close();
  }
  if (browser && browser.exitCode === null) {
    try { await deadline(new Promise(done => browser.once("exit", done)), 5000, "Owned browser exit timeout"); }
    catch { execFileSync("taskkill", ["/PID", String(browser.pid), "/T", "/F"]); }
  }
  await server.close();
}
