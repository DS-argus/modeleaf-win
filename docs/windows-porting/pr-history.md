# 과거 PR 이력과 Windows 포팅 교훈

## 1. 사용 원칙

이 문서는 GitHub의 v0.10.0까지 merged feature/fix PR 40건을 immutable release source와 비교해 정리한 것이다. #44는 #45가 닫은 Issue이며 #46/#47과 PR #48은 post-release verification infrastructure다.

PR은 당시 목표와 실패 맥락을 알려 주지만 최종 계약은 아니다. PR 본문과 immutable v0.10.0 source/test가 충돌하면 release commit `0f7ff0b54c3674c48f6b555261f939397cfbfb88`이 우선한다.

### 반드시 기억할 supersession

| 이전 설명 | 최종 기준 | Windows에서 피할 실수 |
|---|---|---|
| 초기 link hint 구현 | #2가 제거, #19–#23이 다시 구축 | 초기 half-working code/behavior 복제 금지 |
| #19의 measured adjacent merge | #23 + current `LinkHintMerge`의 exact duplicate only | 같은 destination/인접 rectangle을 합치지 않음 |
| #3/#38의 install-source별 안내 | #43의 macOS Homebrew-only 정책 | Windows에 Homebrew나 mac install-source 추론을 복제하지 않음 |
| viewer current-page 기반 jump 판정 | #41의 captured viewport landing | PDF.js current page label만 보고 history commit하지 않음 |
| v0.9.2의 58 actions | #45의 TOC actions 추가 후 v0.10.0은 61 actions | old action-count snapshot 복제 금지 |
| v0.10.0 wall-clock TOC debounce tests | post-release #48의 fake clock + literal 399/400ms contract | real sleep 기반 timer test 금지 |
| forbidden bookmark vocabulary | embedded outline을 읽는 TOC는 허용, bookmark 작성/편집은 계속 금지 | TOC를 generic bookmark/sidebar feature로 확장하지 않음 |

## 2. 링크, 힌트, 읽기 전용

### [#1 Allow following links by click](https://github.com/DS-argus/modeleaf/pull/1)

- 가져올 것: URL은 browser, GoTo는 document navigation이라는 read-only 예외.
- 주의: link activation은 mutation이 아니지만 form/annotation click과 같은 allowlist로 처리하면 안 된다.
- Windows 회귀: annotation layer의 link만 pointer-active, unsupported action은 inert.

### [#2 Drop the 'f' link-hint feature (keep link click)](https://github.com/DS-argus/modeleaf/pull/2)

- 배경: early hint 기능이 QR annotation/plain-text URL 등에서 불완전해 제거됐다.
- 가져올 것: 기능 surface를 열기 전에 fixture-backed acceptance가 필요하다는 교훈.
- superseded: #19–#23이 완성된 hints를 다시 추가한다.

### [#19 core: link-hint pure core — merge rule, labels, filter](https://github.com/DS-argus/modeleaf/pull/19)

- 가져올 것: geometry/UI와 label/filter/merge pure rules 분리.
- 폐기할 것: PR 본문의 measured wrapped/adjacent merge 설명.
- Windows 회귀: pure TS에서 labels/filter/dedupe를 먼저 구현.

### [#20 app: link-hint provider/overlay/geometry dismissal](https://github.com/DS-argus/modeleaf/pull/20)

- 가져올 것: provider boundary, visible geometry, modal overlay, scroll/geometry 변화 dismissal.
- Windows 회귀: PDF.js adapter가 raw annotations를 제공하고 UI가 page transform을 공유.

### [#21 app/core: link.hint action with atomic f/F swap](https://github.com/DS-argus/modeleaf/pull/21)

- 최종 key: `f = link.hint`, `F = view.fitPage`.
- 교훈: action/default/docs/help/tests를 한 변경으로 맞춘다.

### [#22 test/docs: link-hint acceptance e2e + read-only proof](https://github.com/DS-argus/modeleaf/pull/22)

