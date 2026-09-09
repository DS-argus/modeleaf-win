# 기능별 포팅 계약

각 기능은 `v0.10.0 계약 → Windows 구현 → 알려진 실패 모드 → acceptance` 순서로 구현한다. “비슷하게 보인다”가 아니라 observable behavior와 테스트가 같아야 한다.

## 1. 제품 범위와 읽기 전용 경계

### v0.10.0 계약

- 로컬 PDF Viewer다.
- 허용: 표시, 스크롤, 텍스트 선택, 포인터 공존, 링크 활성화, embedded-outline TOC, Copy, 앱 action을 통한 탐색/줌/검색/문서/탭/인쇄.
- 금지: form 편집, annotation 편집, allowlist 밖 context menu, export/Save As, native PDF history, embedded media.
- context menu는 선택 텍스트가 있을 때 `Copy`만 활성화한다.
- 공개 action/menu vocabulary에 OCR, bookmark 작성·편집, annotation 작성·편집, portal, script, plugin, macro가 없어야 한다. PDF embedded outline을 읽는 `toc.*` action은 허용된다.

근거:

- [`PDFCapabilityPolicy.swift`](../../PDFReaderApp/Reader/PDFCapabilityPolicy.swift), 특히 41–60행
- [`ReaderPDFView.swift`](../../PDFReaderApp/Input/ReaderPDFView.swift), 특히 133–209행
- [`ProductScopeTests.swift`](../../PDFReaderAppTests/ProductScopeTests.swift), 특히 8–49행
- PR [#1](https://github.com/DS-argus/modeleaf/pull/1), [#22](https://github.com/DS-argus/modeleaf/pull/22)

### Windows 구현

1. `PdfCapability` matrix를 pure TS 상수로 먼저 작성한다.
2. PDF.js generic viewer의 editor/form/scripting/download surface를 켜지 않는다.
3. annotation layer는 link hit target만 interactive하게 만든다.
4. text layer는 selection과 Copy만 허용한다.
5. context menu event를 가로채 선택이 있을 때만 Copy row를 만든다.
6. 모든 document/view 명령은 action registry를 통해서만 호출한다.
7. Rust는 PDF source를 read-only handle로 연다.

### Windows 차이와 주의사항

- PDF.js의 `annotationStorage`나 form widget이 기본적으로 생기지 않는다고 가정하지 않는다. fixture로 DOM과 저장 가능 상태가 없음을 증명한다.
- PDF embedded JavaScript, Launch, attachment, rich media는 무시하고 diagnostic도 독서를 방해하지 않게 한다.
- external URL은 처음에는 `http`/`https`만 허용한다. 이는 임의 protocol 실행을 막는 의도적 보안 차이다.
- browser 기본 context menu, drag image/save, canvas download 기능이 새 write/export 경로가 되지 않게 막는다.

### Acceptance

- interactive fixture에서 input/editor/media가 focusable하지 않다.
- action registry는 정확히 61개이고 forbidden vocabulary test가 통과한다.
- Copy 외 context menu가 없다.
- 모든 reader action 후 원본 PDF SHA-256이 동일하다.

## 2. 파일 열기와 최근 파일

### v0.10.0 계약

- 로컬 file URL만 허용한다.
- 존재하는 regular file이며 읽을 수 있어야 한다.
- malformed, password-locked, 0-page PDF를 서로 다른 오류로 거부한다. password prompt는 없다.
- Open overlay 첫 row는 `Browse…`, 이후 최근 PDF 최대 15개다.
- recent filter는 전체 경로가 아니라 filename fuzzy match다.
- 성공한 `.pdf` open만 기록하고 같은 absolute path는 최신 한 건으로 올린다.
- stale recent는 missing/path-not-found일 때만 prune한다. permission/transient 오류는 지우지 않는다.
- Finder Open With, drop, Browse, recent가 같은 open path로 합쳐진다.

근거:

- [`PDFOpenService.swift`](../../PDFReaderApp/Reader/PDFOpenService.swift), 7–30행과 99–147행
- [`RecentFilesStore.swift`](../../PDFReaderCore/Recent/RecentFilesStore.swift), 20–105행
- [`RecentFileFilter.swift`](../../PDFReaderCore/Recent/RecentFileFilter.swift)
- [`RecentFilesOpenOverlayView.swift`](../../PDFReaderApp/Window/RecentFilesOpenOverlayView.swift)
- PR [#4](https://github.com/DS-argus/modeleaf/pull/4)–[#9](https://github.com/DS-argus/modeleaf/pull/9), [#18](https://github.com/DS-argus/modeleaf/pull/18)

### Windows 구현

모든 입구를 다음 DTO로 정규화한다.

```ts
type OpenRequest = {
  paths: string[];
  source: "dialog" | "drop" | "shell" | "recent" | "duplicate";
  targetWindowId: string | null;
  targetPaneId: string | null;
};
```

Rust preflight 순서:

1. absolute Windows path로 parse한다.
2. device path나 unsupported URI를 거부한다.
3. metadata를 따라 regular file인지 확인한다. directory는 거부한다.
4. read-only handle을 연다.
5. PDF.js open 결과에서 malformed/password/empty를 분류한다.
6. 첫 visible page render와 tab insertion이 성공한 뒤 recent에 기록한다.

파일 대화상자와 installer association은 `.pdf`로 제한하지만, open service 자체는 확장자만으로 유효한 문서를 거부하지 않는다. 현재 macOS open service도 local/regular/readable과 실제 PDF load 결과를 검증할 뿐 확장자를 강제하지 않는다. 단, recent 목록에는 현재 계약대로 case-insensitive `.pdf` path만 기록한다.

Recent identity는 가능한 경우 Windows file identity를 ephemeral dedupe에 쓰고, state에는 현재 계약대로 `absolute_path`와 `last_opened_at`만 저장한다. display는 사용자가 연 path 표기를 보존한다. 단순 lowercase만으로 identity를 영구 저장하지 않는다.

### Windows 차이와 주의사항

- Explorer double-click/Open With는 installer file association과 single-instance argv handoff를 모두 거친다.
- UNC, spaces, Korean/Unicode, long path, junction/symlink를 fixture로 확인한다.
- 확장자가 없거나 다른 파일도 명시적으로 전달되면 내용 검증 결과로 열 수 있지만 recent에는 기록하지 않는다. dialog와 Open With의 일반 경로는 `.pdf` filter/association으로 제한한다.
- network share가 일시적으로 unavailable하거나 access denied이면 recent를 prune하지 않는다.
- 두 창에서 동시에 recent를 갱신해도 lost update가 없어야 한다.
- source file이 열린 뒤 교체돼도 path를 다시 열지 말고 기존 read handle을 사용한다.
- 파일을 열 수 있었지만 첫 render 또는 tab commit이 실패하면 recent를 기록하지 않고 handle을 회수한다.

### Acceptance

- dialog/drop/Open With/recent/duplicate가 동일한 preflight 오류 enum을 반환한다.
- 16번째 성공 open에서 가장 오래된 항목만 제거된다.
- file-not-found/path-not-found만 자동 prune된다.
- partial batch open은 성공 파일을 열고 실패 파일을 한 diagnostic에 요약한다.
- 두 프로세스 동시 state update fault test에서 JSON이 손상되지 않는다.

## 3. 표시 모드, 줌, 회전, 렌더링

### v0.10.0 계약

- 처음은 1페이지, vertical single-page continuous, Fit Width다.
- page break margin과 shadow가 있다.
- `w`: Fit Width, `F`: Fit Page, Actual Size는 menu/palette에 있지만 기본키는 없다.
- zoom 범위는 `0.1...8`, 한 단계 factor 기본값은 `1.10`이다.
- Fit Page에서 `j/k/d/u`는 페이지 단위로 이동한다.
- Fit Page에서 `=`/`+`는 anchor를 유지하며 continuous manual zoom으로, `-`는 Zoom Out, `w`는 continuous Fit Width로 바뀐다.
- `[`/`]` 회전은 90도 단위, pane-local, memory-only이며 file에 쓰지 않는다. 현재 fit mode를 다시 적용한다.

근거:

- [`ReaderPDFView.swift`](../../PDFReaderApp/Input/ReaderPDFView.swift), 46–64행
- [`PDFViewController.swift`](../../PDFReaderApp/Reader/PDFViewController.swift), 251–305행과 424–436행
- [`BuiltInDefaults.swift`](../../PDFReaderCore/Config/BuiltInDefaults.swift), 13–40행
- PR [#24](https://github.com/DS-argus/modeleaf/pull/24), [#41](https://github.com/DS-argus/modeleaf/pull/41)

### Windows 구현

1. `ViewMode = fitWidth | fitPage | actualSize | manual`을 tab state에 둔다.
2. rotation은 tab/PDF session render state에 둔다. PDF bytes나 annotation storage를 수정하지 않는다.
3. page placeholder의 CSS size와 canvas backing size를 분리한다.
4. backing size는 CSS viewport × `devicePixelRatio`로 계산하고 render transform을 적용한다.
5. visible pages ±2 overscan만 render한다.
6. resize/zoom/rotate 전 canonical page-space anchor를 캡처하고 layout 후 복원한다.
7. stale render task는 generation과 `RenderTask.cancel()`로 폐기한다.

### 실패 모드

- 125/150/200% scaling에서 canvas와 text/link layer가 어긋남
- 빠른 zoom/resize 중 오래된 render가 새 canvas를 덮음
- Fit Width 계산에 scrollbar width가 두 번 포함됨
- 회전 후 top-left 기반 anchor가 반대 위치로 이동함
- 4 panes가 동시에 전체 문서를 render해 메모리가 폭증함
- tab close 후 PDF.js worker/document가 살아남음

### Acceptance

- DPI 100/125/150/200에서 text selection와 link box 오차가 1 CSS px 이하이다.
- 300-page fixture에서 canvas는 visible + overscan 범위를 넘지 않는다.
- zoom/rotate/resize 후 캡처된 page-space anchor가 tolerance 0.5 이내로 복원된다.
- tab close 후 render tasks와 document handle ref-count가 0이 된다.
- 모든 view action 후 source hash가 동일하다.

## 4. Action registry, 키 문법, 입력 routing

### v0.10.0 계약

- action ID는 61개다. `prompt.commit`, `prompt.cancel`, `search.next`, `search.previous` 네 개는 fixed binding이다.
- context는 `navigation`, `pagePrompt`, `searchPrompt`, `searchResults` 네 개다.
- pane prefix는 `<C-b>`, timeout은 400ms다.
- bare Unicode literal, `gg` 같은 sequence, named key, explicit Shift normalization을 지원한다.
- prompt의 printable/dead-key/IME는 native text path에 남는다.
- palette/menu/help는 action registry와 validated keymap에서 파생된다.

근거:

- [`ActionID.swift`](../../PDFReaderCore/Actions/ActionID.swift)
- [`ActionRegistry.swift`](../../PDFReaderCore/Actions/ActionRegistry.swift)
- [`KeyToken.swift`](../../PDFReaderCore/Input/KeyToken.swift)
- [`KeySequenceEngine.swift`](../../PDFReaderCore/Input/KeySequenceEngine.swift)
- [`ReaderInputRouter.swift`](../../PDFReaderApp/Input/ReaderInputRouter.swift)
- PR [#10](https://github.com/DS-argus/modeleaf/pull/10)–[#17](https://github.com/DS-argus/modeleaf/pull/17), [#25](https://github.com/DS-argus/modeleaf/pull/25)–[#28](https://github.com/DS-argus/modeleaf/pull/28), [#41](https://github.com/DS-argus/modeleaf/pull/41)

### Windows 기본 키 결정

| 종류 | 기본값 |
|---|---|
| Open / Close / Print / New | `Ctrl+Shift+O` (Issue #53 owner amendment), `Ctrl+W`, `Ctrl+P`, `Ctrl+N` |
| 현재 창 닫기 (`app.quit`) | `Alt+F4` |
| Palette | `:`, `Ctrl+Shift+P` |
| Tab 1–9 | `Ctrl+1` … `Ctrl+9` |
| History | `Alt+Left`, `Alt+Right` |
| Vim reader keys | macOS와 동일 |
| Pane prefix/focus | `Ctrl+B`, `Ctrl+H/J/K/L` |
| TOC toggle / scroll | `t`, `J`, `K` |
| Zoom | `=`, `+`: Zoom In; `-`: Zoom Out |

Windows grammar는 `C=Ctrl`, `A=Alt`, `S=Shift`다. `D`는 macOS config migration error를 내고, Windows key는 OS가 소유하므로 `Win` modifier를 노출하지 않는다.
Windows delta에서 canonical `=`와 physical `+`는 같은 `view.zoomIn` action에 binding하며, `-`는 `view.zoomOut`이다.

`app.quit`라는 stable ID는 61개 action parity를 위해 유지하지만 Windows 표시명과 동작은 `Close Window`다. 호출한 top-level window만 닫고 마지막 창에서 process가 끝난다. 같은 Tauri process의 모든 창을 닫는 `Exit All`은 v1 범위에 추가하지 않는다.

### 구현 순서

1. Action ID/descriptor snapshot test를 먼저 포팅한다.
2. key token/parser/normalizer/trie를 DOM 독립 pure TS로 구현한다.
3. Windows reserved/default collision snapshot을 만든다.
4. `KeyboardEvent` adapter가 physical event를 canonical token으로 바꾼다.
5. composition/dead-key/AltGraph를 action routing보다 먼저 판정한다.
6. context state machine과 prefix timer를 연결한다.
7. 처리한 event만 `preventDefault()`한다.
8. menu/palette/help/status key labels를 validated registry에서 생성한다.

### 실패 모드

- Open과 History Back을 사용자 설정에서 같은 sequence에 동시에 배정
- `Ctrl+I`가 Tab으로 collapse
- `AltGraph` 입력을 `Ctrl+Alt` shortcut으로 잘못 실행
- IME composition 중 `j/k` navigation 실행
- prefix timer가 background tab/window에서도 남음
- WebView2/browser accelerator가 action보다 먼저 실행
- uppercase literal과 Shift chord를 같은 방식으로 잘못 normalize

### Acceptance

- 61개 action/4개 fixed binding snapshot이 고정된다.
- default keymap은 동일 context 안에서 충돌이 없다.
- 한글 IME, dead key, AltGraph 입력 동안 reader action이 실행되지 않는다.
- `Alt+Left/Right`는 WebView navigation이 아니라 app history만 실행한다.
- prefix는 400ms 후 정확히 취소되고 status pending 표시가 사라진다.

## 5. 페이지 이동과 내비게이션 히스토리

### v0.10.0 계약

- `h/j/k/l`과 arrows는 32pt small scroll, `d/u`는 viewport 0.8배 large scroll이다.
- `n/p`, `gg/G`, `g` page prompt를 지원한다.
- history는 tab/pane별 in-memory, 최대 위치 100개다.
- 기록 대상: page prompt, first/last, internal GoTo click/hint, verified TOC activation, 한 search epoch의 첫 distinct displayed landing.
- 제외: ordinary scroll, next/previous, zoom, fit, rotation, failed/same/unresolved/stale/cancelled landing, external URL.
- Back 후 새 meaningful jump는 Forward를 비운다.
- restore는 현재 zoom/fit/rotation/search presentation을 유지한다.
- 성공한 실제 landing을 검증한 뒤에만 stack을 commit한다.

근거:

- [`NavigationHistory.swift`](../../PDFReaderCore/Reader/NavigationHistory.swift), 3–187행
- [`NavigationHistoryTests.swift`](../../PDFReaderCoreTests/NavigationHistoryTests.swift)
- [`ReaderSession.swift`](../../PDFReaderApp/Reader/ReaderSession.swift)
- PR [#30](https://github.com/DS-argus/modeleaf/pull/30)–[#35](https://github.com/DS-argus/modeleaf/pull/35), [#41](https://github.com/DS-argus/modeleaf/pull/41)

### Transaction

```text
capture origin
  → resolve requested destination
  → perform scroll/render
  → await stable layout
  → capture actual landing
  → compare page-space location
  → commit history or report no-op/failure
```

Back/Forward도 destination을 peek하고 restore가 성공한 후에만 directional commit한다. restore 실패 시 stack을 바꾸지 않는다.

### Windows 차이와 주의사항

- default history key는 `Alt+Left/Right`다.
- DOM `scrollTop`은 zoom/rotation/layout에 종속적이므로 snapshot으로 저장하지 않는다.
- IntersectionObserver의 가장 큰 visible ratio만으로 current page를 확정하면 page 경계에서 흔들릴 수 있다. viewport anchor point를 page space로 변환한다.
- pending render와 scroll animation이 끝나기 전 commit하지 않는다.

### Acceptance

- current Swift history unit cases를 pure TS로 모두 이전한다.
- ordinary scroll/next/previous/zoom/fit/rotation 후 stack count가 변하지 않는다.
- `gg`를 이미 top에서 실행하면 no-op이고 origin을 push하지 않는다.
- failed restore 후 peek destination과 stack count가 그대로다.
- 한 search epoch에서 여러 next/previous는 origin 하나만 기록한다.

## 6. 검색

### v0.10.0 계약

- embedded PDF text만 검색한다. OCR, regex, fuzzy search, result list가 없다.
- case-insensitive literal search다.
- 비동기이며 query replacement는 이전 작업을 cancel하고 latest generation만 수용한다.
- 전체 match와 active match를 transient highlight로 표시한다.
- next/previous는 wrap한다.
- empty query, no match, no searchable text 상태를 구분한다.
- search cancel/clear는 PDF나 history를 변형하지 않는다.

근거:

- [`ReaderSearchCoordinator.swift`](../../PDFReaderApp/Reader/ReaderSearchCoordinator.swift), 146–225행과 330–418행
- [`ReaderSearchCoordinatorTests.swift`](../../PDFReaderAppTests/ReaderSearchCoordinatorTests.swift)
- [`ReaderSearchWorkflowTests.swift`](../../PDFReaderAppTests/ReaderSearchWorkflowTests.swift)
- PR [#25](https://github.com/DS-argus/modeleaf/pull/25), [#26](https://github.com/DS-argus/modeleaf/pull/26), [#32](https://github.com/DS-argus/modeleaf/pull/32), [#35](https://github.com/DS-argus/modeleaf/pull/35)

### Windows 구현

1. 검색 coordinator를 generation state machine으로 만든다.
2. PDF.js viewer search primitive 또는 `getTextContent()` adapter를 사용하되 semantics를 adapter test로 고정한다.
3. page 단위 extraction을 worker에서 진행하고 UI thread를 block하지 않는다.
4. query 교체 시 이전 결과 callback을 generation으로 폐기한다.
5. match geometry를 page-space로 보관하고 render 시 current viewport로 변환한다.
6. 첫 accepted distinct landing만 search epoch origin을 history에 commit한다.

### 실패 모드

- ligature, composed Unicode, RTL에서 text extraction 순서 차이
- 큰 문서에서 모든 page text를 main thread로 한 번에 가져옴
- zoom/rotation 후 stale highlight geometry
- cancelled generation의 late result가 match count를 덮음
- image-only PDF에 OCR처럼 보이는 거짓 결과

### Acceptance

- rapid query replacement에서 latest query 결과만 보인다.
- next/previous wrap과 active index가 deterministic하다.
- image-only fixture는 `no searchable text`, blank fixture는 no matches를 반환한다.
- zoom/rotation/DPI 변경 후 highlight 오차가 1 CSS px 이하이다.
- 300-page search 동안 key input과 scroll이 응답한다.

## 7. 링크 클릭, 링크 힌트, 목적지 표시기

### v0.10.0 계약

- PDF annotation link만 대상이다. 인쇄된 text URL은 자동 감지하지 않는다.
- URL은 OS browser로, internal GoTo는 같은 document 안에서 이동한다.
- unresolved/foreign GoTo는 실행하지 않는다.
- link hints는 현재 visible pages의 link만 대상으로 deterministic reading order를 사용한다.
- exact duplicate annotation만 dedupe한다. 같은 destination이거나 인접했다는 이유로 합치지 않는다.
- `f`가 hints, `F`가 Fit Page다.
- hint labels는 lowercase letter sequence이며 plain/Shift/Caps ASCII letters는 lowercase로 normalize하고 Ctrl/Alt/Meta/AltGraph, IME/composition, keyCode 229, dead/process/unidentified, non-letter input은 거부한다.
- 성공하고 point가 있는 internal destination에는 configurable indicator를 표시한다.

Indicator 계약:

- styles: `pulse-ring`, `target`, `beacon`, `static-ring`, `diamond-pulse`
- colors: `red`, `amber`, `cyan`, `green`, `purple`, `accent`, `auto-contrast`, `high-contrast`, custom `#RRGGBB`
- size `16...48`, duration `500...3000ms`
- default: red pulse ring, 28, 1500ms

근거:

- [`ReaderLink.swift`](../../PDFReaderCore/Reader/ReaderLink.swift)
- [`LinkHintMerge.swift`](../../PDFReaderCore/Reader/LinkHintMerge.swift), 3–25행
- [`LinkHintLabels.swift`](../../PDFReaderCore/Input/LinkHintLabels.swift)
- [`LinkDestinationIndicatorSettings.swift`](../../PDFReaderCore/Reader/LinkDestinationIndicatorSettings.swift)
- [`ReaderPDFView.swift`](../../PDFReaderApp/Input/ReaderPDFView.swift), 76–170행
- PR [#1](https://github.com/DS-argus/modeleaf/pull/1), [#2](https://github.com/DS-argus/modeleaf/pull/2), [#19](https://github.com/DS-argus/modeleaf/pull/19)–[#23](https://github.com/DS-argus/modeleaf/pull/23)

### Windows 구현

1. `getAnnotations({ intent: "display" })` 결과에서 Link action만 map한다.
2. rectangle과 target을 canonical DTO로 만든다.
3. exact structural equality로만 dedupe하고 reading order로 sort한다.
4. link overlay는 page layer와 같은 transform을 사용한다.
5. click와 hint activation이 같은 `activateLink()` transaction을 호출한다.
6. URL은 Rust allowlist command로 보낸다.
7. GoTo는 resolve → origin capture → move → landing capture → history commit → indicator 순서다.
8. scroll/zoom/rotate/resize/pane drag/document close 때 hint와 indicator를 dismiss한다.

### 실패 모드

- annotation 좌표의 y-axis를 뒤집지 않거나 두 번 뒤집음
- rotated page에서 hint가 다른 위치에 뜸
- wrapped link를 destination 기준으로 합쳐 클릭 target을 숨김
- stale visible page cache에서 hint 생성
- `javascript:`, `file:`, Launch action이 opener로 넘어감
- Caps Lock/Shift가 label 입력을 망침

### Acceptance

- duplicate/adjacent/wrapped fixture가 current merge tests와 같은 개수를 만든다.
- URL click와 hint는 browser open 한 번만 발생한다.
- internal GoTo click와 hint는 같은 landing/history 결과를 만든다.
- unsupported scheme과 unresolved destination은 no-op + non-blocking diagnostic이다.
- 4개 DPI와 4개 rotation에서 hint/indicator 오차가 1 CSS px 이하이다.

## 8. Embedded outline TOC

### v0.10.0 계약

- PDF에 이미 포함된 outline만 읽는다. outline이 없으면 `No table of contents` empty state를 표시할 수 있지만 thumbnail, bookmark, attachment, OCR, outline 생성·편집 surface는 추가하지 않는다.
- `toc.toggle`, `toc.scrollDown`, `toc.scrollUp` 세 action을 포함해 공개 action은 61개다. 기본키는 `t`, `J`, `K`이며 `navigation`과 `searchResults`에서만 활성화된다.
- outline은 document open 시 immutable snapshot으로 정규화한다. 구조 경로가 stable row ID이며 preorder를 유지한다.
- 단일 title wrapper 아래에 children이 있으면 wrapper를 숨긴다. 화면에는 승격된 top level과 그 direct children, 최대 두 depth만 표시하고 더 깊은 descendants는 표시하지 않는다.
- title은 trim하고 비어 있으면 `Untitled section`을 쓴다. 같은 destination의 서로 다른 outline row는 합치지 않는다.
- 현재 document의 유효 page destination만 활성화한다. finite media box를 기준으로 지정되지 않은 sentinel coordinate는 중앙으로, 경계 밖 8pt 이내 값은 clamp하고, NaN/Infinity/foreign page/8pt 초과 이탈은 invalid로 둔다.
- invalid destination row는 hierarchy 안에 그대로 보이되 disabled이고 selector가 없다. valid row만 preorder 순서의 연속 숫자 selector `1...N`을 받는다.
- current row는 viewport anchor보다 앞선 가장 가까운 visible destination을 page index, PDF y-descending, x-ascending 순서로 추적한다. 같은 위치 duplicate는 첫 row를 유지한다.
- TOC activation은 app-owned meaningful navigation producer `.toc`이며 실제 landing을 검증한 경우에만 history에 기록한다. failed activation은 selection/history를 rollback하고 same-location no-op은 새 history를 만들지 않는다.

### Windows 구현

1. PDF.js adapter가 `getOutline()`과 destination resolution을 제공하되 generic viewer sidebar를 mount하지 않는다.
2. pure TS `ReaderOutline`이 raw outline tree를 stable structural IDs, 최대 두 display depths, valid-only selectors가 있는 immutable rows로 변환한다.
3. destination은 `pageIndex + unscaled page-space point`로 정규화하고 macOS의 finite/sentinel/8pt 정책을 adapter contract test로 고정한다.
4. 각 pane은 자신의 TOC state와 widget identity를 소유한다. floating overlay는 PDF canvas를 resize하지 않고 owning pane content의 top-right `12px`에 놓는다.
5. 기준 geometry는 maximum width `300px`, actual width `min(300px, owning pane width - 24px)`, row `20px`, footer `24px`; content height 또는 pane 높이의 절반 중 작은 값에서 whole rows로 맞춘다.
6. headerless flat list에서 selector는 right-aligned, 1px divider 뒤 title은 left-aligned하며 child depth는 6px만 indent한다.
7. `J/K`는 정확히 한 row씩 scroll하고, unmodified decimal digits는 silent 400ms buffer로 한 selector를 atomic commit한다. Backspace는 마지막 digit을 지우고 400ms deadline을 다시 시작하며, `Esc` 또는 toggle은 닫고 pending buffer를 취소한다.
8. active pane의 열린 TOC만 숫자, `J/K`, `Esc`를 먼저 받는다. 다른 pane TOC fallback은 금지하며 widget 자체는 PDF focus를 빼앗지 않는다.
9. opening은 current row를 center하고, user가 TOC를 직접 scroll한 동안 ordinary rerender가 위치를 되감지 않는다. verified user viewport movement revision이 바뀌면 current row를 minimally reveal한다.
10. tab replacement, pane topology growth, rerender에서는 widget을 재생성하지 말고 같은 owner 위로 re-raise한다. tab/pane close, deactivation, prompt/help/config reload, window focus loss는 pending numeric input을 취소한다.
11. enabled row는 click, first mouse, accessible button press를 지원하고 disabled row는 모두 거부한다.

### 의도적 비범위와 실패 모드

- PDF.js generic sidebar, thumbnail view, bookmark 작성, attachment browser, outline generation/editing은 명시적 비범위다.
- outline이 없는 PDF를 분석해 목차를 추론하지 않는다.
- raw destination를 DOM scroll offset으로 저장하거나 PDF.js internal history에 위임하지 않는다.
- inactive pane 입력을 다른 visible TOC로 보내거나 tab replacement 뒤 PDF canvas 아래로 overlay가 내려가면 blocker다.
- timer test에서 real sleep을 사용하지 않는다. fake clock으로 399ms 무동작, 400ms commit, 두 번째 digit과 Backspace의 deadline renewal을 검증한다.

### Acceptance

- nested, single-wrapper, duplicate-destination, invalid, edge-destination fixture가 v0.10.0 row/selector 결과와 일치한다.
- 2/3/4 panes에서 TOC identity, visibility, numeric buffer, scroll, selection이 pane별로 독립적이다.
- active pane `Esc`만 해당 TOC를 닫고 active pane에 TOC가 없을 때 다른 pane으로 fallback하지 않는다.
- TOC jump의 verified/no-op/failure가 history와 selection을 정확히 commit/유지/rollback한다.
- config reload와 모든 modal/focus/tab/pane lifecycle이 pending numeric input을 취소한다.
- Narrator가 enabled row를 button으로 읽고 press할 수 있으며 disabled row를 비활성으로 읽는다.
- Dracula와 Solarized Dark의 selector와 depth-2 title contrast ratio가 최소 4.0이다.
- generated outline fixture와 실제 embedded-outline PDF의 source SHA-256이 전후 동일하다.

근거: [`ReaderOutline.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Reader/ReaderOutline.swift), [`TOCWidgetView.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Window/TOCWidgetView.swift), [`MainWindowController.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Window/MainWindowController.swift), [`ReaderOutlineTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/ReaderOutlineTests.swift), [`TOCWidgetTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/TOCWidgetTests.swift), [`TOCNumericRoutingTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/TOCNumericRoutingTests.swift), PR [#45](https://github.com/DS-argus/modeleaf/pull/45).

## 9. Tabs, panes, split duplicate

### v0.10.0 계약

- 한 tab은 한 PDF session이다.
- single pane에서는 root tab bar, multi-pane에서는 pane마다 독립 tab bar가 있다.
- 최대 4 panes, split right/down, directional focus, unsplit을 지원한다.
- split은 active PDF를 다시 열고 **검증된 page-space position만** 복제한다.
- destination duplicate는 Fit Page로 시작한다. source zoom/view mode/search/history/rotation을 복제하지 않는다.
- duplicate landing 검증이 실패하면 split 전체를 rollback한다.
- closing session은 callbacks, search, render/document를 정리한다.

근거:

- [`TabStore.swift`](../../PDFReaderCore/Tabs/TabStore.swift)
- [`PaneCoordinator.swift`](../../PDFReaderApp/Reader/PaneCoordinator.swift), 126–173행
- [`ReaderDuplicationSnapshot.swift`](../../PDFReaderApp/Reader/ReaderDuplicationSnapshot.swift)
- [`ReaderSessionStore.swift`](../../PDFReaderApp/Reader/ReaderSessionStore.swift)
- [`PaneRedTeamTests.swift`](../../PDFReaderAppTests/PaneRedTeamTests.swift)
- PR [#31](https://github.com/DS-argus/modeleaf/pull/31), [#35](https://github.com/DS-argus/modeleaf/pull/35)

### Windows 구현

- pane topology를 binary split tree로 둔다.
- pane마다 tab store와 active tab ID를 가진다.
- window마다 active pane, overlay owner, status projection을 가진다.
- split transaction은 source snapshot과 new PDF session을 준비하고 landing 확인 뒤 layout을 commit한다.
- document registry는 같은 path여도 session별 PDF.js document를 독립 생성하되 Rust file handle을 ref-count로 공유할 수 있다.
- divider minimum thickness는 160px다.

### 실패 모드

- layout을 먼저 commit해 failed duplicate에서 빈 pane이 남음
- source session 객체를 공유해 rotation/search가 두 pane에 번짐
- inactive pane action이 active pane status를 갱신
- nested topology에서 directional focus가 잘못된 leaf를 선택
- unsplit 도중 close callback reentrancy로 store/layout 불일치

### Acceptance

- 1/2/3/4-pane topology pure tests와 red-team rollback tests가 통과한다.
- 다섯 번째 split은 disabled reason `Maximum panes open`을 제공한다.
- duplicate는 page position만 같고 Fit Page/new history/empty search/default rotation이다.
- pane focus 즉시 tab bar, status, title, focus ring이 일치한다.
- unsplit 후 제거된 sessions의 document handles와 workers가 해제된다.

## 10. Command palette, help, prompts, overlay focus

### v0.10.0 계약

- palette는 fuzzy filter, 최대 12 rows, enabled-first ordering을 사용한다.
- disabled action도 이유와 함께 보이지만 실행되지 않는다.
- `Ctrl+j/k`, arrows, Enter, Esc로 조작한다.
- `?` help는 navigation context 전용이지만 palette의 help action은 empty window에서도 찾을 수 있다.
- page/search prompt는 native text/IME를 소유하고 Enter/Esc를 fixed lifecycle key로 사용한다.
- recent, palette, help, theme picker, indicator picker, update instructions는 keyboard routing과 focus restore 계약을 가진다.
- theme/indicator picker는 preview, commit, cancel rollback을 구분한다.

근거:

- [`CommandPalette.swift`](../../PDFReaderCore/Palette/CommandPalette.swift)
- [`ReaderInputRouter.swift`](../../PDFReaderApp/Input/ReaderInputRouter.swift)
- [`MainWindowController.swift`](../../PDFReaderApp/Window/MainWindowController.swift)
- [`CommandPaletteIntegrationTests.swift`](../../PDFReaderAppTests/CommandPaletteIntegrationTests.swift)
- [`HelpOverlayIntegrationTests.swift`](../../PDFReaderAppTests/HelpOverlayIntegrationTests.swift)
- PR [#10](https://github.com/DS-argus/modeleaf/pull/10), [#11](https://github.com/DS-argus/modeleaf/pull/11), [#25](https://github.com/DS-argus/modeleaf/pull/25), [#26](https://github.com/DS-argus/modeleaf/pull/26)

### Windows 구현

- `OverlayOwner` state machine에 current modal, suspended prompt, return focus target을 저장한다.
- overlay open 시 active PDF/hint를 정리하고, close 시 이전 valid owner로만 focus를 돌린다.
- overlay row는 native `<button>`/listbox semantics와 accessible name/state를 사용한다.
- recent filename query는 Unicode를 허용한다. command title filter는 registry title을 대상으로 한다.
- browser focus trap library에만 의존하지 말고 action/input state와 함께 test한다.

### Acceptance

- 모든 overlay가 Esc로 닫히고 정확한 previous focus를 복원한다.
- prompt가 열린 상태에서 help/update를 열었다 닫으면 prompt text와 selection이 유지된다.
- history/default viewer key는 modal 동안 consume되지만 dispatch되지 않는다.
- disabled palette row는 이유가 읽히고 Enter로 실행되지 않는다.
- Narrator가 overlay title, selected row, disabled reason을 읽는다.

## 11. Config load, reload, write, reset

### v0.10.0 계약

- optional TOML 한 개, 최대 256 KiB, UTF-8다.
- schema는 `[keymap]`, `[navigation]`, `[input]`이며 각 field는 optional sparse overlay다.
- unknown section/key/nested leaf/array node는 error다.
- launch에 error가 하나라도 있으면 사용자 값을 전부 버리고 typed built-ins 전체를 활성화한다.
- runtime reload error는 last good generation을 유지하고 pinned diagnostic을 표시한다.
- missing file은 정상 built-ins 사용이다.
- `Write Default Config`는 absent일 때만 생성한다.
- `Reset Config`는 기존 내용과 default가 다를 때 `.bak`을 만들고 교체한다.
- declarative data만 허용하고 action/macro/script/plugin을 정의할 수 없다.

근거:

- [`CONFIG.md`](../../CONFIG.md), 1–140행
- [`ConfigFileSource.swift`](../../PDFReaderApp/Config/ConfigFileSource.swift)
- [`ConfigService.swift`](../../PDFReaderApp/Config/ConfigService.swift), 39–113행
- [`ConfigFileStore.swift`](../../PDFReaderApp/Config/ConfigFileStore.swift)
- [`ConfigValidator.swift`](../../PDFReaderCore/Config/ConfigValidator.swift)
- PR [#13](https://github.com/DS-argus/modeleaf/pull/13)–[#17](https://github.com/DS-argus/modeleaf/pull/17), [#27](https://github.com/DS-argus/modeleaf/pull/27), [#28](https://github.com/DS-argus/modeleaf/pull/28)

### Windows 구현

1. strict TOML parser를 exact version으로 pin한다.
2. parsed tree 전체를 walk해 unknown node를 검출한다.
3. source location과 semantic path를 diagnostic에 보존한다.
4. Windows built-ins를 유일 runtime default source로 둔다.
5. bundled example와 `CONFIG.md`는 registry/default에서 생성하거나 snapshot test로 동기화한다.
6. load/reload state machine을 별도로 구현한다.
7. Rust transaction command로 Write/Reset을 수행한다.
8. reload 성공 시 key engine/menu/palette/help를 한 generation으로 동시에 교체한다.

### Windows 차이와 주의사항

- config path는 `appConfigDir()/config.toml`, state는 `appLocalDataDir()/state.json`으로 분리한다. 두 API가 이미 bundle identifier를 포함하므로 `Modeleaf` 하위 디렉터리를 중복 생성하지 않는다.
- `D` modifier를 발견하면 단순히 `C`로 자동 치환하지 않는다. Open/History 충돌 때문에 actionable migration error를 표시한다.
- Windows default key table을 별도로 생성한다.
- antivirus/file indexer가 temp/replace를 잠글 수 있으므로 bounded retry 후 실패를 surface한다.

### Acceptance

- current config parser/validator/reload/write/reset tests를 동등한 TS/Rust tests로 포팅한다.
- oversize/invalid UTF-8/unknown leaf는 launch 전체 fallback이다.
- 같은 오류를 reload하면 current generation object identity와 bindings가 유지된다.
- Write Default가 기존 파일을 절대 덮어쓰지 않는다.
- Reset failure 어느 지점에서도 원본 또는 backup 중 최소 하나가 복구 가능하다.

## 12. State, themes, link indicator persistence

### v0.10.0 계약

`state.json`의 owned fields는 다음뿐이다.

```json
{
  "selected_theme": "tokyo-night",
  "recent_files": [
    { "absolute_path": "...", "last_opened_at": "..." }
  ],
  "link_destination_indicator": {
    "style": "pulse-ring",
    "color": "red",
    "size": 28,
    "duration_ms": 1500
  }
}
```

- unknown top-level fields를 유지한다.
- malformed known sibling은 다른 field decode를 망치지 않는다.
- theme는 7종: Tokyo Night, Gruvbox Dark, Solarized Dark, Dracula, Everforest, Nord, Catppuccin Latte.
- theme는 app chrome만 바꾸고 PDF pixels를 바꾸지 않는다.
- preview cancel은 이전 theme/settings로 rollback한다.
- persistence 실패 시 현재 session 적용은 유지하되 저장 실패를 알린다.

근거:

- [`StateFileStore.swift`](../../PDFReaderCore/Recent/StateFileStore.swift), 16–114행
- [`Theme.swift`](../../PDFReaderCore/Theme/Theme.swift)
- [`BuiltInThemes.swift`](../../PDFReaderCore/Theme/BuiltInThemes.swift)
- [`ThemeSelectionStore.swift`](../../PDFReaderCore/Theme/ThemeSelectionStore.swift)
- PR [#4](https://github.com/DS-argus/modeleaf/pull/4), [#7](https://github.com/DS-argus/modeleaf/pull/7), [#18](https://github.com/DS-argus/modeleaf/pull/18)

### Windows 구현과 Acceptance

- JSON shape와 theme IDs/colors를 그대로 복제한다.
- `appLocalDataDir()/state.json`을 사용한다.
- field별 mutation command가 read/merge/write transaction을 수행한다.
- 두 window의 동시 theme/recent update에서 한쪽 field가 사라지지 않는다.
- unknown sentinel field가 모든 update 뒤 그대로 남는다.
- PDF screenshot pixels는 theme 전후 동일하고 chrome만 달라진다.

## 13. 인쇄

### v0.10.0 계약

- active PDF의 explicit `Print…` action이 system print panel과 progress를 연다.
- print는 reader registry를 거치며 PDF view의 임의 native print action은 막는다.
- source file을 변경하지 않는다.

현재 [`PDFViewController.swift`](../../PDFReaderApp/Reader/PDFViewController.swift) 307–319행은 같은 in-memory `PDFDocument`로 `pageScaleToFit`, `autoRotate` print operation을 만든다. 회전된 page object가 출력에 반영되는지는 코드상 가능성이 높지만 문서화된 명시 계약은 아니므로, Windows 구현 전에 macOS reference 출력으로 확정한다. 인쇄는 PR이 아니라 commit [`425e4c4`](https://github.com/DS-argus/modeleaf/commit/425e4c4ecf2a7834cfa3ab44f1bead0bae3317e3)에서 도입됐다.

### Windows 구현

1. W02에서 PDF.js print feasibility를 먼저 검증한다.
2. visible virtualized DOM을 그대로 `window.print()`하지 않는다. 그러면 보이는 페이지만 출력될 수 있다.
3. adapter 뒤의 hidden print container/iframe에 전체 page를 순차 준비한다.
4. overlays, search highlights, hints, theme chrome은 print surface에 넣지 않는다.
5. system dialog가 닫히면 print canvases와 iframe을 전부 해제하고 reader focus/state를 복원한다.
6. cancel과 error를 normal outcome으로 처리한다.

### 실패 모드

- 300페이지를 동시에 고해상도 canvas로 만들어 OOM
- print preview가 닫힌 뒤 keyboard focus 유실
- source page 순서/크기/rotation 차이
- blank/raster page 누락
- WebView2 버전에 따른 print dialog 차이

### Acceptance

- Microsoft Print to PDF로 1/12/300-page fixtures의 page count와 순서를 확인한다.
- print 전후 active tab/pane/page/zoom/search/history가 같다.
- cancel 후 print artifact와 worker task가 남지 않는다.
- source hash가 같다.
- spike가 안정적이지 않으면 OS default viewer로 조용히 위임하지 말고 release blocker로 남긴다.

## 14. Windows, single instance, file association

### v0.10.0 계약과 의도적 차이

macOS `app.new`는 [`ApplicationController.swift`](../../PDFReaderApp/App/ApplicationController.swift) 296–299행처럼 새 application process를 시작한다. Windows에서는 같은 UX 결과인 “독립 창”을 같은 Tauri process 안에서 만든다.

### Windows 구현

- single-instance callback을 plugin 등록 순서상 가장 먼저 둔다.
- callback의 argv/cwd를 canonical `OpenRequest`로 변환한다.
- 최근 active window routing을 명시한다.
- window별 root store와 event channel을 둔다.
- `app.quit`와 native `Alt+F4`는 invoking window만 닫고, 해당 window의 sessions/handles를 정리한다.
- Tauri `bundle.fileAssociations`로 `.pdf`를 등록하고 NSIS 결과 registry를 검증한다. 기본 bundler output이 계약을 못 맞출 때만 installer hook/template을 추가한다.
- 앱을 PDF 기본 프로그램으로 강제 지정하지 않는다.
- uninstall에서 자신의 association registration만 제거한다.

### Acceptance

- app 미실행/실행 중 각각 Explorer double-click과 Open With가 올바른 window/tab을 연다.
- 두 번째 OS process가 장기 실행 상태로 남지 않는다.
- `Ctrl+N` 창의 tabs/history/overlay는 원래 창과 독립적이다.
- 두 창 중 하나에서 `Alt+F4`를 실행해도 다른 창과 그 문서는 계속 살아 있다.
- uninstall 후 PDF 파일과 사용자 config/state는 삭제하지 않는다. installer-owned association만 정리한다.

## 15. 업데이트, installer, release

### v0.10.0 계약

- 시작 후 GitHub latest release tag를 비교한다.
- network/parse 실패는 silent다.
- 새 버전이면 status banner, `U`, palette action으로 안내한다.
- macOS 현재 경로는 Homebrew 전용이고 앱이 스스로 install하지 않는다.

근거:

- [`UpdateCheck.swift`](../../PDFReaderCore/Update/UpdateCheck.swift), 51–67행
- [`UpdateChecker.swift`](../../PDFReaderApp/App/UpdateChecker.swift)
- [`UpdateBannerTests.swift`](../../PDFReaderAppTests/UpdateBannerTests.swift)
- PR [#3](https://github.com/DS-argus/modeleaf/pull/3), [#38](https://github.com/DS-argus/modeleaf/pull/38), [#39](https://github.com/DS-argus/modeleaf/pull/39), [#43](https://github.com/DS-argus/modeleaf/pull/43)

### Windows 결정

- 첫 공개 채널은 signed NSIS x64 installer다.
- install mode는 관리자 권한이 필요 없는 `currentUser`로 고정한다.
- WebView2 runtime mode는 `downloadBootstrapper`를 기본으로 한다.
- update는 notify-only다. banner/overlay가 Windows release page 또는 signed installer download를 연다.
- background/silent install, 강제 restart, 자동 update는 하지 않는다.
- MSI, Store, self-updater는 별도 ADR과 사용자 승인 전 비범위다.

### 실패 모드

- app/installer/update metadata 버전 불일치
- unsigned installer 또는 잘못된 certificate timestamp
- x64/arm64 asset 혼동
- GitHub latest에 macOS asset만 있는데 Windows update로 잘못 표시
- offline을 error banner로 노출해 독서를 방해
- SmartScreen reputation을 “서명만 하면 즉시 해결”한다고 가정

### Acceptance

- Windows 전용 release metadata만 비교한다.
- same/older/prerelease/malformed/offline cases의 pure tests가 있다.
- clean Windows 10/11 VM에서 install, launch, Open With, upgrade install, uninstall이 된다.
- installer와 executable의 Authenticode 서명을 검증한다.
- Homebrew/macOS 문구가 Windows binary/docs/test snapshot에 없다.
