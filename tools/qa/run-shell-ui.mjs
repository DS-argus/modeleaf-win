import { createServer } from "vite";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Automated renderer evidence only; never starts a native Modeleaf preview.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = resolve(root, ".internal/evidence/issue-114", new Date().toISOString().replaceAll(":", "-"));
const profile = await mkdtemp(resolve(tmpdir(), "modeleaf-shell-qa-"));
await mkdir(evidence, { recursive: true });
const server = await createServer({ root, configFile: false, server: { host: "127.0.0.1", port: 0, open: false, watch: null } });
let browser;
let socket;
let sequence = 0;
const pending = new Map();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
  pending.set(id, { resolve: (result) => { clearTimeout(timer); resolve(result); }, reject: (error) => { clearTimeout(timer); reject(error); } });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const settlePaint = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
const paintedBounds = () => evaluate("(() => { const r=document.querySelector('canvas').getBoundingClientRect(); return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height}; })()");
const decodePaintedHash = (data) => evaluate(`(async () => {
  const blob = await (await fetch('data:image/png;base64,${data}')).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas'); canvas.width=bitmap.width; canvas.height=bitmap.height;
  const context=canvas.getContext('2d'); context.drawImage(bitmap,0,0); bitmap.close();
  const hash=await crypto.subtle.digest('SHA-256',context.getImageData(0,0,canvas.width,canvas.height).data);
  return [...new Uint8Array(hash)].map(value=>value.toString(16).padStart(2,'0')).join('');
})()`);
const transcript = [];
const screenshot = async (name) => {
  // Observe the DOM before capture; screenshots prove appearance, not native validation.
  const observed = await evaluate("({title:document.title,theme:document.querySelector('.app-shell').style.cssText,ready:document.querySelector('.app-shell').dataset.ready})");
  const image = await call("Page.captureScreenshot", { format: "png" });
  const file = `${name}.png`;
  await writeFile(resolve(evidence, file), Buffer.from(image.data, "base64"));
  transcript.push({ action: "screenshot", file, observed });
};
try {
  await server.listen();
  const port = server.httpServer.address().port;
  const executable = process.env.SHELL_QA_EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
  browser = spawn(executable, ["--headless=new", "--no-first-run", "--disable-extensions", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  let browserError;
  browser.on("error", (error) => { browserError = error; });
  let debugPort;
  for (let i = 0; i < 100; i++) {
    if (browserError) throw browserError;
    if (browser.exitCode !== null) throw new Error("Browser exited before connection");
    try { debugPort = Number((await readFile(resolve(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; }
    catch { await delay(100); }
  }
  assert(debugPort, "DevTools port unavailable");
  const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const target = pages.find((entry) => entry.type === "page");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data); const request = pending.get(message.id);
    if (request) { pending.delete(message.id); if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result); }
  };
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1040, height: 760, deviceScaleFactor: 1, mobile: false });
  await call("Page.navigate", { url: `http://127.0.0.1:${port}/tools/qa/shell-ui.html` });
  for (let i = 0; i < 100; i++) {
    if (await evaluate("Boolean(window.shellQa)")) break;
    await delay(100);
  }
  await evaluate("shellQa.ready");
  await evaluate("shellQa.setVersion('0.1.3')");
  const baseline = execFileSync("git", ["show", "37a020d:src/styles/app.css"], { cwd: root, encoding: "utf8" });
  await evaluate(`{const style=document.createElement('style');style.id='baseline-style';style.textContent=${JSON.stringify(baseline)};document.head.append(style);}`);
  await screenshot("baseline-css-same-fixture");
  await evaluate("document.querySelector('#baseline-style').remove()");
  await screenshot("tokyo-night-1040");
  const tabClip = await evaluate("(() => {const r=document.querySelector('#tabs').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1};})()");
  const statusClip = await evaluate("(() => {const r=document.querySelector('footer').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1};})()");
  const tabImage = (await call("Page.captureScreenshot", { format: "png", clip: tabClip })).data;
  const statusImage = (await call("Page.captureScreenshot", { format: "png", clip: statusClip })).data;
  const tabReference = (await readFile(resolve(root, "tools/qa/reference/tab-reference.png"))).toString("base64");
  const statusReference = (await readFile(resolve(root, "tools/qa/reference/status-reference.jpg"))).toString("base64");
  await evaluate(`(async () => {const comparison=document.createElement('div');comparison.id='reference-comparison';comparison.style.cssText='position:fixed;inset:0;z-index:999;background:#222;color:white;padding:16px;font:14px sans-serif;overflow:hidden';comparison.innerHTML=${JSON.stringify(`<h3>Owner tab reference</h3><img style="max-width:100%;max-height:260px" src="data:image/png;base64,${tabReference}"><h3>Windows implementation (1040 DIP)</h3><img style="max-width:100%" src="data:image/png;base64,${tabImage}"><h3>Owner status reference</h3><img style="max-width:100%" src="data:image/jpeg;base64,${statusReference}"><h3>Windows status: no right filename; static fixture version</h3><img style="max-width:100%" src="data:image/png;base64,${statusImage}">`)};document.body.append(comparison);await Promise.all([...comparison.querySelectorAll('img')].map(image=>image.decode()));})()`);
  await screenshot("owner-reference-comparison");
  await evaluate("document.querySelector('#reference-comparison').remove()");
  const tabContract = await evaluate(`(() => {const selected=document.querySelector('[data-selected="true"]');const s=getComputedStyle(selected);const b=selected.querySelector('button');return {outline:s.borderTopWidth,bottom:s.borderBottomColor,surface:s.backgroundColor,title:b.title,label:b.getAttribute('aria-label'),fullWidth:document.querySelector('[data-selected="false"]').getBoundingClientRect().width};})()`);
  assert(tabContract.outline==='1px' && tabContract.bottom===tabContract.surface && tabContract.label.includes(tabContract.title) && tabContract.title.endsWith('.pdf') && tabContract.fullWidth===184, "Reference outline/seam/full-name contract");
  const idle = await evaluate("getComputedStyle(document.querySelector('[data-selected=\"false\"]')).backgroundColor");
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 40, y: tabClip.y + 16 });
  const hovered = await evaluate("getComputedStyle(document.querySelector('[data-selected=\"false\"]')).backgroundColor");
  assert(idle!==hovered, "Hover must differ from idle");
  await screenshot("hover-tab");
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 400 });
  for (const [name, value, pendingKeys] of [["normal",{status:'',query:''},''],["diagnostic",{status:'PDF cleanup failed',query:''},''],["search",{status:'Match 1 of 4',query:'needle'},''],["pending",{status:'',query:''},'gg']]) {
    await evaluate(`shellQa.setStatus(${JSON.stringify(value)},${JSON.stringify(pendingKeys)})`);
    const observed = await evaluate("({message:document.querySelector('.status-message').textContent,pending:document.querySelector('.status-pending-value').textContent,search:!document.querySelector('.status-badge-search').hidden,metricsLive:!!document.querySelector('.status-metrics').closest('[aria-live]')})");
    assert(observed.message===value.status && observed.pending===pendingKeys && observed.search===Boolean(value.query) && !observed.metricsLive, `Status ${name} contract`);
    transcript.push({action:'status-case',name,observed,passed:true});
    await screenshot(`status-${name}`);
  }
  const descenderStatus = { status: "g p y Go to page: 12 — a long diagnostic status remains available", query: "needle", zoomMode: "custom", zoom: 1.25 };
  for (const width of [1040, 480]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height: 760, deviceScaleFactor: 1, mobile: false });
    await evaluate(`shellQa.setStatus(${JSON.stringify(descenderStatus)},"g")`);
    const geometry = await evaluate(`(() => {
      const footer = document.querySelector('footer');
      const message = document.querySelector('.status-message');
      const pending = document.querySelector('.status-pending');
      const badge = document.querySelector('.status-badge-search');
      const footerStyle = getComputedStyle(footer);
      const messageStyle = getComputedStyle(message);
      const footerBounds = footer.getBoundingClientRect();
      const messageBounds = message.getBoundingClientRect();
      const badgeBounds = badge.getBoundingClientRect();
      return {
        height: footerBounds.height,
        overflow: footer.scrollWidth > footer.clientWidth,
        lineHeight: Number.parseFloat(footerStyle.lineHeight),
        messageFlexGrow: Number.parseFloat(messageStyle.flexGrow),
        messageWidth: messageBounds.width,
        messageTop: messageBounds.top - footerBounds.top,
        messageBottom: messageBounds.bottom - footerBounds.top,
        messageLineHeight: Number.parseFloat(messageStyle.lineHeight),
        paddingTop: Number.parseFloat(messageStyle.paddingTop),
        paddingBottom: Number.parseFloat(messageStyle.paddingBottom),
        messageText: message.textContent,
        messageHidden: message.hidden,
        pendingText: pending.textContent,
        badgeTop: badgeBounds.top - footerBounds.top,
        badgeBottom: badgeBounds.bottom - footerBounds.top,
      };
    })()`);
    assert(geometry.height === 26 && !geometry.overflow, `Descender status row ${width}: ${JSON.stringify(geometry)}`);
    assert(geometry.lineHeight >= 12 && geometry.messageFlexGrow === 1 && geometry.messageWidth > 0, `Descender status flex ${width}: ${JSON.stringify(geometry)}`);
    assert(geometry.messageText === descenderStatus.status && !geometry.messageHidden && geometry.pendingText === "Pending: g", `Descender status content ${width}: ${JSON.stringify(geometry)}`);
    assert(geometry.badgeBottom <= geometry.height && geometry.badgeTop >= 0, `Descender status badge ${width}: ${JSON.stringify(geometry)}`);
    assert(geometry.messageTop >= 0 && geometry.messageBottom <= geometry.height && geometry.messageLineHeight >= 14 && geometry.paddingTop >= 2 && geometry.paddingBottom >= 2, `Descender message clearance ${width}: ${JSON.stringify(geometry)}`);
    transcript.push({ action: "status-descender-geometry", width, geometry, passed: true });
  }
  await evaluate("shellQa.setStatus({status:'',query:''},'')");
  await evaluate("shellQa.setStatus({status:'Page 1 of 233 · 90°',page:1,pageCount:233,zoomMode:'fit-page'},'');shellQa.setPath({text:'C:\\\\documents\\\\papers',copied:false})");
  const pathLayout = await evaluate(`(() => {const path=document.querySelector('.status-path-notice');const badge=document.querySelector('.status-badge-fit-page');const message=document.querySelector('.status-message');return {gap:path.getBoundingClientRect().left-badge.getBoundingClientRect().right,textAlign:getComputedStyle(path).textAlign,messageHidden:message.hidden,text:message.textContent,font:getComputedStyle(document.querySelector('footer')).fontSize};})()`);
  assert(pathLayout.gap>=0 && pathLayout.gap<=8 && pathLayout.textAlign==='left' && pathLayout.messageHidden && pathLayout.text==='' && pathLayout.font==='10px', 'Compact status/path alignment contract');
  await screenshot('owner-feedback-status-path');
  await evaluate("shellQa.setPath(undefined);shellQa.setStatus({status:'',pageCount:3},'')");
  const seam = await evaluate(`(() => {const selected=document.querySelector('[data-selected="true"]');return {previous:getComputedStyle(selected.previousElementSibling).borderRightColor,ordinary:getComputedStyle(document.querySelector('.workspace-tab-item')).borderRightColor};})()`);
  assert(seam.previous==='rgba(0, 0, 0, 0)' && seam.ordinary!==seam.previous, 'Previous divider must not protrude into selected upper-left corner');
  transcript.push({action:'owner-feedback-status-tab',pathLayout,seam,passed:true});
  for (const theme of ['tokyo-night','catppuccin-latte']) for (const width of [1040,480]) for (const textScale of [1,1.5]) {
    await call('Emulation.setDeviceMetricsOverride',{width,height:760,deviceScaleFactor:1,mobile:false});
    await evaluate(`shellQa.setTheme(${JSON.stringify(theme)});document.documentElement.style.fontSize='${16*textScale}px'`);
    for (const [id,maximum] of [['command-palette',360],['help',640],['theme',300]]) {
      await evaluate(`shellQa.showOverlay(${JSON.stringify(id)})`);
      const panel = await evaluate(`(() => {const d=document.querySelector('dialog[open]');const r=d.getBoundingClientRect();return {width:r.width,height:r.height,left:r.left,right:r.right,overflow:d.scrollWidth>d.clientWidth};})()`);
      assert(panel.width<=Math.min(maximum,width-32)+1 && panel.left>=0 && panel.right<=width && !panel.overflow, `Compact ${id} ${theme}/${width}/${textScale}: ${JSON.stringify(panel)}`);
      if (id==='command-palette') {
        const colors = await evaluate(`(() => {const color=s=>getComputedStyle(document.querySelector(s)).color;return {label:color('.command-palette-entry-label'),key:color('.command-palette-entry-shortcut'),helpLabel:color('.help-group dt'),helpKey:color('.help-group dd')};})()`);
        assert(colors.label!==colors.key && colors.label===colors.helpLabel && colors.key===colors.helpKey,'Palette must match help description/key color roles');
      }
      transcript.push({action:'compact-overlay',id,theme,width,textScale,...panel,passed:true});
      await screenshot(`compact-${id}-${theme}-${width}-text${textScale}`);
    }
    await evaluate('shellQa.showOverlay(undefined)');
  }
  await call('Emulation.setDeviceMetricsOverride',{width:1040,height:760,deviceScaleFactor:1,mobile:false});
  await evaluate("document.documentElement.style.fontSize='16px';shellQa.setTheme('tokyo-night')");
  // Start pixel invariance from a fresh viewport, independent of dialog focus/scale reflow.
  await call("Page.navigate", { url: `http://127.0.0.1:${port}/tools/qa/shell-ui.html?phase=pixels` });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate("location.search==='?phase=pixels' && Boolean(window.shellQa)")) break;
    await delay(100);
  }
  await evaluate("shellQa.ready");
  // A centered canvas can land on half-pixels with a classic Windows scrollbar.
  // Align this QA fixture so screenshot pixels exclude theme-colored edge blending.
  await evaluate("document.querySelector('.pdf-page-frame').style.margin='0';shellQa.setVersion('0.1.3')");
  const initial = await evaluate("shellQa.pixelHash()");
  await settlePaint();
  const pdfBounds = await paintedBounds();
  assert(Number.isInteger(pdfBounds.x) && Number.isInteger(pdfBounds.y), "PDF comparison fixture must be pixel-aligned, not blended with shell edges");
  const initialPaintData = (await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...pdfBounds, scale: 1 } })).data;
  await writeFile(resolve(evidence, "pdf-reference-pixels.png"), Buffer.from(initialPaintData, "base64"));
  const initialPaint = await decodePaintedHash(initialPaintData);
  const fixtureHash = createHash("sha256").update(await readFile(resolve(root, "fixtures/pdf/text-3-page.pdf"))).digest("hex");
  const themes = ["tokyo-night", "gruvbox-dark", "solarized-dark", "dracula", "everforest", "nord", "catppuccin-latte"];
  for (const theme of themes) {
    await evaluate(`shellQa.setTheme(${JSON.stringify(theme)})`);
    const hash = await evaluate("shellQa.pixelHash()");
    const style = await evaluate("({filter:getComputedStyle(document.querySelector('canvas')).filter,opacity:getComputedStyle(document.querySelector('canvas')).opacity})");
    assert(hash === initial && style.filter === "none" && style.opacity === "1", `PDF pixels changed in ${theme}`);
    await settlePaint();
    const currentPdfBounds = await paintedBounds();
    assert(currentPdfBounds.width === pdfBounds.width && currentPdfBounds.height === pdfBounds.height, `PDF geometry changed in ${theme}`);
    const painted = (await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...currentPdfBounds, scale: 1 } })).data;
    const paintedPixelHash = await decodePaintedHash(painted);
    if (paintedPixelHash !== initialPaint) {
      await writeFile(resolve(evidence, `pdf-mismatch-${theme}.png`), Buffer.from(painted, "base64"));
      await writeFile(resolve(evidence, "pixel-mismatch.json"), JSON.stringify({ theme, referenceBounds: pdfBounds, currentBounds: currentPdfBounds, referenceHash: initialPaint, paintedPixelHash, viewport: await evaluate("({width:innerWidth,height:innerHeight,scrollX,scrollY,canvas:document.querySelector('canvas').getBoundingClientRect().toJSON(),reader:document.querySelector('.reader-surface').getBoundingClientRect().toJSON()})") }, null, 2));
    }
    assert(paintedPixelHash === initialPaint, `Painted PDF changed in ${theme}`);
    transcript.push({ action: "theme-pdf-invariance", theme, fixtureHash, pixelHash: hash, paintedHash: paintedPixelHash, bounds: currentPdfBounds, style, passed: true });
  }
  for (const theme of themes) {
    await evaluate(`shellQa.setTheme(${JSON.stringify(theme)});shellQa.showOverlay('command-palette');document.querySelectorAll('.command-palette-entry')[1].focus()`);
    const target = await evaluate("(() => {const r=document.querySelectorAll('.command-palette-entry')[2].getBoundingClientRect();return {x:r.x+8,y:r.y+8};})()");
    await call('Input.dispatchMouseEvent',{type:'mouseMoved',...target});
    const ratios = await evaluate(`(() => {
      const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');
      const luminance=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3).reduce((sum,v,i)=>{v/=255;return sum+(v<=.04045?v/12.92:((v+.055)/1.055)**2.4)*[.2126,.7152,.0722][i]},0)};
      const ratio=(a,b)=>(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
      return [...document.querySelectorAll('.command-palette-entry')].slice(0,3).map(row=>{const bg=luminance(getComputedStyle(row).backgroundColor);return {label:ratio(luminance(getComputedStyle(row.querySelector('.command-palette-entry-label')).color),bg),key:ratio(luminance(getComputedStyle(row.querySelector('.command-palette-entry-shortcut')).color),bg)};});
    })()`);
    assert(ratios.every(row=>row.label>=4.5&&row.key>=4.5),`Palette selected/focus/hover contrast: ${theme} ${JSON.stringify(ratios)}`);
    transcript.push({action:'palette-interaction-contrast',theme,ratios,passed:true});
    await evaluate('shellQa.showOverlay(undefined)');
  }
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:900,y:400});
  const matrix = [];
  for (const theme of ["tokyo-night", "catppuccin-latte"]) for (const dpr of [1, 1.25, 1.5, 2]) for (const text of [1, 1.5]) {
    await call("Emulation.setDeviceMetricsOverride", { width: 480, height: 360, deviceScaleFactor: dpr, mobile: false });
    await evaluate(`shellQa.setTheme(${JSON.stringify(theme)});document.documentElement.style.fontSize='${16 * text}px';shellQa.setTabs(16);shellQa.setStatus({status:'Diagnostic: a long failure message remains available',query:'needle',zoomMode:'custom'},'gg');`);
    const geometry = await evaluate(`(() => {
      const selected=document.querySelector('[data-selected="true"]'); const s=getComputedStyle(selected);
      const footer=document.querySelector('footer'); const f=footer.getBoundingClientRect();
      const strip=document.querySelector('#tabs'); const b=strip.getBoundingClientRect(); const r=selected.getBoundingClientRect();
      return {height:f.height,overflow:footer.scrollWidth>footer.clientWidth,corners:[s.borderTopLeftRadius,s.borderTopRightRadius,s.borderBottomLeftRadius,s.borderBottomRightRadius],activeWidth:r.width,inactiveWidth:document.querySelector('[data-selected="false"]').getBoundingClientRect().width,selectedVisible:r.left>=b.left-1&&r.right<=b.right+1,versionOutsideLive:!document.querySelector('.status-version').closest('[aria-live]'),helpHidden:getComputedStyle(document.querySelector('.status-help')).display==='none'};
    })()`);
    assert(geometry.height === 26 && !geometry.overflow, `Status row overflow ${theme}/${dpr}/${text}: ${JSON.stringify(geometry)}`);
    assert(geometry.activeWidth >= 120 && geometry.inactiveWidth >= 40 && geometry.selectedVisible, `Tab compact/visibility ${JSON.stringify(geometry)}`);
    assert(geometry.corners.join(',') === "6px,6px,0px,0px" && geometry.versionOutsideLive && geometry.helpHidden, "Geometry/accessibility contract");
    matrix.push({ theme, dpr, textScaleEmulation: text, ...geometry });
    await screenshot(`${theme}-480-dpr${dpr}-text${text}`);
  }
  await evaluate("shellQa.setPrint({phase:'preparing',preparedPages:2,totalPages:100,fraction:0.02})");
  const printBounds = await evaluate(`(() => { const b=document.querySelector('.print-progress-cancel').getBoundingClientRect(); const f=document.querySelector('footer').getBoundingClientRect(); return {visible:b.width>0&&b.left>=f.left&&b.right<=f.right&&b.top>=f.top&&b.bottom<=f.bottom}; })()`);
  assert(printBounds.visible, "Print cancellation must remain visible in the narrow statusbar");
  await screenshot("print-search-diagnostic-pending-version-480");
  await evaluate("document.querySelector('.print-progress-cancel').click()");
  assert(await evaluate("document.querySelector('.app-shell').dataset.printCancelled==='true'"), "Print cancel action did not route");
  await evaluate("shellQa.setPrint(undefined);shellQa.setVersion(undefined)");
  assert(await evaluate("document.querySelector('.status-version').hidden && document.querySelector('.status-version').textContent===''"), "Version failure fabricated metadata");
  await evaluate("shellQa.setTabs(3);document.querySelector('#reader-tab-2').focus();shellQa.setTabs(3)");
  assert(await evaluate("document.activeElement.id==='reader-tab-2'"), "Status/tab render lost focus");
  await evaluate("shellQa.setDisabled('0');document.querySelector('#reader-tab-0').click()");
  assert(await evaluate("document.querySelector('#reader-tab-2').getAttribute('aria-selected')==='true'"), "Disabled tab activated");
  await screenshot("selected-focused-disabled-tabs");
  await evaluate("document.querySelector('[data-selected=\"true\"] .workspace-tab-close').click()");
  assert(await evaluate("document.querySelectorAll('.workspace-tab-item').length===2"), "Close did not remove selected tab");
  transcript.push({ action: "adversarial-controls", cases: ["narrow-print-cancellation", "version-failure", "retained-focus", "disabled-tab", "close-selected"], passed: true });
  await call("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
  await screenshot("forced-colors-480");
  const forced = await evaluate("({active:matchMedia('(forced-colors: active)').matches,selected:getComputedStyle(document.querySelector('[data-selected=\"true\"]')).borderTopColor})");
  assert(forced.active, "Forced colors not active");
  await call("Emulation.setEmulatedMedia", { features: [] });
  await evaluate("shellQa.setEmpty(true)");
  await screenshot("empty-state-480");
  const report = { schemaVersion: 1, kind: "browser-automation", surface: "web", status: "passed", source: "production shell renderers and CSS; fixed real PDF.js fixture", limitations: ["Not native WebView2 QA", "DPR/root-font emulation does not prove Windows DPI or OS text scaling", "Fixture version only; not packaged runtime metadata evidence", "Baseline screenshot compares original CSS on the same component fixture, not the old app binary"], matrix, transcript, forced };
  await writeFile(resolve(evidence, "automation.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: "passed", matrixCases: matrix.length, themes: themes.length, evidence }, null, 2));
} finally {
  socket?.close();
  for (const request of pending.values()) request.reject(new Error("QA connection closed"));
  pending.clear();
  if (browser?.pid && browser.exitCode === null && browser.signalCode === null) {
    let killError;
    try {
      if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(browser.pid), "/T", "/F"], { stdio: "pipe" });
      else browser.kill();
    } catch (error) { killError = error; }
    // Windows can report an already-exited child as a taskkill failure.
    // Verify process absence rather than accepting taskkill output as proof.
    let exited = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(browser.pid, 0); }
      catch (error) { if (error.code !== "ESRCH") throw error; exited = true; break; }
      await delay(100);
    }
    if (!exited) throw killError ?? new Error("QA browser did not exit");
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await server.close();
}
