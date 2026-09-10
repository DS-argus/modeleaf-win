# 대상 아키텍처

> Issue #53 owner delta: ordinary internal/external PDF link clicks, native authorization, canonical destination/history와 text/search ownership은 유지한다. Embedded TOC, `f` keyboard hints와 destination indicator/settings/runtime/API는 제거하며 현재 Windows registry는 **49 actions(45 configurable + 4 fixed)**다. finite `XYZ` point는 document edge가 허용하는 범위에서 viewport 중앙을 목표로 하고, destination transaction은 결과 viewport와 교차하는 page들을 bounded materialization한 뒤에만 canonical actual landing을 성공/history로 commit한다. `Fit`/`FitB` page-fit과 `FitR` rectangle-fit은 유지한다. 아래 retired architecture는 [deferred reference](./deferred-toc-link-hints.md)의 immutable source/tests(TOC/hints `7e00424d30c5ffeab5a846d087236371644af53a`, indicator `dedcff8513e034efb904ef7d50fd59cc11444798`)로만 읽는다.

## 1. 결론

Windows 포트는 다음 세 경계로 나눈다.

```text
Windows OS
  └─ Rust / Tauri trusted boundary
       ├─ file handles + custom PDF protocol
       ├─ dialog / shell / window / installer / update check
       └─ config and state transactions
            ⇅ narrow commands and events
       TypeScript product core
       ├─ action registry / input state machine
       ├─ tabs / panes / history / config validation
       └─ UI shell / overlays / accessibility
            ⇅ adapter interfaces
       PDF.js viewer adapter + worker
       ├─ parsing / Range loading / rendering
       ├─ text and annotation layers
       └─ destination and page geometry
```

Rust는 신뢰 경계를, TypeScript는 제품 동작을, PDF.js는 PDF 해석과 렌더링을 소유한다. PDF 페이지 좌표나 스크롤 상태를 매 프레임 Rust IPC로 왕복시키지 않는다.

## 2. 설계 불변식

1. 프론트엔드는 임의 filesystem 권한을 가지지 않는다.
2. PDF는 Rust가 연 read-only handle을 통해서만 읽는다.
3. 프론트엔드가 받는 문서 식별자는 실제 경로가 아니라 opaque `DocumentId`다.
4. PDF.js worker와 frontend package는 정확히 같은 lockfile 버전을 사용한다.
5. 모든 page location은 0-based page index와 회전 전 PDF page-space point로 정규화한다.
6. canvas, text layer, annotation layer와 search highlight는 같은 viewport transform을 사용한다. 퇴역 hint/indicator layer는 active transform consumer가 아니다.
7. 각 window의 tabs/panes/overlays/history는 독립적이다. Rust의 파일·config·state 서비스만 프로세스 전체에서 공유한다.
8. 앱이 actively 저장하는 상태는 `selected_theme`, `recent_files`뿐이다. 기존 `link_destination_indicator`는 unknown sibling으로 보존하고 session, tabs, page, zoom, rotation, history는 저장하지 않는다.
9. 파일 열기, drag/drop, Explorer Open With, recent open, duplicate pane는 모두 같은 Rust preflight와 같은 TS insertion transaction을 거친다.
10. source PDF에 write handle을 열지 않는다.
11. Embedded TOC, keyboard link hints와 destination indicator를 active runtime/UI/state에 다시 연결하지 않는다.

## 3. 권장 저장소 구조

UI 프레임워크는 Windows 저장소에 이미 선택된 것이 있으면 유지한다. 아래 도메인 경계는 React/Svelte/Vue와 무관하게 지킨다.