- 가져올 것: click/hint/geometry/read-only를 함께 증명하는 acceptance.
- Windows 회귀: `f`를 노출하기 전 URL, GoTo, excluded target, source hash tests 통과.

### [#23 fix: N3 gate blockers — Shift/Caps labels, deterministic merge, hardened tests](https://github.com/DS-argus/modeleaf/pull/23)

- 최종 merge: raw annotation 전체가 exact equal일 때만 dedupe.
- 같은 destination, adjacent rectangle, wrapped appearance는 merge 근거가 아니다.
- Windows 회귀: Shift/Caps/IME/modified input과 canonical reading order를 고정.

### [#24 app/core: page rotation with [ and ]](https://github.com/DS-argus/modeleaf/pull/24)

- 가져올 것: 90도, view-only, pane-local, non-persisted, fit reapply.
- Windows 회귀: PDF.js viewport rotation이지 PDF byte/annotation edit가 아님.

## 3. Recent, open overlay, state

### [#4 N5 slice 1: state-file transactions, recent-files store, filename fuzzy filter](https://github.com/DS-argus/modeleaf/pull/4)

- 가져올 것: state read/merge/replace transaction, recent max 15, filename fuzzy filter, unknown-key retention.
- Windows 회귀: concurrent window/process update와 atomic replace fault injection.

### [#5 N5 slice 2: unified ⌘O overlay (Browse + recent, filename fuzzy)](https://github.com/DS-argus/modeleaf/pull/5)

- 가져올 것: Browse와 recents를 하나의 Open surface로 통합.
- Windows delta: `Ctrl+O`, native dialog, Explorer handoff.

### [#6 N5 slice 3: missing-file inline error + prune, Ctrl+c clear, key hints, highlight](https://github.com/DS-argus/modeleaf/pull/6)

- 가져올 것: inline error, stale missing prune, clear recents, keyboard hints.
- Windows 회귀: file/path not found만 prune; access denied/network/locked는 유지.

### [#7 N5 gate fixes: bounded scroll list, theme-preview rollback, persist-failure surfacing, PDF invariant](https://github.com/DS-argus/modeleaf/pull/7)

- 가져올 것: 작은 창 bounded list, preview rollback, persistence failure truthfulness, recent record/display의 `.pdf` invariant.
- Windows 회귀: 480×360, non-PDF path는 recent에서 reject/filter, state write denial. 이 규칙을 open service의 content validation으로 확대하지 않는다.

### [#8 Create state temp files 0600 at open time](https://github.com/DS-argus/modeleaf/pull/8)

- 가져올 목적: sensitive recent paths가 transaction 중 더 넓은 권한으로 노출되지 않음.
- literal port 금지: `0600`, POSIX open/flock/rename 대신 Windows ACL/lock/replace 의미를 구현.

### [#9 Overlay polish: English hints, arrow keys, all 15 recents visible](https://github.com/DS-argus/modeleaf/pull/9)

- 가져올 것: normal window에서 15 recents, arrows 지원, 명료한 영문 product UI.
- Windows 회귀: 좁은 창 내부 scroll과 Unicode filename.

### [#18 test: isolate user-state stores in controller tests](https://github.com/DS-argus/modeleaf/pull/18)

- 가져올 것: 테스트가 실제 사용자 state를 읽거나 덮어쓰지 않도록 dependency-injected temp stores 사용.
- Windows 회귀: `%APPDATA%`/`%LOCALAPPDATA%`를 test에서 직접 건드리지 않는다.

## 4. Palette, help, config, key grammar

### [#10 Palette navigation overhaul (N6) + '?' keyboard help overlay (N7)](https://github.com/DS-argus/modeleaf/pull/10)

- 가져올 것: `Ctrl+J/K`, bounded 12 rows, enabled-first, adaptive help.
- Windows 회귀: row accessibility와 minimum window layout.

### [#11 fix: N6/N7 gate blockers — help.show context scope + empty-window availability](https://github.com/DS-argus/modeleaf/pull/11)

- 가져올 것: `?`는 navigation-only, palette의 help entry는 document-independent availability를 정확히 계산.
- 교훈: shortcut context와 command availability는 같은 개념이 아니다.

