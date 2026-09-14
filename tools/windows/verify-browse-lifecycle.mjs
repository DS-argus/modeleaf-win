import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const [exeArgument, outputArgument, expectedHash] = process.argv.slice(2);
const exe=resolve(exeArgument), output=resolve(outputArgument);
const hash=createHash('sha256').update(readFileSync(exe)).digest('hex');
assert.match(expectedHash ?? '',/^[a-f0-9]{64}$/,'A pinned QA executable hash is required');
assert.equal(hash,expectedHash,'Only the pinned state-isolated QA build is admitted');
assert(!existsSync(output),'Refusing to overwrite prior trial');
mkdirSync(dirname(output),{recursive:true});
const events=[];
const started=performance.now();
const event=(action,outcome,detail={})=>events.push({monotonicMs:Math.round(performance.now()-started),action,outcome,...detail});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(label,probe,timeout=15000){
  const deadline=performance.now()+timeout;
  while(performance.now()<deadline){const value=await probe();if(value)return value;await delay(150);}
  throw new Error('Bounded wait failed: '+label);
}
const reserve=createServer();
await new Promise((resolve,reject)=>{reserve.once('error',reject);reserve.listen(0,'127.0.0.1',resolve);});
const port=reserve.address().port;
await new Promise(r=>reserve.close(r));
const profile=mkdtempSync(join(tmpdir(),'modeleaf71-nested-'));
const app=spawn(exe,[],{env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`,WEBVIEW2_USER_DATA_FOLDER:profile},stdio:'ignore'});
let appExited=false;
app.once('exit',(code,signal)=>{appExited=true;event('qa-process-exit',code===0?'passed':'nonzero',{code,signal});});
app.once('error',error=>event('qa-process-error','failed',{reason:error.message}));
event('launch-isolated-qa','started',{pid:app.pid,exeSha256:hash,configDelta:'unique identifier; loopback debugging and fresh browser profile for synthetic lifecycle test'});
const observer=spawn('pwsh.exe',['-NoProfile','-File',resolve('tools/windows/observe-browse-lifecycle.ps1'),'-OwnerProcess',String(app.pid)],{stdio:['pipe','pipe','inherit']});
let observerReady=false, serial=0;
const pending=new Map();
const observerFailed=()=>{observerReady=false;for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Native observer stopped'));}pending.clear();};
observer.once('exit',observerFailed);
observer.once('error',observerFailed);
observer.stdin.on('error',observerFailed);
createInterface({input:observer.stdout}).on('line',line=>{
  let value;try{value=JSON.parse(line);}catch{return;}
  if(value.ready){observerReady=true;return;}
  const p=pending.get(value.id);if(!p)return;pending.delete(value.id);clearTimeout(p.timer);
  if(value.ok)p.resolve(value.result);else p.reject(new Error(value.error));
});
function native(op,extra={}){
  if(!observerReady)return Promise.reject(new Error('Native observer unavailable'));
  const id=++serial;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Observer request timed out: '+op));},5000);
    pending.set(id,{resolve,reject,timer});observer.stdin.write(JSON.stringify({id,op,...extra})+'\n');
  });
}
const roots=s=>s.windows.filter(w=>w.visible&&w.owner===0&&w.width>200&&w.height>200);
const picker=(s,owner)=>s.windows.find(w=>w.visible&&w.owner===owner&&w.class==='#32770');
async function targets(){
  if(appExited)throw new Error('QA process exited unexpectedly');
  try{return (await (await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000),redirect:'error'})).json()).filter(t=>t.type==='page'&&t.webSocketDebuggerUrl);}catch{return [];}
}
const sockets=[];
async function connect(target){
  const address=new URL(target.webSocketDebuggerUrl);
  assert(address.protocol==='ws:' && ['127.0.0.1','localhost'].includes(address.hostname) && address.port===String(port),'Debugger endpoint must stay on the reserved loopback port');
  const ws=new WebSocket(target.webSocketDebuggerUrl);sockets.push(ws);
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{ws.close();reject(new Error('CDP connection timed out'));},5000);
    ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
    ws.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('CDP connection failed'));},{once:true});
  });
  let sequence=0;const requests=new Map();
  ws.addEventListener('message',({data})=>{const m=JSON.parse(String(data));const p=requests.get(m.id);if(!p)return;requests.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);});
  ws.addEventListener('close',()=>{for(const p of requests.values()){clearTimeout(p.timer);p.reject(new Error('CDP target closed'));}requests.clear();});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{requests.delete(id);reject(new Error('CDP request timed out: '+method));},10000);requests.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error('Owned renderer evaluation failed: '+(result.exceptionDetails.text??'exception'));return result.result.value;};
  await waitFor('renderer ready',async()=>await evaluate('!!document.getElementById("empty-reader-open") && !!window.__TAURI_INTERNALS__'));
  return {call,evaluate};
}
async function browse(page){
  await page.evaluate('document.getElementById("empty-reader-open").click(); true');
  await waitFor('actual chooser open',()=>page.evaluate('document.getElementById("file-opener-dialog").open'));
  await page.evaluate('document.querySelector(".file-opener-browse").click(); true');
}
const readIngress=page=>page.evaluate('window.__TAURI_INTERNALS__.invoke("list_pending_open_ingress", {}).then(items => ({count:items.length}))');
const readRecent=page=>page.evaluate('window.__TAURI_INTERNALS__.invoke("list_recents", {}).then(value => ({tag:value.tag,revision:value.revision,entryCount:value.entries?.length}))');
let status='failed';
try {
  await waitFor('observer ready',()=>observerReady);
  const first=await waitFor('first page',async()=>(await targets())[0]);
  const a=await connect(first);
  const firstRoots=await waitFor('first native root',async()=>{const s=await native('snapshot');return roots(s).length===1?roots(s):false;});
  const aRoot=firstRoots[0];
  event('root-A','observed',{window:aRoot});
  const beforeRecent=await readRecent(a);
  const created=await a.evaluate('window.__TAURI_INTERNALS__.invoke("create_app_window", {})');
  event('create-B-through-native-command','completed',{created});
  const second=await waitFor('second page',async()=>(await targets()).find(t=>t.id!==first.id));
  const b=await connect(second);
  const bRoot=await waitFor('second native root',async()=>roots(await native('snapshot')).find(w=>w.hwnd!==aRoot.hwnd));
  assert.equal(aRoot.tid,bRoot.tid);
  event('root-B','observed',{window:bRoot});
  await browse(a);
  const aPicker=await waitFor('A picker',async()=>picker(await native('snapshot'),aRoot.hwnd));
  event('outer-picker-A','observed',{window:aPicker});
  const bBefore=roots(await native('snapshot')).find(w=>w.hwnd===bRoot.hwnd);
  assert.equal(bBefore.enabled,true,'A modal must not disable B');
  await browse(b);
  const bPicker=await waitFor('B nested picker',async()=>picker(await native('snapshot'),bRoot.hwnd));
  event('inner-picker-B','observed',{window:bPicker});
  const heartbeatStart=performance.now();
  const ingressWhileNested=await readIngress(b);
  event('unrelated-native-IPC-during-nested-Show','completed',{elapsedMs:Math.round(performance.now()-heartbeatStart),...ingressWhileNested});
  assert.equal(ingressWhileNested.count,0);
  const closeStart=performance.now();
  await native('close',{hwnd:aRoot.hwnd});
  event('synthetic-owner-A-WM_CLOSE','posted');
  const afterA=await waitFor('owner A destroyed while B picker remains',async()=>{const s=await native('snapshot');return !s.windows.some(w=>w.hwnd===aRoot.hwnd)&&picker(s,bRoot.hwnd)?s:false;},12000);
  event('owner-A-destroyed-inner-B-still-live','observed',{elapsedMs:Math.round(performance.now()-closeStart),windows:afterA.windows.filter(w=>w.hwnd===bRoot.hwnd||w.owner===bRoot.hwnd)});
  assert.equal((await readIngress(b)).count,0);
  await native('close',{hwnd:bPicker.hwnd});
  event('synthetic-inner-picker-B-WM_CLOSE','posted');
  const returned=await waitFor('B native focus restored after nested unwind',async()=>{const s=await native('snapshot');return !picker(s,bRoot.hwnd)&&s.threads.some(t=>t.success&&t.focusRoot===bRoot.hwnd)?s:false;});
  event('post-inner-native-and-DOM-state','observed',{snapshot:returned,dom:await b.evaluate('({activeId:document.activeElement?.id,activeTag:document.activeElement?.tagName,chooserOpen:document.getElementById("file-opener-dialog").open,openDisabled:document.getElementById("empty-reader-open").disabled,documentFocused:document.hasFocus()})')});
  const postInnerHeartbeat=performance.now();
  event('native-IPC-after-inner-close','completed',{...await readIngress(b),elapsedMs:Math.round(performance.now()-postInnerHeartbeat)});
  await waitFor('B WebView and DOM terminal focus restored',()=>b.evaluate('document.hasFocus() && !document.getElementById("file-opener-dialog").open && !document.getElementById("empty-reader-open").disabled && document.activeElement.id === "empty-reader-open"'));
  event('B-post-unwind-focus','passed',{threads:returned.threads});
  assert.equal(await b.evaluate('document.querySelectorAll("#tab-strip [role=tab]").length'),0);
  assert.deepEqual(await readRecent(b),beforeRecent,'Closing A must not admit a recent');
  event('no-tab-or-recent-admission','passed');
  await b.evaluate('window.dispatchEvent(new KeyboardEvent("keydown",{key:"O",code:"KeyO",ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true})); true');
  await waitFor('surviving B keyboard-opened chooser',()=>b.evaluate('document.getElementById("file-opener-dialog").open'));
  await b.evaluate('document.querySelector(".file-opener-browse").click(); true');
  const reopened=await waitFor('surviving B fresh picker',async()=>picker(await native('snapshot'),bRoot.hwnd));
  event('survivor-B-reopen','passed',{window:reopened});
  await native('close',{hwnd:reopened.hwnd});
  await waitFor('fresh picker dismissed',async()=>!picker(await native('snapshot'),bRoot.hwnd));
  await waitFor('fresh terminal focus',()=>b.evaluate('document.hasFocus() && !document.getElementById("file-opener-dialog").open && !document.getElementById("empty-reader-open").disabled && document.activeElement.id === "empty-reader-open"'));
  const image=await b.call('Page.captureScreenshot',{format:'png'});
  writeFileSync(output+'.png',Buffer.from(image.data,'base64'));
  event('survivor-native-WebView-screenshot','captured');
  await native('close',{hwnd:bRoot.hwnd});
  await waitFor('normal QA process exit',()=>appExited,12000);
  status='passed';
} catch(error) {
  event('scenario-failure','failed',{reason:error.message});
} finally {
  if(!appExited){
    if(!observerReady){event('cleanup','forced-owned-process-stop',{sent:app.kill()});status='failed';}
    else {
    try {
      let s=await native('snapshot');
      for(const w of s.windows.filter(w=>w.class==='#32770'))await native('close',{hwnd:w.hwnd});
      await delay(300);s=await native('snapshot');
      for(const w of roots(s))await native('close',{hwnd:w.hwnd});
      await waitFor('cleanup-owned-process',()=>appExited,12000);
    }catch{event('cleanup','forced-owned-process-stop');app.kill();status='failed';}
  }
  }
  for(const ws of sockets)ws.close();
  observer.stdin.end(JSON.stringify({id:++serial,op:'exit'})+'\n');
  writeFileSync(output,JSON.stringify({schemaVersion:1,kind:'native-desktop-automation-transcript',status,exeSha256:hash,inputProvenance:'Synthetic DOM activation and owned WM_CLOSE; never physical-input proof',configuration:'unique QA identifier; loopback debugging; fresh owned profile',events},null,2)+'\n');
}
console.log(JSON.stringify({status,output,eventCount:events.length}));
process.exitCode=status==='passed'?0:1;
