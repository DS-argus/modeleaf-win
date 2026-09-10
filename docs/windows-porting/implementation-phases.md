# 단계별 구현 계획

> 현재 Windows snapshot은 owner-approved exclusions를 적용한 **49 actions(45 configurable + 4 fixed)**다. macOS 61-action 기준은 immutable 원본 reference이고 Windows gate의 action count가 아니다. TOC, `f` keyboard hints와 destination indicator/settings는 retired이며 `t`/`J`/`K`/`f`/`I`가 미할당이다. Ordinary PDF clicks/native authorization은 유지하고 finite `XYZ` points는 document edge가 허용하는 범위에서 viewport 중앙을 목표로 하며, destination transaction은 bounded visible-page materialization 뒤에만 canonical actual landing을 성공/history로 commit한다. `Fit`/`FitB` page-fit과 `FitR` rectangle-fit은 유지한다. ADR 0001과 [deferred reference](./deferred-toc-link-hints.md)가 scope와 archives를 고정한다.

이 순서는 dependency와 가장 위험한 가정을 먼저 검증하도록 설계했다. 각 `Wxx`는 새 Windows 저장소의 독립 Issue이자 기본적으로 하나의 reviewable PR이다. 한 PR이 너무 커지면 테스트 가능한 세로 slice로 나누되 gate를 건너뛰지 않는다.

명령 예시는 `pnpm` 기준이다. Windows 저장소가 이미 다른 package manager를 고정했다면 도구를 갈아엎지 말고 같은 검증 의미로 바꾼다.

## 전체 순서

| Issue | 결과 | 선행 조건 |
|---|---|---|
| W00 | v0.10.0 계약/fixture 동결 | 없음 |
| W01 | 보안이 잠긴 Tauri shell과 CI | W00 |
| W02 | PDF transport/geometry/print/outline feasibility 결정 | W01 |
| W03 | action/input/config/history/outline 등 pure TS core | W02 통과 |
| W04 | Rust document/config/state/open services | W03 interface |
| W05 | Windows shell, menu, action routing, focus | W03–W04 |
| W06 | single reader rendering/view/navigation | W02, W04–W05 |
| W07 | search + navigation history transactions | W06 |
| W08 | ordinary links + centered complete landings; hints/indicator retired | W06–W07 |
| W09 | tabs + panes + multiwindow + shell open | W04–W08 |
| W10 | retired embedded-outline TOC absence + retained-reader regression | W06–W09 |
| W11 | overlays + recent + config + themes + help | W03–W10 |
| W12 | production print path | W02 spike, W06–W11 |
| W13 | installer + update notice + parity/release hardening | W00–W12 |

## W00 — 계약, delta, fixture 동결

### 목표

“macOS와 비슷한 앱”이 아니라 `v0.10.0` 동작을 검증할 source of truth를 Windows repo에 만든다.

### 생성/수정 대상

```text
docs/parity-matrix.md
docs/adr/0001-windows-deltas.md
docs/pr-history.md
fixtures/pdf/*
fixtures/manifest.json
tests/contract/*
```

### 작업

1. 이 폴더 문서를 Windows repo `docs/windows-porting/`에 복사하고 mac baseline SHA를 고정한다.
2. parity matrix 각 row에 `not-started | partial | parity | intentional-delta | blocked` 상태를 둔다.
3. macOS 61 Action ID와 indicator presets를 immutable baseline으로, owner-approved exclusions를 적용한 Windows 49 Action ID/retained defaults를 별도 machine-readable snapshot으로 고정한다.
4. macOS test support의 performance fixtures를 PDF 파일로 생성해 Windows repo에 commit한다.
5. `manifest.json`에 filename, SHA-256, byte size, page count, expected text/link/annotation/outline sentinel을 기록한다.
6. malformed, locked, image-only, interactive, Unicode filename, long-path, links fixture를 추가한다.
7. embedded-outline fixture에 single wrapper, 두 visible depths, deeper hidden child, duplicate destination, invalid row, page-edge destination sentinel을 넣는다.
8. fixture license/source/generator version을 기록한다.
9. Windows delta ADR에 키 문법, history key, same-process multiwindow, paths, native titlebar, notify-only update를 승인된 결정으로 기록한다.

