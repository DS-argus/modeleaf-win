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
  if (!process.env.READER_QA_FIT_ONLY) {
  await open("?hidden=true");
  const hidden = await evaluate("({opening:window.readerOpening,reference:window.readerHarness.session.snapshot.reader.fitPageReference})");
  assert.equal(hidden.opening.hiddenOpening, true);
  assert.equal(hidden.opening.opening.mode, "continuous-fit");
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
  for (const config of [
    ...[1, 1.25, 1.5, 2].flatMap(dpr => ['wheel', 'keyboard'].map(input => ({ dpr, input, fixture: 'fixture-L-text-300.pdf' }))),
    ...['wheel', 'keyboard'].map(input => ({ dpr: 1.25, input, fixture: 'print-mixed-rotation-4.pdf' })),
    ...['fit-wheel', 'burst', 'reverse'].map(input => ({ dpr: 1.25, input, fixture: 'fixture-L-text-300.pdf' })),
  ]) {
    await call('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: config.dpr, mobile: false });
    await open('?fixture=' + config.fixture);
    const result = await evaluate(`(async()=>{
      const config=${JSON.stringify(config)},h=window.readerHarness,s=h.session,c=s.pdfReader;
      const samples=[];
      const snap=()=>({...h.snapshot(),residents:c.residentPageNumbers(),visible:c.visiblePageNumbers,bytes:h.resources.snapshot().totals['canvas-bytes']});
      const landing=await s.navigatePagePrompt(config.fixture.startsWith('fixture-L')?26:2);
      if(landing.kind!=='verifiedLanding')throw Error('Initial page landing failed');
      h.host.scrollTop+=137;await s.synchronizeViewport(h.host.scrollTop,h.host.clientHeight);
      if(config.input==='fit-wheel'){s.apply({type:'view.fitPage'});if(!await s.renderCurrentView())throw Error('Fit Page setup failed');}
      const rect=h.host.getBoundingClientRect();
      const act=async(kind,direction)=>{try{
        if(kind==='keyboard'){s.apply({type:'view.zoom',factor:direction>0?1.1:1/1.1});return await s.renderCurrentView();}
        return await s.handleWheelInput({ctrlKey:true,deltaX:0,deltaY:direction>0?-100:100,deltaMode:0,timeStamp:performance.now(),clientX:rect.left+h.host.clientWidth/2,clientY:rect.top+h.host.clientHeight/2});
      }catch(error){return String(error);}};
      const before=snap();
      for(let index=0;index<(config.input==='fit-wheel'?1:26);index++){
        const outcome=config.input==='reverse'?await Promise.all([1,1,-1].map(direction=>act('wheel',direction))):config.input==='burst'?await Promise.all([1,2,3].map(()=>act('wheel',1))):await act(config.input,1);
        const snapshot=snap();samples.push({index,outcome,snapshot});
        if(snapshot.bytes>268435456)throw Error('Canvas budget exceeded');
        if(outcome===true||Array.isArray(outcome)&&outcome.every(x=>x===true)){
          if(!snapshot.visible.every(page=>snapshot.residents.includes(page)))throw Error('Successful zoom omitted visible pages');
        }
        if(typeof outcome==='string'||outcome===false||Array.isArray(outcome)&&outcome.some(x=>x!==true)||snapshot.scale>=4)break;
      }
      const after=snap(),recovery=[];
      for(const kind of ['wheel','keyboard','wheel']){
        const prior=s.snapshot.reader.customScale,outcome=await act(kind,-1),snapshot=snap();
        if(outcome!==true||snapshot.scale>=prior)throw Error('Zoom-out recovery failed: '+JSON.stringify({config,kind,outcome,snapshot}));
        recovery.push({kind,outcome,snapshot});
      }
      const statuses=[...h.statuses];await s.close();h.resources.assertEmpty();
      return {config,before,after,samples,recovery,statuses,disposed:true};
    })()`);
    if (config.input === 'fit-wheel') {
      assert.equal(result.samples[0].outcome, true);
      assert.equal(result.after.mode, 'custom');
      assert(Math.abs(result.after.scale - result.before.scale * 1.1) < 1e-9);
    } else {
      // The reader clamps user zoom to 4x; +,+,- saturates at 4/1.1.
      const minimumScale = config.input === 'reverse' ? 4 / 1.1 : 4;
      assert(result.after.scale >= minimumScale, JSON.stringify({ config, after: result.after, samples: result.samples }));
    }
    results.push({ scenario: 'budgeted zoom and recovery', result });
  }
  for (const scenario of ['shell-scroll', 'evicted-reactivation', 'resized-reactivation', 'overlapping-fit-width', 'deferred-user-scroll']) {
    await call('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1.25, mobile: false });
    await open();
    const result = await evaluate(`(async()=>{
      const scenario=${JSON.stringify(scenario)},h=window.readerHarness,s=h.session,c=s.pdfReader,failures=[],samples=[];
      const code=await(await fetch('/src/main.ts')).text();
      const a=code.indexOf('let viewportFrameRequest'),b=code.indexOf('let readerResizeFrame',a);
      if(a<0||b<=a)throw Error('Production scroll scheduler missing');
      const dispose=new Function('host','session','active','reportPresentationFailure','rootKeyboard','render','cancelLinkHints',code.slice(a,b)+';return ()=>{viewportDisposed=true;host.removeEventListener("scroll",onReaderScroll);if(viewportFrameRequest!==undefined)cancelAnimationFrame(viewportFrameRequest);};')(h.host,s,()=>({session:s}),(_session,error)=>failures.push(String(error)),{syncContext(){}},()=>{},()=>{});
      const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
      const settle=async()=>{let previous,stable=0;for(let i=0;i<180;i++){await frame();const now=JSON.stringify(h.snapshot());stable=!s.pendingPresentationRenders&&!s.presentationSettlements&&!c.viewportSettlement&&h.resources.snapshot().totals.render===0&&now===previous?stable+1:0;previous=now;if(stable>=3)return;}throw Error('Presentation did not settle');};
      const sample=label=>{if(!s.snapshot.active)throw Error('Tab became inactive: '+label);if(failures.length)throw Error(JSON.stringify(failures));samples.push({label,...h.snapshot(),active:s.snapshot.active,bytes:h.resources.snapshot().totals['canvas-bytes']});};
      try{
        if((await s.navigatePagePrompt(26)).kind!=='verifiedLanding')throw Error('Initial navigation failed');
        await settle();
        if(scenario.endsWith('reactivation')){
          await s.deactivate();
          if(scenario==='evicted-reactivation')s.evictInactiveHeavyResources();else h.host.style.width='640px';
          await s.activate();await settle();sample('reactivated');
        }
        if(scenario==='overlapping-fit-width'){
          let entered,release;const enter=new Promise(resolve=>entered=resolve),barrier=new Promise(resolve=>release=resolve);
          const original=s.viewTransformFor.bind(s);let hold=true;
          s.viewTransformFor=async(...args)=>{if(hold){hold=false;entered();await barrier;}return original(...args);};
          s.apply({type:'view.zoom',factor:1.1});const old=s.renderCurrentView();await enter;
          try{s.apply({type:'view.fitWidth'});if(!await s.renderCurrentView())throw Error('New fit-width was blocked by old metadata');}
          finally{release();await old;s.viewTransformFor=original;}
          await settle();sample('overlap settled');
        }
        if(scenario==='deferred-user-scroll'){
          let entered,release;const enter=new Promise(resolve=>entered=resolve),barrier=new Promise(resolve=>release=resolve);
          const original=c.synchronizeViewport.bind(c);let hold=true;
          c.synchronizeViewport=async(...args)=>{const result=await original(...args);if(hold){hold=false;entered();await barrier;}return result;};
          s.apply({type:'view.fitWidth'});const rendering=s.renderCurrentView();await enter;
          h.host.scrollTop+=h.host.clientHeight*5;const requestedTop=h.host.scrollTop;
          await frame();await frame();
          release();if(!await rendering)throw Error('Owned render failed during user scroll');
          await settle();c.synchronizeViewport=original;
          const geometry=c.contentViewportGeometry(),range=c.current.window.visibleRangeForViewport(geometry.scrollTop,geometry.clientHeight);
          const expected=Array.from({length:range.lastVisiblePage-range.firstVisiblePage+1},(_,i)=>range.firstVisiblePage+i);
          if(Math.abs(h.host.scrollTop-requestedTop)>1||!expected.every(page=>c.residentPageNumbers().includes(page))||JSON.stringify(c.visiblePageNumbers)!==JSON.stringify(expected))throw Error('Deferred user scroll was not materialized automatically');
          sample('latest user scroll replayed');
        }
        for(const action of [{type:'view.fitWidth'},{type:'view.fitWidth'},{type:'view.zoom',factor:1/1.1},{type:'view.zoom',factor:1.1},{type:'view.fitPage'},{type:'view.zoom',factor:1.1}]){
          s.apply(action);if(!await s.renderCurrentView())throw Error('Keyboard action failed: '+JSON.stringify(action));await settle();sample(action.type);
        }
        await s.deactivate();await s.activate();await settle();sample('reactivated after keyboard actions');
        if(h.statuses.some(status=>/failed|could not/i.test(status)))throw Error(JSON.stringify(h.statuses));
        return {scenario,samples,statuses:[...h.statuses]};
      }finally{dispose();await s.close();h.resources.assertEmpty();}
    })()`);
    results.push({ scenario: 'shell-owned presentation and activation', result });
  }
  await open();
  results.push({ scenario: 'evicted tab restored after closing its successor', result: await evaluate('window.readerHarness.runTabClose()') });
  }
  const requestedFitMode = process.env.READER_QA_FIT_ONLY;
  assert([undefined, "all", "fit-width", "fit-page"].includes(requestedFitMode), "Unknown READER_QA_FIT_ONLY mode");
  const fitModes = requestedFitMode === "fit-width" || requestedFitMode === "fit-page" ? [requestedFitMode] : ["fit-width", "fit-page"];
  for (const fixture of [...fixtures].reverse()) {
    for (const dpr of [1, 1.25, 1.5]) {
      for (const renderDelay of [0, 120]) {
        for (const mode of fitModes) {
          await call("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: dpr, mobile: false });
          await open(`?fixture=${fixture}&fitDelay=${renderDelay}`);
          results.push({ scenario: "final fit geometry", fixture, dpr, renderDelay, mode,
            result: await evaluate(`window.readerHarness.runFitGeometry(${JSON.stringify(mode)})`) });
        }
      }
    }
  }
  const afterHashes = await hashes();
  assert.deepEqual(afterHashes, beforeHashes);
  const report = { schemaVersion: 1, kind: "browser-automation-transcript", tool: "Chrome DevTools Protocol", status: "passed", browser: version.Browser, node: process.version, recordedAt: new Date().toISOString(), sourceHash: process.env.READER_QA_SOURCE_HASH ?? null, limitations: ["Headless Edge with real PDF.js and production wheel binding", "Native authority is mocked; not packaged WebView2 or physical device QA", "No native build or manual preview"], sourceHashesBefore: beforeHashes, sourceHashesAfter: afterHashes, results, transcript, actions: transcript.map(({ method, params }) => ({ type: method, params })), screenshot: process.env.READER_QA_FIT_ONLY ? null : "wheel-zoom.png"};
  await writeFile(resolve(evidence, "reader-zoom.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: "passed", scenarios: results.length, evidence: resolve(evidence, "reader-zoom.json"), screenshot: process.env.READER_QA_FIT_ONLY ? null : resolve(evidence, "wheel-zoom.png") }));
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
