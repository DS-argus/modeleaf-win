# Windows 개발 에이전트 Runbook

## 1. 임무

새 Windows 저장소에서 [단계별 구현 계획](./implementation-phases.md)의 `W00`부터 순서대로 실행한다. 목표는 Swift 코드를 번역하는 것이 아니라, `v0.10.0`의 observable behavior와 회귀 방지를 `Tauri 2 + Rust + TypeScript + PDF.js`로 재현하는 것이다.

이 runbook은 구현·검증·PR까지의 절차다. merge, tag, public release는 저장소 owner의 명시적 승인 없이는 하지 않는다.

## 2. 세션 시작 절차

매 세션 처음에 다음을 한다.

1. 저장소 root의 `AGENTS.md`를 읽는다.
2. `git status --short --branch`로 사용자 변경을 확인한다.
3. `git fetch origin --prune`으로 remote baseline을 확인한다.
4. 현재 Issue, acceptance criteria, 선행 gate의 evidence를 읽는다.
5. [기능 계약](./feature-spec.md)과 [PR 이력](./pr-history.md)에서 관련 기능만 읽는다.
6. parity matrix의 해당 row 상태를 확인한다.
7. 관련 fixture와 source SHA를 확인한다.
8. 구현 전에 실패하는 regression test를 먼저 추가하거나, coverage가 충분하면 기존 test가 실패하는 것을 확인한다.

선행 gate가 없거나 실패 상태라면 다음 phase를 구현하지 않는다.

## 3. Issue-first 작업 단위

한 기능마다 GitHub Issue를 먼저 만든다.

```markdown
## Problem
재현할 v0.10.0 동작과 현재 Windows gap.

## Source contract
- macOS files/tests:
- historical PRs:
- baseline SHA: 0f7ff0b54c3674c48f6b555261f939397cfbfb88

## Scope
- in:
- out:

## Windows delta
- none / explicit delta and reason:

## Acceptance criteria
- [ ] pure test
- [ ] component test if UI
- [ ] fixture-backed native E2E if PDF/OS behavior
- [ ] source PDF SHA unchanged
- [ ] parity matrix/docs updated

## Risks and stop conditions
- risk:
- evidence required:
```

Issue에 없는 기능을 구현 중 발견하면 자동으로 scope에 섞지 않는다. 현재 기능을 안전하게 완성하는 데 필수면 이유와 최소 변경을 Issue/PR에 기록한다. 제품 동작이나 release channel을 바꾸는 선택이면 별도 Issue/ADR로 올린다.

## 4. Branch/worktree

저장소가 이 macOS repo와 같은 정책을 채택한다면 다음 패턴을 권장한다.

```text
GitHub Issue
  → origin/main 기반 feat/<slug> branch/worktree
  → regression test
  → implementation
  → targeted verification
  → full required checks
  → draft PR
```

예시:

```bash
git fetch origin --prune
git worktree add ../modeleaf-windows-<slug> -b feat/<slug> origin/main
```

- `main`에서 직접 기능 개발하지 않는다.
- 다른 worktree의 미커밋 변경을 stash/reset/delete하지 않는다.
- unrelated 파일을 stage하지 않는다.
- commit/push/PR 정책은 Windows repo `AGENTS.md`가 더 엄격하면 그것을 따른다.

## 5. 구현 순서

한 Issue 안에서도 다음 순서를 지킨다.

### 5.1 Contract lock

- immutable macOS v0.10.0 commit `0f7ff0b54c3674c48f6b555261f939397cfbfb88`의 source/test와 최종 PR을 확인한다.
- 예상 입력/출력/failure/no-op을 표로 만든다.
- Windows intentional delta가 있으면 ADR/parity row를 먼저 수정한다.
- evidence를 release-baseline, historical intent, post-release infrastructure, Windows-native proof로 분류한다. 후속 CI 개선을 app behavior 변경으로 오해하지 않는다.

### 5.2 Pure behavior first

- parser/reducer/state machine/model을 framework-independent module에 구현한다.
- source Swift test case를 의미 단위로 포팅한다.
- timer/concurrency는 deterministic scheduler/fake clock으로 test한다. TOC numeric debounce는 production delay가 400ms인지 독립적으로 assert하고 literal 399ms 무동작/1ms commit과 second-digit와 Backspace deadline renewal을 검증한다.

### 5.3 Adapter

- PDF.js, Tauri command, filesystem, WebView event를 작은 interface 뒤에 연결한다.
- 외부 library object를 domain state에 저장하지 않는다.
- error를 string 하나로 납작하게 만들지 말고 typed outcome으로 보존한다.

### 5.4 UI

- semantic HTML과 live action registry projection을 사용한다.
- hardcoded shortcut/help/menu duplication을 만들지 않는다.
- focus owner와 input context를 먼저 연결하고 style을 얹는다.

### 5.5 Native integration

- packaged Windows binary에서 테스트한다.
- dev browser에서 동작했다는 사실만으로 Open With, Range, print, installer를 완료 처리하지 않는다.

## 6. 파일별 ownership 규칙

| Surface | Owner | 금지 |
|---|---|---|
| action/input/config/history/tab/pane rules | TypeScript domain | DOM/Tauri/PDF.js import |
| PDF page/render/text/annotation geometry | PDF.js adapter | Rust per-frame state |
| file handles/path/config/state transaction | Rust | frontend broad fs access |
| window/pane/tab UI/focus | TypeScript UI/application | PDF.js internal history |
| external URL/installer/update boundary | Rust/Tauri | arbitrary shell/URL execution |
| default config/help/menu/status bindings | action registry projection | 개별 hardcoded table |
| embedded outline normalization/selector | TypeScript domain + PDF.js adapter | generic viewer sidebar/bookmark UI |
| pane-local TOC state/input/widget | TypeScript application/UI | cross-pane fallback, persisted TOC state |