기존 `PDFFixtureFactory`는 AppKit/PDFKit를 사용하므로 Windows CI에서 직접 실행하지 않는다. 생성 결과를 commit하거나 portable generator를 별도 도구로 만든다.

### 검증

- manifest의 모든 SHA/page count가 검증된다.
- expected sentinel이 실제 PDF와 일치한다.
- macOS baseline Action ID count는 61이고 current Windows snapshot은 49(45 configurable + 4 fixed)다.
- fixture generator를 다시 실행하면 동일 manifest 또는 의도된 차이를 낸다.

### Exit gate

- 모든 기능이 parity/delta 중 하나로 정의돼 있다.
- `pr-history.md` supersession table의 모든 row가 문서화돼 있다.
- feature 구현은 아직 시작하지 않았다.

## W01 — Tauri 2 shell, toolchain, security, CI

### 목표

빈 Windows 앱, strict security baseline, 반복 가능한 build/test pipeline을 만든다.

### 생성/수정 대상

```text
package.json
pnpm-lock.yaml
tsconfig.json
vite.config.*
src/main.ts
src/ui/shell/*
src-tauri/Cargo.toml
src-tauri/tauri.conf.json
src-tauri/capabilities/main.json
src-tauri/src/main.rs
.github/workflows/ci.yml
```

### 작업

1. Tauri 2, Rust stable, TypeScript strict mode를 설정한다.
2. PDF.js는 아직 viewer를 만들지 말고 exact version/worker packaging만 lock한다.
3. native titlebar, initial `1040×760`, minimum `480×360` window를 만든다.
4. remote script/CDN이 없는 CSP를 설정한다.
5. empty capability에서 시작하고 실제 command/plugin을 추가할 때만 권한을 연다.
6. single-instance plugin을 setup 첫 plugin으로 등록한다.
7. window별 opaque ID와 root store 생성/teardown skeleton을 만든다.
8. recorded Windows reference workstation에서 install, lint, typecheck, unit, Rust fmt/clippy/test, `tauri build --debug` 또는 equivalent smoke를 실행한다.
9. dependency license/security audit는 local gate로 실행한다. GitHub Actions는 release phase 전까지 authoritative gate가 아니다.

Developer/CI build prerequisites (end-user runtime prerequisites가 아님):

- Microsoft C++ Build Tools
- WebView2
- Rust MSVC toolchain
- Node/pnpm pinned version

### 테스트

- Rust app-state/window registry unit tests
- frontend empty shell component test
- single-instance registration order test 또는 source assertion
- CSP/capability snapshot test
- recorded reference workstation debug build/runtime smoke

### Exit gate

- empty app가 Windows에서 launch/close/relaunch된다.
- `Ctrl+N` placeholder가 같은 process에서 두 번째 window를 만들 수 있다.
- broad fs/shell capability가 없다.
- 기록된 reference workstation의 local quality gate가 통과한다.

### Stop condition

W01–W12는 기록된 reference workstation에서 계속 진행하되 clean-VM 재현을 주장하지 않는다. Node/Rust/MSVC가 없는 clean Windows 10/11 VM의 installer, WebView2 bootstrap, multiwindow/single-instance 검증은 W13으로 이관하며, 통과하지 못하면 release blocker다.

## W02 — PDF feasibility spike

### 목표

기능을 쌓기 전에 가장 위험한 다섯 가지를 증명한다.

1. local PDF Range transport
2. PDF.js worker/assets packaged loading
3. canvas/text/annotation geometry와 HiDPI
4. long-document virtualization/memory
5. Windows system print path

### 생성/수정 대상

```text
src-tauri/src/document/{handle,registry,protocol,range}.rs
src/pdf/spike/*
tests/e2e/pdf-spike.spec.ts
tests/visual/pdf-geometry.spec.ts
docs/adr/0002-pdf-transport.md
docs/adr/0003-pdfjs-integration.md
docs/evidence/w02/*
```

Spike code는 버리는 demo가 아니라 production interface를 작게 검증하는 코드다. UX나 전체 reader command는 구현하지 않는다.

### 작업