```text
modeleaf-windows/
  AGENTS.md
  README.md
  CONFIG.md
  package.json
  pnpm-lock.yaml
  src/
    main.ts
    domain/
      actions/
      config/
      input/
      navigation/
      recent/
      tabs/
      panes/
      theme/
      links/
      update/
      outlines/
    application/
      commands/
      open-document/
      windows/
      persistence/
    pdf/
      pdfjs-adapter.ts
      document-session.ts
      page-viewport.ts
      virtualizer.ts
      render-scheduler.ts
      text-layer.ts
      annotation-layer.ts
      search-coordinator.ts
      link-provider.ts
      print-service.ts
    ui/
      shell/
      reader/
      tabs/
      panes/
      overlays/
      status/
      theme/
      toc/
    platform/
      tauri-commands.ts
      tauri-events.ts
    styles/
  src-tauri/
    Cargo.toml
    tauri.conf.json
    capabilities/
      main.json
    src/
      main.rs
      app_state.rs
      commands/
        config.rs
        document.rs
        state.rs
        update.rs
        window.rs
      document/
        handle.rs
        protocol.rs
        range.rs
        registry.rs
      persistence/
        atomic_write.rs
        lock.rs
      shell/
        file_association.rs
        single_instance.rs
        urls.rs
  fixtures/
    pdf/
    manifest.json
  tests/
    e2e/
    visual/
  docs/
    adr/
    parity-matrix.md
```

새 추상 계층을 무조건 만들라는 뜻은 아니다. 각 디렉터리는 명확한 테스트 경계가 실제로 필요할 때만 만든다.

## 4. Rust / Tauri 책임

### 4.1 앱 수명주기와 창

- single-instance plugin을 가장 먼저 등록한다.
- 첫 실행 argv, 두 번째 실행 argv, Explorer Open With, drag/drop을 `OpenRequest`로 정규화한다.
- `app.new`는 같은 프로세스에서 새 Tauri window를 만든다.
- stable ID `app.quit`는 Windows projection에서 현재 top-level window를 닫는다. 마지막 창이 닫히면 프로세스가 종료된다. `Alt+F4` 때문에 다른 Modeleaf 창까지 함께 종료하지 않는다.
- window label은 충돌하지 않는 opaque ID를 사용한다.
- 새 window의 기본 content size는 `1040 × 760`, minimum은 `480 × 360`이다.
- window/session persistence는 추가하지 않는다. OS가 전달한 위치 또는 기본 위치만 사용한다.

두 번째 실행에서 PDF 경로가 있으면 가장 최근에 활성화된 window로 보낸다. 활성 window가 없으면 새 window를 만든다. 경로가 여러 개면 입력 순서대로 같은 active pane의 새 tabs로 연다. 일부가 실패해도 나머지는 계속 처리하고 실패 목록을 inline diagnostic으로 합친다.

### 4.2 문서 registry와 transport

프로덕션 기준 transport는 **opaque document handle + Range 가능한 custom URI protocol**이다.

열기 흐름:

1. Rust가 canonical absolute path인지, regular file인지 확인한다. 확장자는 dialog/association/recent 정책에 사용하되 open service의 유효성 판정으로 사용하지 않는다.
2. read-only `File` handle을 연다. write 권한은 요청하지 않는다.
3. 파일 크기와 수정 시각을 기록하고 `DocumentId`를 발급한다.
4. registry에 `{DocumentId, File, size, displayName, canonicalPath}`를 보관한다.
5. TS에는 `{id, displayName, byteLength, sourceUrl}`만 반환한다.
6. `sourceUrl`은 `modeleaf-pdf://localhost/document/<id>`와 같은 opaque URL이다.
7. protocol handler는 `GET`, `HEAD`, single byte range만 허용하고 `200`, `206`, `416`을 정확히 반환한다.
8. `Content-Type: application/pdf`, `Accept-Ranges: bytes`, `Content-Length`, `Content-Range`를 정확히 설정한다.
9. 마지막 tab/session이 닫히면 ref-count를 내리고 handle을 닫는다.

Windows에서 Tauri custom scheme이 WebView2 내부 `http(s)://<scheme>.localhost` 형태로 변환될 수 있으므로 origin, CSP, CORS를 패키지 빌드에서 검증한다.

왜 전체 `Uint8Array` IPC를 기본으로 쓰지 않는가:

- 큰 PDF를 Rust, IPC buffer, WebView, PDF.js worker에 중복 보관할 수 있다.
- 매번 전체 파일을 읽으면 Range loading과 빠른 first-page render 이점을 잃는다.
- 다중 tab/pane에서 같은 파일을 다시 열 때 메모리 비용이 커진다.

단, custom protocol이 packaged WebView2에서 Range 또는 PDF.js worker와 안정적으로 동작하지 않으면 Tauri의 optimized binary response로 한 번만 `ArrayBuffer`를 전달하는 fallback을 사용할 수 있다. JSON/base64 전달은 금지한다. 이 선택은 W02 spike 결과와 측정값을 ADR로 남겨야 한다.

### 4.3 config/state transaction

Rust가 파일 I/O와 transaction을 맡고, TS가 TOML schema와 제품 검증을 맡는다.

- config: `appConfigDir()/config.toml`
- state: `appLocalDataDir()/state.json`
- active state ownership은 `selected_theme`, `recent_files`로 한정; 기존 `link_destination_indicator`는 unknown sibling으로 보존하되 actively decode/apply/mutate하지 않음
- indicator retirement를 위한 state migration, deletion 또는 user config/state 자동 rewrite 금지
- 두 app directory API는 이미 Tauri bundle identifier를 포함한다. product name directory를 중복으로 덧붙이지 않는다.
- config read limit: 256 KiB, UTF-8만 허용
- write: 같은 디렉터리의 새 temp file → flush → atomic replace
- lock: process 간 exclusive lock, 2초 이내 실패를 명시적 diagnostic으로 반환
- `Write Default Config`: destination이 없을 때만 생성; 기존 파일 덮어쓰기 금지
- `Reset Config`: 기존 내용이 default와 다를 때 `config.toml.bak`을 먼저 교체하고 default로 교체
- state update: read/merge/write 한 transaction 안에서 수행; unknown top-level JSON fields 유지
- malformed known sibling은 다른 정상 필드의 load/update를 막지 않음

POSIX `flock`, mode `0600`, `renameatx_np`, directory `fsync`를 문자 그대로 옮기지 않는다. Windows file locking, ACL inheritance, `ReplaceFileW`/동등한 안전한 replace 의미를 Rust wrapper 뒤에 감추고 fault-injection test로 검증한다.

### 4.4 외부 URL과 update

- TS는 raw shell command를 호출하지 않는다.
- Rust command는 URL을 parse하고 첫 릴리스에서 `http`/`https` scheme만 허용한다.
- update check는 앱 시작 후 비동기로 수행한다.
- network/parse 실패는 조용히 무시한다.
- 새 버전이면 상태 표시줄 banner와 `update.show` action만 활성화한다.
- 첫 릴리스는 installer/release page를 명시적으로 여는 notify-only 흐름이다. updater install API를 호출하지 않는다.

## 5. TypeScript 책임

### 5.1 Pure domain

다음은 DOM/Tauri/PDF.js import가 없는 pure modules로 만든다.

- Windows 49개 action registry와 availability (macOS baseline 61개에서 pane 7개, TOC 3개, keyboard hint 1개, indicator picker 1개 제외)
- 네 입력 context: `navigation`, `pagePrompt`, `searchPrompt`, `searchResults`
- key token/parser/sequence trie/prefix timer
- prompt lifecycle 및 IME/dead-key bypass 판단
- command palette filter와 enabled-first ordering
- recent filename fuzzy filter
- strict sparse config overlay와 diagnostics
- navigation history와 search epoch
- tab store
- annotation-link DTO normalization과 exact-dedup
- theme settings와 semantic version update comparison
- retired TOC/hint/indicator domains는 active registry/application/UI에서 제외하고 immutable Git reference로만 보존

이 계층은 먼저 macOS pure tests를 포팅해 계약을 잠근다.

### 5.2 Application layer