## 7. 변경 시 함께 갱신할 artifact

### Action 또는 key 변경

- Action ID/descriptor
- default keymap
- config validation/reservation snapshots
- menu descriptors
- palette/help/status projection
- `CONFIG.md` / generated default TOML
- action count/default collision tests
- Windows key labels

### Embedded outline TOC 변경

- 61-action registry와 `t/J/K` defaults/help/menu/config
- PDF.js `getOutline()` adapter contract
- immutable outline rows, destination normalization, valid-only selector tests
- pane-local widget ownership/input/z-order/lifecycle tests
- 399/400ms fake-clock boundary와 renewed deadline
- accessibility/high-contrast/component tests
- generated/real outline fixture source SHA
- parity matrix와 [`ui/05-toc-overlay.png`](./ui/05-toc-overlay.png) reference

thumbnail/bookmark/attachment/OCR/outline-generation scope를 함께 추가하지 않는다.

### Config/state 변경

- schema/DTO
- loader/reloader
- write/reset or field-update transaction
- unknown field/fault tests
- docs/default example
- migration note

### PDF.js dependency 변경

- package and worker exact version
- lockfile
- CMap/font/wasm asset paths
- adapter contract tests
- all PDF fixture E2E
- W02 performance/geometry comparison
- dependency license/security note

### Release path 변경

- installer config
- signing pipeline
- release metadata
- update checker/banner/instructions
- clean VM smoke
- user docs
- 별도 승인

## 8. 최소 검증 명령

Windows repo의 script 이름이 다르면 equivalent command를 사용하고 PR에 실제 command를 기록한다.

검증 wrapper는 이름이 달라도 다음 mode를 제공한다.

- `focused <suite>`: 구현 중 affected suite만 빠르게 실행
- `core`: DOM/PDF.js/Tauri 없는 pure TS/Rust domain
- `app`: adapter/UI/integration
- `full`: PR 전 모든 lint/typecheck/unit/integration/project validation/diff hygiene
- `hygiene`: working tree, staged index, baseline-to-head committed range를 모두 검사

CI는 Core, App, project validation을 `fail-fast: false` independent jobs로 보고한다. cache key는 runner OS, exact toolchain fingerprint, lockfile hash, shard, commit을 포함하고 같은 shard의 compatible cache만 restore한다. tagged release는 cache hit 여부와 무관하게 tagged commit의 full gate와 packaged Windows smoke를 다시 통과해야 한다.

```bash
pnpm lint
pnpm typecheck
pnpm test
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
pnpm test:e2e
pnpm tauri build --debug
git diff --check
```

검증 순서:

1. changed pure unit tests
2. changed component/integration tests
3. matching PDF/native E2E
4. full lint/typecheck/unit
5. Rust fmt/clippy/test
6. packaged build/smoke when platform surface changed
7. `git diff --check`

문서-only PR은 code build를 생략할 수 있지만 Markdown link check와 `git diff --check`는 실행한다.

## 9. PR 본문

```markdown
## Summary
- observable result
- intentional Windows delta, if any

## Contract evidence
- macOS source/tests:
- related PRs:
- parity row:
- evidence class: release-baseline / historical / post-release-infrastructure / Windows-native

## Implementation
- domain:
- adapter/platform:
- UI:

## Risks addressed
- regression:
- mitigation/test:

## Verification
- `command` — pass/fail summary
- fixture SHA / Windows / WebView2:
- native manual evidence:

## Remaining risks
- none / linked follow-up

Closes #<issue>
```

PR은 실제 실행하지 않은 test를 체크하지 않는다. native Windows 검증을 못 했다면 정확히 무엇이 빠졌는지 적고 merge blocker 여부를 표시한다.

## 10. 중단하고 상위 결정을 요청할 조건

다음은 구현 세부가 아니라 architecture/product/release 선택이다.

- custom protocol과 binary fallback 모두 W02 budget 실패
- PDF.js가 필요한 link/search/print semantics를 안정적으로 제공하지 못함
- read-only를 깨지 않고 feature를 구현할 수 없음
- default key를 바꾸거나 action 61개 surface를 확장해야 함
- state/config schema migration이 필요함
- notify-only에서 self-update로 제품 정책을 바꾸려 함
- NSIS 대신 MSI/Store 또는 새 architecture를 추가하려 함
- signing credential/production release 권한이 필요함

질문하기 전 안전한 read-only 조사, fixture reproduction, 최소 prototype, 공식 문서 확인을 끝내고 evidence와 선택지를 제시한다.

## 11. 즉시 rollback/rework할 조건

- source PDF hash 변화
- broad filesystem/shell capability 추가
- remote CDN/script 의존
- UI와 worker의 PDF.js version mismatch
- failed transaction을 성공으로 표시
- history가 scroll noise를 기록
- exact duplicate가 아닌 link annotation merge
- IME composition 중 reader command 실행
- virtualizer가 whole-document canvas를 mount
- feature PR에 release/tag/publish가 섞임

## 12. 세션 종료 확인

- Issue acceptance가 모두 실제 evidence로 충족됐는가
- parity matrix 상태를 갱신했는가
- 관련 docs/default/help/menu가 동기화됐는가
- user worktree/unrelated edits를 건드리지 않았는가
- tests/build 결과를 읽고 실패를 숨기지 않았는가
- 다음 phase 선행 gate가 정말 열렸는가
- commit/push/PR/merge/release가 요청 범위를 넘지 않았는가

하나라도 아니면 완료라고 보고하지 않는다.