1. Rust가 read-only handle을 열고 opaque `DocumentId`를 발급한다.
2. custom URI protocol에서 `HEAD`, full `GET`, `Range: bytes=start-end`, invalid/multi-range를 처리한다.
3. PDF.js `getDocument({ url })`가 packaged app에서 Range request를 보내는지 trace한다.
4. worker/CMap/standard font/wasm assets를 모두 local bundle한다.
5. 한 page에 canvas, text layer, annotation link overlay를 만든다.
6. rotation 0/90/180/270, DPI 100/125/150/200에서 좌표를 측정한다.
7. 300-page fixture를 placeholder + visible ±2 overscan으로 scroll한다.
8. render task cancel/unmount 후 canvas backing memory를 해제한다.
9. image-only, malformed, locked, interactive, internal/external link fixtures를 연다.
10. `getOutline()`이 null/empty/nested/duplicate/invalid/edge destinations를 안정적으로 반환·resolve하는지 측정한다.
11. hidden print surface로 Microsoft Print to PDF dialog를 여는 prototype을 만든다.
12. print 전후 reader state와 source SHA를 비교한다.

### 계측

`docs/evidence/w02/environment.md`에 최소한 다음을 기록한다.

- CPU/RAM/GPU
- Windows build
- WebView2 version
- app/PDF.js versions
- fixture SHA
- cold/warm first visible page 시간
- 300-page 60초 scroll의 process working set 시작/peak/end
- 최대 mounted canvas/layer와 active RenderTask 수
- 각 DPI/rotation의 geometry delta

Provisional rejection budgets:

- first visible page: text-10 1.5초, text-300 2.5초 이내 on recorded reference machine
- geometry delta: 최대 1 CSS px
- live canvas: visible pages + 상하 overscan 2페이지를 초과하지 않음
- 300-page scroll 종료 10초 후 working set이 peak에서 감소하고 계속 page count에 비례해 증가하지 않음
- input dispatch long task: 100ms 초과가 반복되지 않음

성능 시간은 CI absolute gate로 바로 고정하지 않고 reference machine baseline으로 기록한다. 구조적 게이트인 Range, layer count, geometry, task cancellation은 즉시 hard gate다.

### 결정

- custom protocol + Range가 통과하면 production transport로 확정한다.
- 실패하면 Tauri optimized binary response의 one-shot `ArrayBuffer`를 같은 fixture로 측정한다.
- base64/JSON은 대안이 아니다.
- 두 방식 모두 메모리/first-page gate를 만족하지 못하면 PDF.js/Tauri 조합을 재검토하는 architecture blocker다.

### Exit gate

- `0002-pdf-transport.md`에 evidence와 최종 선택이 있다.
- geometry/virtualization/read-only/print prototype가 모두 통과한다.
- 실패 항목을 “나중에 고침”으로 두고 W03 이후를 시작하지 않는다.

## W03 — Pure TypeScript product core

### 목표

UI/PDF/Tauri 없이 v0.10.0의 state machines를 재현한다.

### 생성/수정 대상

```text
src/domain/actions/*
src/domain/input/*
src/domain/config/*
src/domain/navigation/*
src/domain/recent/*
src/domain/tabs/*
src/domain/theme/*
src/domain/links/*
src/domain/update/*
```

### 구현 순서

1. 49 Action IDs/descriptors/scopes/repeat/fixed flags
2. input contexts와 action availability
3. Windows key token grammar/parser/normalizer
4. sequence trie, prefix fallback, 400ms timer semantics
5. prompt-safe/reserved binding validation
6. strict sparse config schema/default overlay/diagnostics
7. command palette fuzzy filter/enabled-first ordering
8. recent filename fuzzy filter
9. annotation-link DTO normalization과 exact duplicate merge
10. navigation snapshot/history/search epoch
11. tab store
12. themes/state DTOs
13. semantic version update comparison

### 테스트 이전표

| macOS tests | Windows target |
|---|---|
| `ActionRegistryTests`, `BuiltInDefaultsTests` | action/default snapshots |
| `KeySequenceEngineTests`, `KeyGrammarAndPromptSafetyTests` | key/parser/context tests |
| `ConfigValidatorTests` | strict config tests |
| `CommandPaletteTests` | palette filter/availability |
| `RecentFileFilterTests` | filename fuzzy filter |
| `ReaderLink`/`LinkHintMerge` baseline tests | retained annotation DTO/exact-dedup rules |
| `NavigationHistoryTests` | history/search epoch |
| `TabStoreTests` | tabs |
| theme/update core tests | remaining DTOs |