- 모든 action dispatch를 한 곳에서 실행한다.
- 명령 실행 전에 context와 availability를 확인한다.
- open insertion, meaningful navigation, split duplicate는 prepare → perform → verify → commit/rollback transaction으로 구현한다.
- window별 root store를 생성하고 app-wide service handle만 공유한다.
- overlay focus ownership과 복원을 state machine으로 관리한다.
- application overlay visibility/focus는 window별 `overlayOwner` reducer가 단독 소유하며 동시에 하나만 활성화한다.
- Windows file picker는 app overlay가 아니라 별도 native open epoch다. Browse는 chooser를 release한 뒤 HWND-owned picker를 시작하고, epoch는 terminal ack/reject/cancel에서 정확히 한 번 해제한다.
- recents는 startup에 Rust에서 revisioned snapshot으로 preload한다. Issue #53 owner amendment에 따라 opaque `recentId`와 filename, bounded display-only `displayPath`를 전달한다. 표시 경로는 filesystem/shell/open 권한이 아니며 renderer가 경로를 되돌려 열기를 승인할 수 없다. Rust가 revision, health, record/prune commit과 filesystem authority를 소유하고 renderer는 monotonic full snapshot만 채택한다.
- unreadable/invalid state는 writable empty로 복구하지 않는다. record/prune은 fail closed이며 기존 bytes와 sibling fields를 보존한다.

### 5.3 UI layer

- semantic HTML을 우선한다.
- menu, palette, help, empty-state shortcut, status hints는 action registry와 active keymap에서 생성한다.
- PDF canvas focus와 active pane 표시는 1px 수준으로 조용하게 유지한다.
- pane-local TOC, keyboard link hint와 destination indicator surface는 current UI layer에 mount하지 않는다.
- PDF pixels에는 theme filter를 적용하지 않는다.

## 6. PDF.js adapter 책임

`pdfjs-dist`를 exact version으로 pin하고 lockfile을 커밋한다. worker, CMaps, standard fonts, wasm assets를 앱에 local bundle하며 CDN을 사용하지 않는다.

공개 adapter 인터페이스 예시:

```ts
interface PdfDocumentAdapter {
  open(source: DocumentDescriptor): Promise<PdfSession>;
  destroy(sessionId: string): Promise<void>;
  captureLanding(sessionId: string): NavigationSnapshot | null;
  restoreLanding(sessionId: string, target: NavigationSnapshot): Promise<LandingResult>;
  search(sessionId: string, query: string, generation: number): AsyncIterable<SearchMatch>;
  visibleLinks(sessionId: string): ReaderLink[];
  print(sessionId: string): Promise<PrintResult>;
  outline(sessionId: string): Promise<ReaderOutlineSnapshot>;
}
```

PDF.js generic viewer의 검증된 primitive를 adapter 뒤에서 재사용할 수 있다.

- `PDFViewer`: page layout/visibility
- `PDFLinkService`: destination resolution
- text layer와 annotation layer builders
- search controller 또는 `getTextContent()` 기반 검색

하지만 다음은 직접 노출하지 않는다.

- generic viewer toolbar/sidebar/editor UI
- PDF.js `PDFHistory`
- annotation editor
- download/save actions
- JavaScript/scripting
- interactive forms와 embedded media
- generic viewer sidebar/thumbnail/bookmark UI

내부 viewer API는 버전 간 변할 수 있으므로 adapter contract test를 둔다. PDF.js를 올리는 PR은 feature PR과 분리하고 전체 PDF fixture suite를 실행한다.

## 7. 렌더링과 좌표계

### 7.1 Canonical 좌표

```ts
type NavigationSnapshot = {
  pageIndex: number;        // 0-based
  pagePoint: { x: number; y: number }; // unscaled PDF page space
};
```

- DOM scroll offset을 history에 저장하지 않는다.
- viewport transform은 `(page, scale, rotation, devicePixelRatio)`에서 한 번 계산한다.
- screen → viewport → page와 page → viewport → screen 변환을 한 module에서만 수행한다.
- 현재 macOS와 같은 location tolerance `0.5` page-space point를 사용한다.

### 7.2 Virtualization

