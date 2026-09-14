# 테스트 전략과 위험 게이트

## 1. 완료 판단 원칙

기능은 해당 fixture와 회귀 테스트가 없으면 미완성이다. 테스트 숫자를 Swift와 1:1로 맞추는 대신 각 기존 behavior branch를 Windows test ID로 추적한다.

권장 추적 형식:

```text
WIN-HIST-014  source: NavigationHistoryTests / PR #35
WIN-LINK-009  source: LinkHintMergeTests / PR #23
WIN-OPEN-021  source: PDFOpenServiceTests / PR #7
```

모든 E2E evidence에는 app version, WebView2 version, fixture SHA를 기록한다.

## 2. 테스트 도구

### TypeScript pure/unit

- Vitest
- fake timers for prefix/search/update timing and TOC numeric 399/400ms boundary/digit-and-Backspace deadline renewal
- table/property tests for parser, reducer, geometry round trips
- no DOM/Tauri/PDF.js imports in domain tests

### UI component

- Testing Library 또는 현재 UI framework의 semantic query 도구
- JSDOM은 focus/ARIA/state projection용
- 실제 layout/geometry 판정은 browser/native E2E로 넘김

### Rust

- `cargo test`
- temp directories and explicit fault injection
- protocol Range parser property/fuzz tests
- multi-process lock/transaction integration tests
- Windows-only tests는 `#[cfg(windows)]`로 실제 Windows runner에서 실행

### Tauri native E2E

Tauri 공식 권장 경로인 WebdriverIO + `@wdio/tauri-service`를 우선한다. frontend-only fast tests는 service의 browser mode 또는 일반 browser runner에서 Tauri IPC를 mock한다. packaged/native window tests는 Windows에서 embedded driver 또는 `tauri-driver` 경로를 사용한다.

Playwright를 frontend visual test에 이미 쓰고 있다면 유지할 수 있지만, Tauri binary 제어 표준으로 가정하지 않는다.

공식 근거:

- [Tauri WebDriver testing](https://v2.tauri.app/develop/tests/webdriver/)
- [Tauri WebDriver CI](https://v2.tauri.app/develop/tests/webdriver/ci/)

### OS/manual automation

WebDriver가 직접 다루기 어려운 native dialog와 installer는 별도 smoke로 검증한다.

- file picker
- Microsoft Print to PDF dialog/output
- Explorer Open With/default-app UI
- NSIS install/upgrade/uninstall
- Authenticode signature
- SmartScreen behavior
- Narrator/high contrast

가능하면 Windows UI Automation 또는 PowerShell 기반 검사로 자동화하되, 불안정한 UI automation을 unit test 대체로 쓰지 않는다.

## 3. PDF fixture manifest

| Fixture | 필수 계약 |
|---|---|
| `text-3-page.pdf` | open, page nav, literal search, text selection |
| `fixture-S-text-10.pdf` | normal first render와 visible sentinel |
| `fixture-L-text-300.pdf` | Range, virtualization, long search, memory |
| `fixture-F-raster-12.pdf` | raster render/zoom/print, no text false positive |
| `fixture-B-blank.pdf` | blank page render, no match |
| `image-only-2-page.pdf` | no OCR, no searchable text |
| `malformed.pdf` | stable malformed error |
| `locked.pdf` | password UI 없이 locked error |
| `empty.pdf` | 0-page/empty error가 만들 수 있는 parser fixture |
| `links.pdf` | URL, point/no-point GoTo, unresolved, foreign, text-only URL |
| `link-duplicates.pdf` | exact duplicate, adjacent same target, wrapped rectangles |
| `outline.pdf` | embedded outline wrapper, two visible depths, deeper child, duplicate/invalid/edge destination |
| `interactive.pdf` | forms, annotations, scripting, media suppression |
| `unicode-text.pdf` | Korean, composed/decomposed text, RTL sample |
| Unicode filename copy | 한글/공백/emoji path |
| long path copy | Windows long-path behavior |
| UNC copy | network path and transient error behavior |

`manifest.json` fields:

```json
{
  "schema_version": 1,
  "generator_version": "1",
  "files": [
    {
      "name": "fixture-S-text-10.pdf",
      "sha256": "...",
      "bytes": 0,
      "pages": 10,
      "expected_text": ["..."],
      "expected_annotations": { "links": 0, "forms": 0, "media": 0 },
      "expected_outline": { "row_count": 0, "rows": [] },
      "license": "test-generated"
    }
  ]
}
```

원본 PDF를 test 중 수정하지 않는다. 각 mutation-sensitive E2E는 before/after SHA를 비교한다.

## 4. 계약별 test mapping

### Action/input/config

Port source suites:

- `ActionRegistryTests`
- `BuiltInDefaultsTests`
- `ConfigValidatorTests`
- `KeySequenceEngineTests`
- `KeyGrammarAndPromptSafetyTests`
- generated reservation snapshots

추가 Windows cases:

- `D` migration error
- `C-A-S` canonical order
- `Ctrl+Shift+O` Open vs `Alt+Left` history
- AltGraph/composition/dead keys
- WebView accelerator interception
- physical `Ctrl+I` distinct from Tab when user-bound

### Open/recent/state

Port:

- `PDFOpenServiceTests`
- `RecentFileFilterTests`
- `RecentFilesStoreTests`
- `StateFileStoreTests`
- `ConfigFileStoreTests`
- config load/reload/write/reset integration tests

추가 Windows cases:

- file/path not found vs access denied/locked/network
- Unicode/long/UNC/junction path
- two-window and two-process concurrent update
- antivirus-like replace sharing violation
- partial batch Open With
- read-only file handle and source hash

### Reader/search/links/history

Port:

- `ReaderSearchCoordinatorTests`
- `ReaderSearchWorkflowTests`
- `NavigationHistoryTests`
- `N11NavigationRedTeamTests`
- `LinkHintLabels/Filter/MergeTests`
- `LinkHintIntegration/AcceptanceTests`
- `ReadOnlyBoundaryTests`
- `ReaderOutlineTests`
- `TOCWidgetTests`
- `TOCNumericRoutingTests`
- TOC cases in `PaneShellTests`, `ReaderSessionTests`, `ReaderWorkflowUITests`
- `PDFCapabilityPolicyTests`

추가 Windows cases:

- PDF.js layer geometry at four DPI/four rotations
- stale render/search generation
- Range loading and invalid Range
- generic viewer internal history disabled
- unsupported URL scheme
- form/script/media suppression

### Tabs/panes/window/UI

Port:

- `TabStoreTests`
- `ReaderSessionStoreTests`
- `PaneCoordinatorTests`
- `PaneShellTests`
- `PaneRedTeamTests`
- `FourPaneLiveDisplayTests`
- palette/help/recent/theme/indicator integration tests

추가 Windows cases:

- same-process two windows
- `Alt+F4`/`app.quit` current-window-only close와 last-window process exit
- second-instance argv handoff
- native titlebar/snap/resize
- `480×360` and 4-pane minimum
- Narrator/high contrast/text scaling

## 5. 단계별 hard gates

| Gate | 통과 조건 | 실패 시 |
|---|---|---|
| Scaffold | Windows build/launch, narrow capability, CI green | W02 금지 |
| Transport | packaged Range works or measured binary fallback ADR | feature work 금지 |
| Geometry | 4 DPI × 4 rotation에서 ≤1 CSS px | links/search 공개 금지 |
| Virtualization | visible ±2 이외 canvas 해제, task cancel | long doc 기능 미완성 |
| Read-only | interactive fixture inert, source hash unchanged | release 금지 |
| Input | IME/dead/AltGraph isolation, no default collision | keyboard feature 미완성 |
| History | producer/exclusion/rollback matrix green | Back/Forward 공개 금지 |
| Print | all-page system print, cancel cleanup, state invariant | release 금지 |
| TOC | packaged Windows `outline.pdf` toggle/scroll/numeric-jump E2E, before/after SHA, normalization, 399/400ms fake clock, active-pane routing, z-order/lifecycle | TOC 공개 금지 |
| Shell | Open With/single instance/file association clean VM | installer release 금지 |
| Signing | executable/installer signature verified | 공개 release 금지 |
| Accessibility | keyboard-only/Narrator/high contrast | release 금지 |

## 6. 성능과 자원 budget

### 구조적 hard budgets

- canvas/text/annotation DOM: visible pages + 상하 각 2-page overscan 이하
- active render tasks: mounted render candidates 이하
- geometry error: 최대 1 CSS px
- input-to-dispatch: sync path에서 50ms를 목표, 반복 100ms long task는 blocker
- source file: 전체 user action suite 전후 SHA 동일
- background tab/pane: active rendering 중단
- close: document worker, render tasks, Rust ref-count 모두 해제

### reference-machine provisional budgets

- `fixture-S`: cold first visible page ≤1.5s
- `fixture-L`: cold first visible page ≤2.5s
- 300-page continuous scroll 60초 후 working set이 page count와 선형 증가하지 않음
- scroll 종료 10초 후 reclaim 가능한 peak memory가 감소

시간과 MB 수치는 CI hardware마다 흔들리므로 W02에서 reference environment와 함께 고정한다. 이후 regression gate는 같은 machine/image baseline 대비 20% 이상 악화를 차단하는 방식이 더 안정적이다.

### 측정 지점

```text
open.requested
open.preflight.completed
pdf.metadata.ready
first.page.render.started
first.page.visible
search.started/completed/cancelled
render.task.created/cancelled/completed
document.closed/handle.released
print.prepare.started/dialog.opened/cleanup.completed
```

telemetry 전송은 비범위다. 측정은 local diagnostics/test logs에만 남긴다.

## 7. 위험 register

| Rank | 위험 | Trigger/evidence | 예방/완화 | Release gate |
|---:|---|---|---|---|
| 1 | PDF.js/WebView2 geometry drift | DPI/rotation screenshot delta | 단일 transform module, visual fixtures | ≤1px |
| 2 | large PDF memory 폭증 | canvas/task/working-set 증가 | Range + virtualization + cancellation | 구조 budget 통과 |
| 3 | keyboard/IME routing 오류 | composition 중 action 실행 | input state machine, real IME manual test | 0 misroute |
| 4 | print가 일부 page만 출력/OOM | output page count 또는 crash | hidden sequential print service | 1/12/300-page 통과 |
| 5 | state/config corruption | concurrent/fault tests | lock + temp flush + atomic replace | 모든 fault matrix 통과 |
| 6 | shell handoff가 path를 잃음 | second launch/Open With | single-instance first, normalized OpenRequest | clean VM 통과 |
| 7 | read-only 경계 누수 | form/editor/save UI 또는 hash 변화 | capability policy + fixture | 0 mutation surface |
| 8 | PDF.js internal API drift | dependency upgrade failure | adapter + exact pin + isolated upgrade PR | full adapter suite |
| 9 | updater/asset channel 혼선 | wrong OS/arch/version URL | Windows-specific metadata tests | exact asset match |
| 10 | code signing/SmartScreen | untrusted download | Authenticode + timestamp + reputation plan | signature verified |
| 11 | focus/overlay 회귀 | focus on body/closed pane | overlay owner reducer | all focus E2E |
| 12 | accessibility 회귀 | Narrator/forced-colors failure | semantic HTML + manual audit | checklist complete |
| 13 | TOC destination/routing/z-order 회귀 | wrong row, inactive-pane input, overlay under canvas | canonical outline model, pane ownership, re-raise | outline + 1–4 pane matrix |

## 8. 위험별 stop/escalation

### PDF transport

Custom protocol Range와 optimized binary fallback 둘 다 budget을 못 맞추면 PDF.js integration architecture를 재검토한다. 기능을 더 구현해 sunk cost를 늘리지 않는다.

### 인쇄

WebView2/PDF.js가 all-page system print를 안정적으로 만들지 못하면 release blocker다. default PDF viewer에 조용히 위임하는 것은 동작·privacy·focus가 달라 별도 제품 결정 없이는 허용하지 않는다.

### File transaction

Windows에서 crash-safe replace 의미를 증명하지 못하면 state/config write surface를 read-only로 임시 축소할 수는 있지만, 성공했다고 표시해서는 안 된다. feature scope 변경은 사용자/owner 결정이 필요하다.

### Signing

certificate/CI secret가 아직 없으면 unsigned internal artifact는 만들 수 있다. 공개 release는 blocked이고 문서에서 signed라고 표현하지 않는다.

## 9. CI 구성

### PR required checks

- `toc-packaged-e2e`: packaged Windows binary에서 `outline.pdf` toggle, `J/K`, numeric jump, 1–4 pane ownership, before/after SHA를 검증한다.

```text
frontend-lint-typecheck
frontend-unit
rust-fmt-clippy-test
contract-fixture-verify
tauri-debug-build-windows
webdriver-smoke-windows
markdown-links-and-diff-check
```

### Scheduled/nightly

- full PDF fixture E2E
- 4-DPI visual matrix where runner permits
- dependency audit
- 300-page performance/memory trace
- installer unsigned smoke

### Release candidate

- exact locked dependencies
- release Tauri build on Windows runner
- Authenticode sign and timestamp
- signature verification before upload
- clean Windows 10/11 VM install
- double-click/Open With
- print to PDF
- upgrade from prior Windows version when one exists
- uninstall without deleting user PDFs/config/state
- update notice targets exact Windows release asset

## 10. Manual QA checklist

### Files

- Browse valid/invalid/locked/empty; Issue #71 select/cancel/Escape/reopen, pointer visibility, focus return, and two-window HWND ownership (scoped operator/native evidence and remaining regression contract: §13)
- drag/drop
- Explorer double-click and Open With, app closed/open
- Unicode/long/UNC path
- stale recent missing vs denied

### Keyboard/focus

- all default bindings
- Open `Ctrl+Shift+O`, `Ctrl+W/P/N`, `Alt+Left/Right`, `Alt+F4`
- Korean IME, dead keys, AltGraph
- prefix timeout and status
- every overlay Esc/restore

### Reader

- 100/125/150/200% DPI
- monitor-to-monitor DPI move
- zoom/fit/rotation/anchor
- search replacement/wrap/clear
- ordinary URL/GoTo clicks; centered point destinations and complete visible landing pages without another scroll; no hint or destination-indicator UI
- selection/Copy-only context menu
- tabs and two independent windows; panes are excluded by ADR 0001
- retired TOC/hints absent; default t/J/K/f unassigned while j/k/F remain functional

### Windows integration

- native titlebar, minimize/maximize/snap/system menu
- Narrator/high contrast/text scaling
- Microsoft Print to PDF and cancel
- NSIS install/upgrade/uninstall
- offline update check
- signature properties and SmartScreen observation

## 11. Done evidence template

```markdown
### Contract
- macOS source/tests:
- related PRs:
- Windows delta:

### Automated evidence
- command:
- result:
- fixture + SHA:

### Native Windows evidence
- OS/WebView2/build:
- scenario:
- result/artifact:

### Invariants
- source PDF SHA unchanged:
- no leaked document/render task:
- parity matrix updated:

### Remaining risk
- none / linked issue:
```

## 12. Issue #53 reader-stability revalidation

The development-only `tools/qa/reader-stability.html` harness runs real PDF.js raster/text layers, `PdfTabSession`, navigation, search and ordinary links against committed fixtures. Its native boundary is in memory; no external URL is actually opened. It neither starts Modeleaf nor accesses durable user state. Serve the worktree with `npm run dev -- --host 127.0.0.1 --port 1433 --strictPort`; in hidden Chromium open `/tools/qa/reader-stability.html` and call one scenario per fresh page load:

- `await window.readerHarness.run()`: initial top, 12 forward movements, repeated end-of-document movements, 12 reverse movements, stable document extent, and empty-resource teardown.
- `await window.readerHarness.runNavigation()`: 30 adjacent requests (at most active plus latest pending), mixed first/last/opposite commands, one-page Fit, eight alternating zoom changes, and teardown.
- `await window.readerHarness.runSearch()`: first result before whole-document completion, three cross-page result moves, all 300 matches, retained user selection after completion, and teardown.

Follow-up scenarios additionally cover the previously missed shell transition:

- Load the harness with `?hidden=true`. It asserts zero initial host width/height using the production `.tab-host[hidden]` CSS, then uses the adoption/status publication flow to expose the host. Final first-page top must remain zero after Fit settles; the visible-from-start case alone is insufficient.
- `await window.readerHarness.runTabClose()`: two real PDF.js sessions, eviction of the inactive first tab, closure of the active second tab through `performTabClose`, visible successor geometry before activation, restored raster, and empty-resource teardown.
- `await window.readerHarness.runChrome()`: dev-transformed production chooser/tab renderer fragments, filenames of different lengths, exact 184×26 tab slots, long tab-name ellipsis, selected-tab horizontal visibility, borderless glyph-free Browse with keyboard focus indication, conditional Recent divider, and display-only full Recent paths. It checks directory middle-ellipsis, complete Unicode filenames, measured font reduction and restoration after resize, full accessible paths, and minimum-window/forced-color containment. `docs/evidence/issue53-recent-paths.json` records the measured layout and the corrected intrinsic-grid-width regression. This is isolated component evidence, not full native shell automation.
- Inject a final presentation failure after initial adoption commits. `OpenAdoptionOwnership.test.ts` executes the production adoption/terminal function bodies with the real workspace queue: retain the candidate descriptor until rejection, close it once on terminal rollback, publish the replacement before activation, and preserve the sanitized diagnostic.

- `await window.readerHarness.runLinks()`: actual `links.pdf` annotation-button clicks, four neutral `PDF link N` targets, no TOC/hint/indicator DOM/style/API, mocked native external receipt without opening a URL, verified internal landing/history, and empty-resource teardown. Fixture SHA-256: `dd5e2d598fa9e0bcae25e488541a898220d38b791991bc95796d7ba5f30044d4`. Registry publication waits native external dispatches, never the internal navigation requiring that publication; unmount retains all raw activation ownership.
- `await window.readerHarness.runLinkLanding()`: the deterministic three-page fixture clicks near page two's bottom. Verify achievable viewport centering, next-page raster/text already present when navigation reports success, clamped boundaries, valid history, no indicator and empty-resource teardown. No manual/synthetic scroll or harness synchronization may repair the product before the assertion.
- `retiredReaderFeatures.test.ts` verifies retired TOC/hint/indicator actions, DOM/styles, controller APIs and indicator-specific Escape capture are absent; retained overlays/editable input own normal Escape behavior.
Fixture SHA-256: `91abe1474b5d974b9b1b4a9adb26327ca83075bf07bb86113a2e8f2491cb84ab`. Keep source bytes unchanged. The harness is not a packaged transport benchmark or a substitute for the Windows matrix above.

Before restoring parity for the revised reader, separately authorize and retain packaged Windows evidence for: initial top/fit and mixed keyboard input, wheel/d/u at both edges, F then repeated +/- at supported DPI/rotation, cross-page search and query cancellation, and Ctrl+Shift+O → Ctrl+Shift+C with recent-state broadcast/restart behavior. Use disposable state for recent clearing; it must not erase PDFs, theme, indicator settings, or unknown state siblings. Rust fault tests additionally cover malformed state and pre-replace failure with durable/cache/revision rollback. Do not launch/stop an existing application or claim these native checks passed from Chromium/JSDOM results.

## 13. Issue #71 native Browse pointer gate

The earlier owner-UI-thread/posted-message change did not resolve the reported symptom. It preserves the native lifecycle below but is not an established cursor fix. The current candidate disables Chromium's `HideCursorWhileTyping` feature in both initial and newly created Modeleaf WebViews, preserving accessibility arguments. It prevents runtime-owned keyboard cursor hiding instead of adjusting ShowCursor counts, forcing focus, delaying Enter, or changing Windows pointer settings. This is an app-scoped policy: Modeleaf keeps the pointer visible while typing; other applications and OS settings are unchanged.

WebView2 Runtime 152 introduced a related hidden-cursor regression: [upstream #5687](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5687) and [#5708](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5708). Microsoft confirmed reproduction and reported investigation, not a released fix. On the reference workstation, running WebView2 was `152.0.4191.66`. A same-executable injected-input comparison observed `GetCursorInfo` success with flags `1 → 0 → 1` across Enter/native Show/cancel; movement while the owned picker was active did not restore visibility. With only process-scoped `--disable-features=HideCursorWhileTyping`, sampled flags remained `1`. This supports the runtime-feature diagnosis but does not replace the physical-input, cursor-inclusive gate. Retain failed probes and distinguish an actually displayed cursor from its reported global flags.

Focused Rust contract scope:

- reject null, stale, and wrong-thread owner HWNDs before COM dialog creation;
- run the picker operation only inside the dispatched callback;
- preserve cancel and picker-failure terminals;
- return terminal failures when main-thread dispatch is rejected or its callback is dropped;
- balance every successful `CoInitializeEx`, including `S_FALSE`, with `CoUninitialize`.

**Issue #71 verification evidence:** the operator reported that the following manual checklist worked on the hash-verified production candidate. [`issue71-cursor.json`](../evidence/issue71-cursor.json) records the exact attestation and its limits. Supplemental state-isolated packaged tests visibly rendered `text-3-page.pdf`, retained its SHA-256 before/after, verified owned picker/one-Escape focus return, and captured the cursor during Enter/Space-opened native dialogs. OS-composited recording and injected input are explicitly distinct from the operator's physical verification; no remote-client recording was supplied. The checklist remains the regression contract, and broader parity/release gates are unchanged:

1. Release the Open shortcut fully, then repeat filter-focus Enter, Tab-to-Browse Enter, focused-Browse Space, and a physical mouse click. Confirm the pointer remains visible over both Modeleaf and the native picker in empty and PDF-open windows. Synthetic input is a diagnostic comparison, not physical-input acceptance.
2. Select a committed PDF, then repeat with Cancel, Escape, and reopen; verify focus returns and the native open epoch is released exactly once after each terminal.
3. With two Modeleaf windows, launch Browse from each window and verify the picker is modal to the initiating live HWND without disabling or admitting into the other window.
4. Record the packaged build identity, Windows/WebView2 versions, observations or capture, and source PDF SHA-256 before/after.

Do not substitute unit/source assertions for this native observation, and do not use `ShowCursor`, `SetCursor`, or process-global cursor-state changes as remediation.

Nested native modal dialogs can delay an outer request's completion until the inner `Show` unwinds. Owner destruction invalidates the request token and prevents late selection admission, but does not promise immediate completion of an already-running outer picker. Native verification must close/cancel window A while window B's picker is open, then dismiss B and verify the surviving window can open a new picker; distinguish delayed completion from framework event starvation.

The review regression suite also found two concrete edge defects: Browse did not apply the existing legacy-IME/AltGraph guard, and an unscoped Tauri `Any` close-event listener disposed another window's frontend. `openChooserInput.test.ts` executes the production DOM handlers and real coordinator; `windowCloseOwnership.test.ts` executes the production subscription through the real Tauri JS API. The listener is now window-scoped, while global state/quit broadcasts remain global. The repaired [nested native transcript](../evidence/issue71-nested-lifecycle.json) proves that A can be destroyed during B's inner picker, unrelated native IPC remains responsive, and B restores native/DOM focus and opens/cancels a fresh picker. This is explicitly synthetic native lifecycle evidence, not physical cursor input.

Reproduce the bounded native lifecycle scenario from the worktree root using a separate QA identity (Node, PowerShell 7, and the normal Windows build toolchain are required):

```powershell
New-Item -ItemType Directory -Force .internal/evidence/issue71-replay | Out-Null
'{"identifier":"com.dsargus.modeleaf.issue71replay"}' | Set-Content .internal/evidence/issue71-replay/config.json
$env:CI = "true"
$env:CARGO_BUILD_JOBS = "1"
$env:CARGO_INCREMENTAL = "0"
npm run tauri -- build --debug --no-bundle --config .internal/evidence/issue71-replay/config.json
$hash = (Get-FileHash src-tauri/target/debug/modeleaf.exe -Algorithm SHA256).Hash.ToLowerInvariant()
node tools/windows/verify-browse-lifecycle.mjs src-tauri/target/debug/modeleaf.exe .internal/evidence/issue71-replay/result.json $hash
npm run tauri:build-debug
```

The driver refuses an existing result file, pins the selected executable, uses only its own HWNDs for synthetic close messages, and confines debugger connections to its reserved loopback port. The final build restores the ordinary application identity; do not distribute the QA-identity executable. Failed runs remain failed artifacts rather than being counted as native passes.