### Exit gate

- pure modules에서 DOM, Tauri, PDF.js import가 없다.
- Windows default keymap collision snapshot이 green이다.
- exact duplicate link rule와 100-position history cap이 고정된다.
- test coverage가 모든 reducer branch와 validation error code를 포함한다.

## W04 — Rust document, config, state, open services

### 목표

OS 경계의 모든 실패를 typed outcome으로 만들고 durable transaction을 검증한다.

### 생성/수정 대상

```text
src-tauri/src/commands/{document,config,state}.rs
src-tauri/src/document/*
src-tauri/src/persistence/{atomic_write,lock}.rs
src/platform/tauri-commands.ts
src/application/open-document/*
```

### 작업

1. `OpenError` enum을 unsupported/missing/unreadable/malformed/locked/empty로 고정한다.
2. open handle registry와 ref-count close를 productionize한다.
3. config read size/UTF-8 gate를 구현한다.
4. Write Default exclusive create와 Reset `.bak` transaction을 구현한다.
5. `selected_theme`와 `recent_files`만 owned state field로 갱신하는 read/merge/replace transaction을 구현한다.
6. Windows lock/replace wrapper에 fault injection point를 둔다.
7. unknown state field retention과 malformed supported-sibling isolation을 구현하며 기존 `link_destination_indicator`를 unknown metadata로만 보존한다.
8. recent max 15/dedupe/prune semantics를 application service와 연결한다.
9. frontend command payload를 최소화하고 error에 raw sensitive content를 넣지 않는다.
10. retired indicator DTO와 native read/commit command를 command surface에 노출하지 않는다.

### 테스트

- temp dir Rust unit/integration
- concurrent process update
- lock timeout
- failure before/after temp flush, backup replace, final replace
- Unicode/long/UNC path
- read-only source handle
- invalid range/custom protocol fuzz cases
- frontend contract serialization tests
- selected-theme/recent mutations preserve a retired-indicator sentinel as unknown metadata, while indicator-specific IPC/DTOs remain absent

### Exit gate

- 모든 open source가 한 service를 통한다.
- config/state write failure가 성공으로 보고되지 않는다.
- aborted operation 뒤 temp/lock garbage가 정리된다.
- source PDF write access가 없다.

## W05 — App shell, menu, action dispatch, focus

### 목표

빈 reader shell에서 모든 action이 한 registry와 router를 통해 동작하도록 만든다.

### 생성/수정 대상

```text
src/application/commands/*
src/ui/shell/*
src/ui/status/*
src/ui/overlays/overlay-state.ts
src/platform/tauri-events.ts
src/styles/*
```

### 작업

1. Windows menu model을 registry projection으로 만든다.
2. root key adapter와 input context router를 연결한다.
3. native menu/WebView/browser accelerator보다 app route가 우선하도록 처리한다.
4. window → pane → tab active projection을 만든다.
5. status bar와 empty state를 구현한다.
6. overlay/focus owner reducer와 기본 focus restoration을 구현한다.
7. 7개 theme ID 각각의 12개 semantic tokens를 CSS variables로 옮기고 전체 set을 snapshot한다.
8. stable test IDs와 accessible landmarks를 추가한다.

### 테스트

- action scope/availability component tests
- handled/unhandled `preventDefault` tests
- IME/dead-key/AltGraph adapter tests
- empty window focus/Narrator semantics
- two-window action routing isolation
- 한 window의 `app.quit`/`Alt+F4`가 다른 window를 종료하지 않는 lifecycle test

### Exit gate

- menu/palette/help에 쓸 data source가 registry 하나다.
- no-document global actions와 disabled reasons가 정확하다.
- focus owner state가 body로 유실되지 않는다.

## W06 — Single-reader rendering, view modes, basic navigation

### 목표

한 window/한 pane/한 tab에서 실제 PDF 읽기 loop를 완성한다.

### 생성/수정 대상