- visible pages와 위/아래 overscan 최대 2페이지에만 canvas/text/annotation layer를 유지한다.
- 범위를 벗어난 `RenderTask`는 cancel한다.
- range 밖 canvas의 backing bitmap을 해제한다.
- page metadata와 작은 text/annotation cache는 별도 LRU로 관리한다.
- tab이 background가 되면 active render를 중지하되 navigation snapshot은 유지한다.
- 4 panes가 동시에 보여도 scheduler가 render concurrency를 제한한다.

### 7.3 검색과 링크

- 검색은 embedded text만, Unicode-aware case-insensitive literal 비교다.
- query generation이 바뀌면 늦은 이전 결과를 무시한다.
- annotation은 `intent: display`로 읽고 link action만 허용한다.
- exact duplicate는 page index, normalized rectangle, complete target이 모두 같은 경우에만 제거한다.
- adjacent/same-destination rectangle은 합치지 않는다.
- internal destination transaction은 resolve와 guarded scroll settlement 뒤 결과 viewport와 교차하는 page들을 existing resident window/resource budget 안에서 materialize하고, 그 뒤 canonical actual landing을 캡처해야만 성공/history를 commit한다.
- finite `XYZ` x/y는 rotation-aware viewport midpoint를 목표로 하고 unspecified axis는 기존 canonical 축을 보존한다. physical scroll은 document edge에서 clamp하며 clamped actual landing이 history authority다.
- `Fit`/`FitB` page-fit과 `FitR` rectangle-fit은 point-centering으로 바꾸지 않는다.
- newer navigation, lifecycle change 또는 raw user scroll은 stale work를 fence한다. failed/cancelled materialization은 history나 newer input을 덮지 않고 rollback/compensation을 따른다.
- landing completion을 위한 manual/synthetic scroll, detached repair 또는 unbounded residency를 두지 않는다.
- hint/indicator DOM, timers, settings와 IPC는 current link path의 dependency가 아니다.

### 7.4 Embedded outline TOC

> 현재 Windows 제품에는 TOC runtime/action/UI가 없다. 아래 구조는 `7e00424d30c5ffeab5a846d087236371644af53a`의 재개발 reference이며 active adapter/application wiring 요구가 아니다.

- PDF.js adapter는 `getOutline()`과 destination resolution만 노출하고 generic viewer sidebar UI를 사용하지 않는다.
- raw outline은 pure TS domain에서 immutable preorder rows로 바꾼다. stable ID는 structural child path이며 단일 title wrapper를 숨기고 visible depth는 최대 두 단계다.
- valid destination만 consecutive selector를 받고 invalid row는 hierarchy에 disabled 상태로 남는다.
- destination adapter는 current document page, finite media box, unspecified-coordinate sentinel, 8pt clamp/reject 정책을 `NavigationSnapshot`으로 정규화한다.
- application layer는 owning `PaneId`로 TOC state와 callbacks를 묶는다. active pane 외 입력 fallback을 허용하지 않는다.
- UI는 pane content 위에 maximum 300px floating widget(`min(300px, pane width - 24px)`)을 mount/re-raise하며 canvas layout을 변경하지 않는다. widget identity와 manual scroll/numeric state는 topology rerender 중 유지한다.
- numeric input은 injected scheduler/fake clock으로 검증되는 silent 400ms debounce다. Backspace는 마지막 digit을 지우고 deadline을 다시 시작하며 empty buffer면 취소한다. modal/config/focus/tab/pane lifecycle은 pending work를 취소한다.
- TOC activation은 기존 prepare → perform → verify → commit/rollback history transaction의 `.toc` producer를 사용한다. TOC 자체 movement provenance는 user scroll revision을 거짓 증가시키지 않는다.
- state/config persistence에는 TOC visibility, selector buffer, scroll, current row를 추가하지 않는다.

## 8. 키보드 아키텍처

### Windows config grammar

- modifier: `C`, `A`, `S`
- named keys: macOS v1 grammar와 같은 subset
- `D`는 지원하지 않고 macOS config migration diagnostic을 낸다.
- `Win`은 OS-reserved이므로 parser surface에 추가하지 않는다.
- modifier canonical order는 `C-A-S`다.
- bare Unicode literal, uppercase normalization, `<prefix>` expansion, fixed prompt keys는 기존 의미를 유지한다.