### [#12 docs: fix stale key-table rows (f = fit page, add ? help)](https://github.com/DS-argus/modeleaf/pull/12)

- 가져올 교훈: key 변경 시 README/CONFIG/help snapshot을 같은 PR에서 검증.
- 당시 `f` 설명은 후속 #21에서 다시 바뀌었으므로 최종 key는 current defaults를 따른다.

### [#13 core: prefix-relative built-in bindings as raw templates (N8 slice A)](https://github.com/DS-argus/modeleaf/pull/13)

- 가져올 것: built-in `<prefix>` template는 prefix 변경을 따라가지만 user literal sequence를 암묵적으로 rewrite하지 않음.
- Windows 회귀: `<C-b>` default와 raw template snapshot.

### [#14 app/core: Reload Config with single-generation hot reload (N8 slice B)](https://github.com/DS-argus/modeleaf/pull/14)

- 가져올 것: valid reload는 key/menu/help를 한 generation으로 교체, invalid reload는 last good 유지.
- Windows 회귀: partial activation 금지.

### [#15 app/core: Write/Reset Config with durable file transactions (N8 slice C)](https://github.com/DS-argus/modeleaf/pull/15)

- 가져올 것: exclusive Write Default, `.bak`, no-op reset, durable transaction.
- Windows 회귀: antivirus lock과 replace failure matrix.

### [#16 docs: config guidance for Write/Reset/Reload (N8 slice D)](https://github.com/DS-argus/modeleaf/pull/16)

- 가져올 것: operational behavior를 CONFIG.md에 product contract로 기록.
- Windows delta: AppData paths와 `C/A/S` grammar로 교체.

### [#17 fix: N8 gate blockers — pinned diagnostics, fault matrix, dispatch contracts](https://github.com/DS-argus/modeleaf/pull/17)

- 가져올 것: pinned diagnostic, transaction fault injection, dispatch outcome.
- Windows 회귀: I/O failure를 success처럼 표시하지 않음.

### [#25 app/core: literal-case notation, help rework, status-bar help hint (N9 slice B)](https://github.com/DS-argus/modeleaf/pull/25)

- 가져올 것: uppercase literal과 explicit Shift 구분, `? help` status hint, adaptive help layout.
- Windows 회귀: `C-A-S` canonical notation과 accessible rendered label 분리.

### [#26 fix: N9 gate blockers — prompt focus, Search rows, notation residue](https://github.com/DS-argus/modeleaf/pull/26)

- 가져올 것: prompt focus restoration, Search action rows, stale notation 제거.
- Windows 회귀: overlay layering + IME composition.

### [#27 core: fix config key grammar — canonical Shift, narrowed named keys (N10)](https://github.com/DS-argus/modeleaf/pull/27)

- 가져올 것: explicit canonical Shift, named key subset, Enter canonicalization.
- Windows 회귀: DOM `key`/`code`를 무제한 grammar로 노출하지 않음.

### [#28 fix: N10 gate findings — token-level normalization, modifier-preserving guidance](https://github.com/DS-argus/modeleaf/pull/28)

- 가져올 것: token-level normalization, modifier 정보를 잃지 않는 diagnostic/help.
- Windows 회귀: AltGraph와 IME가 modifier chord로 오판되지 않음.

### [#29 docs: restructure READMEs to five sections, single CONFIG reference](https://github.com/DS-argus/modeleaf/pull/29)

- 가져올 교훈: key/config 상세의 source를 하나로 유지하고 README에 중복 표를 확산시키지 않음.

## 5. Navigation history

### [#30 N11 PR-A: add navigation history domain model](https://github.com/DS-argus/modeleaf/pull/30)

- 가져올 것: PDFKit-free snapshot/history/search epoch pure model, max 100.
- Windows 회귀: PDF.js/DOM 없이 pure TS tests부터 시작.

### [#31 Add N11 navigation transaction foundation](https://github.com/DS-argus/modeleaf/pull/31)