```text
src/pdf/{pdfjs-adapter,document-session,page-viewport}.ts
src/pdf/{virtualizer,render-scheduler,text-layer,annotation-layer}.ts
src/ui/reader/*
```

### 작업

1. open request → PDF session → first visible page → tab commit transaction
2. vertical continuous placeholders와 virtualizer
3. Fit Width default, Fit Page, Actual Size, manual zoom 0.1..8
4. scroll small/large, next/previous, first/last, page prompt
5. 90-degree pane-local rotation과 anchor restore
6. text selection/Copy-only context menu
7. teardown/cancel/ref-count release
8. `getOutline()` raw tree와 destination resolution adapter를 준비하되 TOC UI는 W10에서 구현한다.

### 테스트

- valid/malformed/locked/empty fixtures
- view mode reducer and anchor unit tests
- keyboard/mouse scroll E2E
- DPI visual tests
- first/last after continuous scroll regression for PR #41
- large fixture virtualization instrumentation
- read-only SHA invariant

### Exit gate

- 한 문서의 기본 읽기 loop가 fixture-backed E2E로 끝까지 동작한다.
- stale render/geometry가 없다.
- close 후 worker/canvas/handle leak이 없다.

## W07 — Search와 app-owned navigation history

### 목표

PDF.js 내부 history에 의존하지 않고 search와 meaningful jumps를 transaction으로 연결한다.

### 작업

1. query generation/cancel/latest-wins coordinator
2. embedded-text literal case-insensitive search
3. transient all/active highlights
4. next/previous wrap
5. page-space landing capture/restore
6. 100-position Back/Forward
7. search epoch arm/replace/coalesce/end
8. failed/same/stale/no-result exclusion

### 테스트

- `NavigationHistoryTests` 전부 포팅
- `ReaderSearchCoordinatorTests` state machine 포팅
- rapid query replacement E2E
- image-only/no-text and blank/no-match distinction
- history producer/exclusion matrix
- current zoom/rotation/search 유지 restore

### Exit gate

- search/historical landing마다 prepare/verify/commit evidence가 있다.
- ordinary movement가 history count를 바꾸지 않는다.
- `Alt+Left/Right`가 WebView nav와 충돌하지 않는다.

## W08 — Ordinary links and centered complete landings

> Issue #53 owner delta: ordinary annotation clicks와 native authorization은 유지하고 keyboard hints와 destination indicator/settings는 제거한다. hint source/tests는 `7e00424d30c5ffeab5a846d087236371644af53a`, indicator source/tests는 `dedcff8513e034efb904ef7d50fd59cc11444798`의 [deferred reference](./deferred-toc-link-hints.md)에만 남긴다. 이 gate는 pass claim이 아니라 current acceptance contract다.

### 목표

Ordinary internal/external link activation을 stale-safe transaction으로 유지하고 point destination을 가능한 viewport 중앙에 놓은 뒤 전체 visible landing range를 bounded하게 준비한다.

### 작업

1. display-intent annotation Link만 canonical DTO로 map한다.
2. exact duplicate만 제거하고 adjacent/wrapped same-target annotation은 독립 pointer target으로 유지한다.
3. external URL은 Rust `http`/`https` allowlist를 정확히 한 번 거친다.
4. internal GoTo는 origin capture → resolve → guarded move → scroll settlement → landing-viewport materialization → actual landing capture/verify → history commit transaction을 사용한다.
5. finite `XYZ` x/y는 rotation-aware viewport midpoint를 목표로 하고 unspecified axis는 기존 canonical 축을 보존하며 document edge에서 actual scroll을 clamp한다.
6. `Fit`/`FitB` page-fit과 `FitR` rectangle-fit placement는 point-centering으로 바꾸지 않는다.
7. 결과 viewport와 교차하는 모든 page를 existing resident window/resource budget 안에서 materialize한 후에만 success/history를 commit한다.
8. newer navigation, lifecycle change와 raw user scroll로 stale work를 fence하고 failed/cancelled work는 rollback/compensation한다.
9. `link.hint`, `indicator.picker`, `f`, `I`, hint/indicator DOM·style·timer·settings·IPC를 제거하며 manual/synthetic scroll, detached repair와 unbounded residency를 추가하지 않는다.