핵심 기본값:

| Action | Windows default |
|---|---|
| `document.open` | `<C-S-o>` (Issue #53 owner amendment) |
| `document.close` | `<C-w>` |
| `document.print` | `<C-p>` |
| `app.new` | `<C-n>` |
| `app.quit` | `<A-F4>` |
| `palette.open` | `:`, `<C-S-p>` |
| `tab.select.1..9` | `<C-1>.. <C-9>` |
| `history.back` | `<A-Left>` |
| `history.forward` | `<A-Right>` |
| command prefix | `<C-b>` |
| retired pane focus | `<C-h/j/k/l>` 미할당 |
| retired TOC / hint / indicator | `t` / `J` / `K` / `f` / `I` 미할당 |

DOM keyboard adapter는 `compositionstart/update/end`, `event.isComposing`, dead keys, AltGraph를 먼저 분류한다. prompt가 텍스트를 소유할 때 printable/IME input은 action engine으로 보내지 않는다. 앱이 처리한 key event만 `preventDefault()`하고, 나머지는 WebView2 native path에 남긴다.

## 9. 보안 경계

- strict CSP; remote script/style/font 없음
- Tauri capability는 window별 최소 권한
- broad `fs:read-all`, arbitrary shell, arbitrary URL open 금지
- custom PDF protocol은 registry에 살아 있는 opaque ID만 처리
- path traversal, guessed ID, unsupported method/range는 fail closed
- PDF scripting, launch action, file attachment, rich media, form submission 금지
- user-facing document title에 raw HTML 삽입 금지
- update metadata와 installer는 HTTPS 및 서명 검증
- secrets/signing certificate는 CI secret/store에만 두고 repo에 저장하지 않음

## 10. 아키텍처 게이트

W02 spike가 다음을 만족해야 이 구조를 확정한다.

- packaged Windows app에서 Range request가 실제 발생한다.
- 300-page fixture의 첫 페이지를 전체 파일 다운로드 완료 전 표시할 수 있다.
- 100/125/150/200% DPI에서 text, annotation과 search highlight의 최대 오차가 1 CSS px 이하이다.
- search와 internal GoTo가 rotation 0/90/180/270에서 page-space를 왕복한다.
- inactive pages의 canvas가 해제된다.
- interactive PDF가 form/script/media UI를 노출하지 않는다.
- source PDF hash가 변하지 않는다.
- print spike가 Microsoft Print to PDF dialog까지 도달하고 reader state를 보존한다.
- ordinary internal point-link fixture가 attainable center와 document-edge clamp를 재현하고, 성공 시점에 visible landing pages가 bounded resident/resource policy 안에서 materialize되며 source hash를 보존한다.

실패 시 기능을 계속 쌓지 말고 [테스트 및 위험 게이트](./testing-risks.md)의 대체 경로를 따른다.

## 11. 공식 참고 자료

- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Tauri calling Rust / binary response](https://v2.tauri.app/develop/calling-rust/)
- [Tauri capabilities](https://v2.tauri.app/security/capabilities/)
- [Tauri CSP](https://v2.tauri.app/security/csp/)
- [Tauri single-instance plugin](https://v2.tauri.app/plugin/single-instance/)
- [Tauri dialog plugin](https://v2.tauri.app/plugin/dialog/)
- [Tauri opener plugin](https://v2.tauri.app/plugin/opener/)
- [Tauri updater plugin](https://v2.tauri.app/plugin/updater/)
- [Tauri custom protocol builder API](https://docs.rs/tauri/latest/tauri/struct.Builder.html)
- [Tauri asset protocol Range implementation](https://docs.rs/tauri/latest/src/tauri/protocol/asset.rs.html)
- [PDF.js getting started](https://mozilla.github.io/pdf.js/getting_started/)
- [PDF.js PDFPageProxy API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html)
- [PDF.js FAQ](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions)