- 가져올 것: page-space anchors, prepare/verify/commit, fail-closed restore, duplicate snapshot.
- Windows 회귀: DOM `scrollTop` persistence 금지.

### [#32 Wire navigation history producers](https://github.com/DS-argus/modeleaf/pull/32)

- producer: internal GoTo mouse/hint, search landing, page/first/last jump.
- exclusion: URL, same/unresolved/stale/cancelled, ordinary movement.
- Windows 회귀: producer matrix를 parameterized test로 고정.

### [#33 Add navigation history commands](https://github.com/DS-argus/modeleaf/pull/33)

- 가져올 것: Back/Forward action availability, prompt isolation, physical key distinction.
- Windows delta: 기본키는 Open 충돌을 피해 `Alt+Left/Right`; user config의 `Ctrl+I`는 Tab과 별개로 test.

### [#34 Document navigation history](https://github.com/DS-argus/modeleaf/pull/34)

- 가져올 것: producer/exclusion/restore state를 user docs와 tests에서 같은 표현으로 유지.

### [#35 Complete N11 navigation history verification](https://github.com/DS-argus/modeleaf/pull/35)

- 가져올 것: search/link/panes/duplicates를 가로지르는 red-team transaction tests.
- 교훈: pure stack만 맞아도 integration landing이 틀리면 기능은 미완성.

### [#41 Fix continuous-scroll gg navigation and release 0.9.1](https://github.com/DS-argus/modeleaf/pull/41)

- 최종 동작: `gg`/first/last/page jump의 no-op 판정은 continuous viewport의 captured landing을 사용.
- prefix timeout은 800ms에서 400ms로 확정.
- Windows 회귀: IntersectionObserver의 stale current page label에 의존하지 않음.

## 6. Embedded outline TOC와 v0.10.0

### [Issue #44 — Pane-local keyboard-first TOC](https://github.com/DS-argus/modeleaf/issues/44)

- 문제/acceptance의 간결한 source다. 구현 세부와 검증 결과는 PR #45가 담당한다.
- TOC만 scope이며 thumbnails, bookmark 작성, annotations, attachments, OCR, outline generation은 명시적 비범위다.

### [PR #45 — Add pane-local keyboard-first TOC](https://github.com/DS-argus/modeleaf/pull/45)