### 테스트 요구

- exact duplicate vs adjacent/wrapped fixture와 text-only URL exclusion
- URL allowlist, unsupported/unresolved no-op와 one-authorization assertion
- finite/partial `XYZ`의 supported rotation/DPI midpoint placement와 first/last document-edge clamp
- `Fit`/`FitB` page-fit 및 `FitR` rectangle-fit non-regression
- click completion 직후 별도 scroll 없이 visible landing pages의 raster/text가 모두 준비되는 fixture
- rapid supersession, lifecycle change, raw user scroll, render failure와 cleanup/resource-bound cases
- retired hint/indicator action, default, DOM, CSS, controller option, timer, native IPC/state authority 부재
- 모든 scenario 전후 source PDF SHA-256 불변

### Exit gate

- canonical clamped actual landing과 complete bounded visible-page materialization이 성공/history의 전제다.
- failed/unresolved/stale/cancelled activation은 history를 만들거나 newer input을 덮지 않는다.
- ordinary internal/external pointer clicks는 indicator 없이 동작하고 `f`/`I`는 미할당이다.
- fixture/unit/browser evidence만으로 packaged WebView2/native/DPI/accessibility gate 통과를 주장하지 않는다.

## W09 — Tabs, panes, multiwindow, Explorer handoff

### 목표

전체 document organization과 Windows shell entry를 완성한다.

### 작업

1. pane별 tab store/UI와 compact tab layout
2. binary split tree, max 4, divider min 160
3. directional focus와 active projection
4. verified-position-only duplicate transaction
5. unsplit/close rollback-safe teardown
6. same-process `Ctrl+N` multiwindow
7. first/second instance argv routing
8. drag/drop과 Explorer Open With

### 테스트

- tab close/activation/order pure + component tests
- 1–4 pane topology and rollback red-team tests
- two-window independence E2E
- 한 창 close 후 다른 창의 tab/history/handle이 유지되는 E2E
- second launch while overlay/prompt is active
- batch argv partial failures
- min `480×360` and four-pane behavior

### Exit gate

- tabs/history/search/rotation이 pane/window 경계를 넘어 새지 않는다.
- duplicate failure에 UI 흔적이 없다.
- 두 번째 process가 남지 않고 path가 정확히 한 번 열린다.

## W10 — Retired embedded-outline TOC

> Issue #53 owner delta: 현재 Windows 제품에는 TOC runtime/model/action/UI가 없다. Immutable macOS 계약과 마지막 Windows source/tests `7e00424d30c5ffeab5a846d087236371644af53a`는 [deferred redevelopment reference](./deferred-toc-link-hints.md)로만 보존하며 active code에 다시 연결하지 않는다.

### 목표

TOC 부재를 명시적으로 고정하면서 ordinary reading, search, text selection, annotation clicks와 history를 보존한다.

### 작업

1. `toc.toggle`, `toc.scrollDown`, `toc.scrollUp`과 기본 `t`/`J`/`K`를 registry/config/menu/palette/help/router에서 제외한다.
2. outline widget/model/selector/controller DOM, CSS와 lifecycle callback을 current runtime에서 제거하고 dormant flag나 alias를 두지 않는다.
3. ordinary internal/external link activation, `j`/`k`, `F`, text/search ownership과 source-PDF read-only boundary를 유지한다.
4. archived TOC source/tests는 Git reference에서만 조회하고 현재 product tree로 복사하지 않는다.

### 테스트 요구

- action/default snapshots는 TOC actions와 `t`/`J`/`K` routing 부재를 요구한다.
- shell/controller contract는 TOC owner, widget, model, timer, CSS와 DOM ID 부재를 요구한다.
- retained-reader fixture는 ordinary click/search/scroll/Fit Page와 cleanup을 함께 검증해야 한다.
- embedded-outline fixture를 ordinary reader로 열어도 synthetic sidebar/TOC를 만들지 않고 source PDF SHA-256을 보존해야 한다.

### Exit gate

- current action/runtime/DOM/style surface에서 TOC가 callable 또는 visible하지 않다.
- retirement 검증이 ordinary links, search, scroll, fit, history 또는 teardown을 약화하지 않는다.
- packaged Windows acceptance가 실행되기 전에는 W10 native completion이나 release readiness를 주장하지 않는다.