- PDF embedded outline만 immutable preorder snapshot으로 읽는다.
- single title wrapper를 숨기고 visible depth는 top level + direct child 두 단계로 제한한다.
- structural row ID를 유지하며 valid destination만 consecutive numeric selectors를 받는다. invalid row는 visible/disabled다.
- destination은 current document/finite media box/sentinel/8pt 정책으로 정규화한다.
- floating headerless widget은 owning pane의 top-right에 있고 PDF canvas를 resize하지 않는다.
- 기본 `t/J/K`, silent 400ms numeric commit, strict active-pane routing, live rebound footer hints를 제공한다.
- verified TOC landing만 app history에 기록하고 failed/no-op semantics와 exact selection rollback을 분리한다.
- 2/3/4-pane growth, tab replacement z-order, widget identity, final close cleanup, accessibility press, dark-theme contrast를 고정했다.
- source PDF hash는 generated fixture와 real Inference Engineering PDF 모두에서 보존됐다.
- feature commit `7a7fb952` → version `6e977e5a` → final fixes `d8dd96a0` → merge `0f7ff0b54c3674c48f6b555261f939397cfbfb88`.
- [v0.10.0 release](https://github.com/DS-argus/modeleaf/releases/tag/v0.10.0)는 version/build `0.10.0 / 12`, 61 actions, 517 tests/59 suites를 기준으로 한다.

Windows 회귀:

- PDF.js `getOutline()`만 adapter 뒤에서 사용하고 generic sidebar UI는 가져오지 않는다.
- pane owner, numeric timer, destination normalization, history transaction, lifecycle cancellation을 각각 독립 테스트한다.
- no-outline 문서에 synthetic TOC를 만들지 않는다.

### [PR #48 — Stabilize and shard test verification](https://github.com/DS-argus/modeleaf/pull/48) — post-release infrastructure

- v0.10.0 첫 release attempt에서 real 250ms sleep이 loaded runner에서 400ms deadline 뒤 재개되어 digits가 따로 commit된 교훈을 기록한다.
- product delay는 여전히 400ms다. tests는 independent `== 400` assertion과 literal 399/1ms fake-clock boundary, renewed deadline/cancelled work를 검증한다.
- Windows repo도 focused/core/app/full/hygiene 계층과 independent CI shards, toolchain/lockfile/shard-aware caches를 갖되 packaged Windows E2E를 생략하지 않는다.
- merge `0218e0a8a8a34aa8812dcd252b23290746cebd36`은 app behavior baseline이 아니라 verification guidance다.

## 7. Update와 release

### [#3 Update-available banner in the status bar](https://github.com/DS-argus/modeleaf/pull/3)

- 가져올 것: launch 후 비동기 check, SemVer 비교, unobtrusive status banner, offline silent.
- 초기 install-source 분기는 최종 mac 정책에서 superseded.

### [#38 Make update guidance actionable](https://github.com/DS-argus/modeleaf/pull/38)

- 가져올 것: clickable banner, `U`, palette action, instructions overlay.
- Windows delta: Windows installer/release link와 copy로 교체.

### [#39 Authenticate Homebrew tap publication](https://github.com/DS-argus/modeleaf/pull/39)

- macOS 전용: Homebrew tap push auth.
- Windows에서 복제하지 않음. 교훈은 release credential을 explicit CI secret과 least privilege로 관리하는 것.

### [#43 Make Homebrew the sole update path and release 0.9.2](https://github.com/DS-argus/modeleaf/pull/43)

- macOS 최종: Homebrew 한 경로, 앱은 자동 설치하지 않음.
- Windows 최종 해석: 한 supported Windows installer channel, notify-only, 자동/무인 설치 없음.

## 8. PR 밖의 중요 commit

### [425e4c4 feat: add native PDF printing](https://github.com/DS-argus/modeleaf/commit/425e4c4ecf2a7834cfa3ab44f1bead0bae3317e3)

- print action/menu/key/capability/session/PDFKit operation/tests를 한 번에 추가했다.
- Windows에서 단순 `window.print()`로 복제하면 virtualization 때문에 visible pages만 출력될 수 있다.
- W02 feasibility spike와 W12 production print phase로 별도 취급한다.

## 9. 전체 merged PR 체크리스트

아래 표는 history audit에서 빠진 PR이 없는지 확인하는 인덱스다.

| PR | 기능군 | Windows 문서 위치 |
|---:|---|---|
| #1–#2 | link click / early hint rollback | Feature §1, §7; W08 |
| #3 | update banner | Feature §15; W13 |
| #4–#9 | state/recent/open overlay | Feature §2, §12; W04/W11 |
| #10–#12 | palette/help/docs | Feature §4, §10; W03/W11 |
| #13–#17 | config lifecycle/transactions | Feature §11; W03/W04/W11 |
| #18 | state test isolation | Test plan; W04 |
| #19–#23 | final link hints | Feature §7; W08 |
| #24 | rotation | Feature §3; W06 |
| #25–#28 | help/prompt/key grammar | Feature §4, §10; W03/W05/W11 |
| #29 | docs source consolidation | Agent runbook |
| #30–#35 | navigation history | Feature §5–§7; W03/W07/W08 |
| #38 | actionable update UI | Feature §15; W13 |
| #39 | release auth | Test/release plan; W13 |
| #41 | continuous jump + 400ms prefix | Feature §3–§5; W03/W06/W07 |
| #43 | v0.9.2 update path | Feature §15; W13 |
| #45 | embedded-outline pane-local TOC / v0.10.0 | Feature §8; W10 |
| #48 | deterministic timing + sharded verification, post-release | Test plan; Agent runbook |

새 Windows PR 본문에는 관련 macOS PR 번호를 적는다. 단순 번호 나열이 아니라 “어떤 최종 계약/회귀를 가져왔는지”를 한 줄로 설명한다.