## W11 — Recent, palette, help, config, themes, settings UX

### 목표

나머지 chrome과 persistence UX를 최종 action registry에 연결한다.

### 작업

1. unified Open/Recent overlay와 inline errors
2. command palette 12-row/enabled-first/disabled reason
3. adaptive keyboard help
4. page/search prompt polish와 suspended focus restore
5. config launch/reload diagnostics
6. Write Default/Reset Config UI
7. theme picker preview/commit/cancel
8. status diagnostics/update placeholder/version
9. `CONFIG.md`와 default TOML 생성/snapshot

### 테스트

- current overlay/config/theme integration suites를 기능별 포팅
- minimum window/keyboard-only/Narrator/high contrast
- recent missing vs denied prune matrix
- two-window concurrent state updates
- config artifact sync snapshot
- no `Cmd`, `⌘`, Homebrew residue scan

### Exit gate

- 모든 overlay가 exact focus restore 계약을 지킨다.
- docs/default/menu/palette/help가 live registry와 동기화된다.
- persistence 실패를 숨기지 않는다.

## W12 — Production print

### 목표

W02 prototype를 memory-bounded, cancellable production feature로 만든다.

### 작업

1. `PrintService` adapter와 action availability
2. hidden print document/container lifecycle
3. page size/order/orientation/rotation reference behavior
4. sequential render와 progress/cancel
5. system dialog open/result/focus restoration
6. print artifacts cleanup

### 테스트

- 1-page text, 12-page raster, blank, rotated fixture
- 300-page stress/cancel
- Microsoft Print to PDF output page count/visual sentinel
- active state/history/source hash invariants
- no-document/closed-document races

### Exit gate

- 기록된 reference workstation에서 print dialog가 반복 재현된다.
- cancel/error 후 app가 정상 입력 상태로 돌아온다.
- 실패 시 다른 viewer로 자동 위임하지 않는다.

## W13 — Installer, update notice, parity hardening, release candidate

### 목표

서명된 NSIS 설치 파일과 v0.10.0 parity evidence를 만든다. 이 Issue의 feature PR은 release 자체와 분리한다.

### 작업

1. Tauri `bundle.fileAssociations` 기반 `.pdf` association과 packaged registry/uninstall 검증
2. NSIS x64 `currentUser` + WebView2 download bootstrapper
3. Authenticode signing/timestamp pipeline
4. Windows-specific release asset/metadata naming
5. GitHub latest check와 notify-only banner/overlay
6. download/release page opener
7. clean Windows 10/11 VM에서 NSIS install/launch, WebView2 bootstrap, multiwindow/single-instance, Open With, print dialog/output, upgrade, uninstall automation 또는 scripted checklist
8. parity matrix 전 row evidence 연결
9. performance/accessibility/security final audit
10. user docs와 troubleshooting

### CI/release checks

```text
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
pnpm test:e2e
pnpm tauri build
signature verification
installer smoke on clean VM
```

### Exit gate

- parity matrix에 `partial`, `blocked`, undocumented delta가 없다.
- 모든 hard risk gate가 evidence link를 갖는다.
- signed installer가 install/Open With/print/update notice/uninstall smoke를 통과한다.
- clean Windows 10/11 VM에서 WebView2 bootstrap과 multiwindow/single-instance가 재현된다.
- source PDF mutation test가 전체 suite에서 green이다.
- release/tag/publish는 별도 승인 없이는 실행하지 않는다.

## 단계 공통 PR 규칙

모든 PR은 다음을 포함한다.

- 연결된 Issue와 acceptance checklist
- 변경한 parity rows
- 현재 macOS 근거 file/test/PR
- 의도적 Windows delta 여부
- 실제 실행한 명령과 결과
- screenshot/trace/fixture SHA 등 필요한 evidence
- 남은 risk와 follow-up Issue

한 PR에서 dependency upgrade, 기능 추가, 대규모 UI redesign, release를 섞지 않는다. PDF.js/Tauri major/minor upgrade는 별도 PR에서 전체 adapter/fixture suite를 실행한다.
