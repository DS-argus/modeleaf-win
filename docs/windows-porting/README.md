# Modeleaf v0.10.0 Windows 포팅 명세

이 폴더는 macOS용 Modeleaf `v0.10.0`의 기능, 제품 철학, UI를 Windows 전용 새 저장소에서 재구현하기 위한 실행 명세다. 대상 기술 스택은 `Tauri 2 + Rust + TypeScript + PDF.js`로 고정한다.

이 문서의 독자는 Windows 구현을 맡은 개발 에이전트다. Swift/AppKit/PDFKit 코드를 줄 단위로 번역하지 말고, 여기 적힌 동작 계약과 회귀 테스트를 새 코드로 재현한다.

## 고정 기준

| 항목 | 기준 |
|---|---|
| macOS 기준 버전 | `v0.10.0` |
| 기준 커밋 | `0f7ff0b54c3674c48f6b555261f939397cfbfb88` |
| 앱 버전 / 빌드 | `0.10.0` / `12` |
| 공개 액션 | 61개 |
| 최근 파일 상한 | 15개 |
| 패널 상한 | 4개 |
| 내비게이션 위치 상한 | 100개 |
| 기본 뷰 | 세로 연속, Fit Width, 1페이지 시작 |
| 제품 경계 | 로컬 PDF 전용, 읽기 전용, OCR·편집·저장·플러그인 없음 |

현재 저장소에서 확인한 테스트 표면은 Swift Testing `@Test` 선언 517개(59 suites)와 별도 UI 테스트 메서드 17개다. 숫자를 기계적으로 맞추는 것이 목표는 아니지만, Windows 포트는 해당 동작 범주를 기능별 회귀 테스트로 이전해야 한다.

## 근거 우선순위

서로 충돌하는 설명을 발견하면 다음 순서로 판단한다.

1. `v0.10.0`의 실행 코드와 회귀 테스트
2. 병합된 PR 중 가장 나중의 수정 PR
3. `CONFIG.md`와 현재 README
4. 오래된 PR 본문과 계획 문서

알려진 충돌은 다음과 같다.

- 링크 힌트 병합은 PR #19의 인접 사각형 병합 설명이 아니라, PR #23과 현재 테스트의 **정확히 같은 annotation만 중복 제거**가 최종 계약이다.
- README의 “줄바꿈 링크는 힌트 하나” 설명은 현재 코드와 충돌한다. PDF.js가 별도 annotation으로 반환하면 별도 힌트를 유지한다.
- 업데이트 경로는 PR #3/#38의 초기 구분보다 PR #43의 최종 정책이 우선한다. 단, Homebrew 자체는 Windows로 옮기지 않는다.
- `gg`/`G`/페이지 점프는 PR #41처럼 stale current-page 값이 아니라 실제로 캡처한 viewport landing을 기준으로 성공과 no-op을 판정한다.
- PR #45의 TOC는 PDF에 이미 포함된 outline만 읽는다. bookmark/thumbnail/attachment/OCR/outline 생성 기능으로 확장하지 않는다.

자세한 이력은 [PR 이력과 교훈](./pr-history.md)을 따른다.

## 문서 읽는 순서

1. [기능 계약](./feature-spec.md) — 무엇을 같게 만들고 무엇을 Windows에서 바꾸는가
2. [대상 아키텍처](./architecture.md) — Rust, TypeScript, PDF.js의 책임과 보안 경계
3. [Windows UX 명세](./ux-spec.md) — 창, 탭, 패널, 오버레이, 접근성
4. [단계별 구현 계획](./implementation-phases.md) — 새 저장소에서 만들 Issue/PR 순서와 각 게이트
5. [테스트 및 위험 게이트](./testing-risks.md) — fixture, 자동화, 성능, 출시 차단 기준
6. [PR 이력과 교훈](./pr-history.md) — 과거 회귀와 supersession
7. [개발 에이전트 실행 규칙](./agent-runbook.md) — 매 작업의 시작·완료·중단 방식
8. [근거 인덱스](./source-index.md) — 현재 Swift 소스와 공식 외부 문서 링크

## 고정된 Windows 결정

| 주제 | Windows 결정 | macOS와 달라지는 점 |
|---|---|---|
| 프로세스/창 | Tauri 단일 프로세스, 다중 top-level window | macOS `app.new`는 새 앱 프로세스를 띄움 |
| 창 닫기 | `app.quit`/`Alt+F4`는 호출한 top-level window만 닫고 마지막 창에서 프로세스 종료 | 같은 프로세스의 다른 창까지 한꺼번에 종료하지 않음 |
| 창 장식 | 첫 릴리스는 native Windows titlebar | macOS의 transparent full-size titlebar와 traffic-light inset을 복제하지 않음 |
| PDF 전달 | Rust가 read-only handle을 보유하고 opaque URL로 Range 응답 | PDFKit가 파일 URL을 직접 읽는 구조를 사용하지 않음 |
| config | Tauri `appConfigDir()/config.toml` | `~/.config/modeleaf/config.toml`을 사용하지 않음 |
| state | Tauri `appLocalDataDir()/state.json` | 로컬 파일 경로를 roaming profile에 저장하지 않음 |
| 키 문법 | `C=Ctrl`, `A=Alt`, `S=Shift`; `D`와 `Win` modifier 없음 | `D=Command` 문법 제거 |
| 앱 단축키 | `Ctrl+O/W/P/N`, `Ctrl+Shift+P`, `Ctrl+1..9`, `Alt+F4` | macOS `Cmd` 계열을 Windows 표준으로 번역 |
| 히스토리 | 기본 `Alt+Left`, `Alt+Right` | macOS `Ctrl+O/I`는 `Ctrl+O` Open과 충돌하므로 변경 |
| TOC | PDF.js `getOutline()` 기반 pane-local floating overlay, `t`/`J`/`K`와 400ms 숫자 선택 | PDF.js generic sidebar·thumbnail·bookmark UI를 켜지 않음 |
| 파일 연결 | 설치 시 `.pdf` Viewer/Open With 등록, 기본 앱 강제 변경 금지 | Finder document role을 Windows installer 등록으로 치환 |
| 업데이트 | 새 버전 확인·알림·다운로드 안내만; 자동 설치 없음 | Homebrew 안내 제거; 명시적 Windows installer 경로 사용 |
| 설치 형식 | 첫 공개 릴리스는 signed NSIS x64 | DMG/ZIP/Homebrew release flow를 사용하지 않음 |
| WebView2 | 기본 bootstrapper 방식, clean-machine 설치 테스트 | macOS 시스템 WebKit 전제를 사용하지 않음 |
| 창 상태 | 세션/탭/페이지를 저장하지 않음; 초기 크기 계약만 유지 | `window-state` 플러그인으로 새 persistence를 몰래 추가하지 않음 |
| 외부 링크 | 첫 릴리스는 `http`/`https`만 OS 브라우저로 전달 | 임의 scheme 실행을 허용하지 않는 보안상 의도적 차이 |

Tauri의 `appConfigDir`와 `appLocalDataDir`는 이미 `tauri.conf.json`의 bundle identifier를 붙여 반환한다. 따라서 그 아래에 `Modeleaf` 디렉터리를 한 번 더 붙이지 않는다.

## 유지해야 하는 제품 철학

- PDF 내용이 주인공이고 앱 chrome은 조용하고 작아야 한다.
- 키보드 우선이지만 텍스트 선택, 링크 클릭, 스크롤 같은 포인터 동작과 공존한다.
- 모든 사용자 명령은 단일 action registry를 거친다. 메뉴, palette, help, status hint를 별도로 하드코딩하지 않는다.
- 앱은 원본 PDF를 변경하지 않는다. view rotation, 검색 표시, 링크 힌트, destination indicator는 모두 일시적이다.
- 문서 이동 이력은 앱이 소유하며 PDF.js generic viewer history에 위임하지 않는다.
- 설정은 선언형 데이터뿐이다. 스크립트, shell command, macro, plugin을 추가하지 않는다.
- persistence 실패를 성공처럼 보이지 않는다. 현재 세션에만 적용됐다면 그렇게 알려야 한다.
- update check 실패는 독서를 방해하지 않는다.
- TOC는 PDF에 이미 들어 있는 outline을 읽기 전용으로 투영할 뿐 bookmark나 outline을 만들거나 저장하지 않는다.

## 명시적 비범위

- OCR
- annotation 작성·편집
- PDF form 입력·저장
- bookmark 작성·편집, thumbnail sidebar, attachment browser, outline 생성·수정
- export, Save As, 원본 덮어쓰기
- macro, script, shell command, plugin
- cloud sync, account, telemetry
- 자동/무인 업데이트
- custom titlebar
- touch 전용 제스처와 펜 주석
- Microsoft Store 패키징과 MSI는 첫 공개 릴리스 이후 별도 결정

## v0.10.0 UI 기준 이미지

아래 이미지는 immutable release commit `0f7ff0b54c3674c48f6b555261f939397cfbfb88`의 실제 AppKit view를 `1040 × 760` content size, 2× backing scale로 캡처한 구현 참고 자료다. Windows에서는 native titlebar를 사용하므로 macOS titlebar는 의도적으로 포함하지 않았다. 이미지의 macOS `⌘` 표기는 Windows 구현에서 `Ctrl`로 번역한다.

| Surface | 기준 이미지 |
|---|---|
| 앱 최초 실행 / empty state | [`ui/01-empty-state.png`](./ui/01-empty-state.png) |
| `Cmd+O` Open/Recent | [`ui/02-open-recent-cmd-o.png`](./ui/02-open-recent-cmd-o.png) |
| Theme picker | [`ui/03-theme-picker.png`](./ui/03-theme-picker.png) |
| `Shift+I` Link Indicator picker | [`ui/04-link-indicator-picker-shift-i.png`](./ui/04-link-indicator-picker-shift-i.png) |
| pane-local TOC | [`ui/05-toc-overlay.png`](./ui/05-toc-overlay.png) |
| Search prompt | [`ui/06-search-prompt.png`](./ui/06-search-prompt.png) |
| Go to page prompt | [`ui/07-goto-page-prompt.png`](./ui/07-goto-page-prompt.png) |

색상·간격·정보 밀도와 overlay 위치의 기준이지 macOS window decoration을 복제하라는 뜻은 아니다.

## 완료 정의

기능은 수동으로 한 번 동작했다는 이유만으로 완료되지 않는다. 다음을 모두 만족해야 한다.

- 해당 기능의 pure unit test가 있다.
- UI가 있으면 component test가 있다.
- PDF 동작이면 고정 fixture를 사용한 Windows E2E가 최소 하나 있다.
- 관련 과거 PR의 회귀 조건을 테스트 이름 또는 주석으로 추적한다.
- Windows 차이가 feature parity matrix에 기록돼 있다.
- 원본 PDF의 SHA-256이 동작 전후 동일하다.
- `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`, TypeScript lint/typecheck/unit test, `git diff --check`가 통과한다.
- 공개 릴리스는 clean Windows VM에서 설치, Open With, 인쇄, 제거, 업데이트 안내를 확인한다.

구현 순서는 [단계별 구현 계획](./implementation-phases.md)을 바꾸지 않는다. 특히 PDF transport/geometry/print feasibility spike가 실패한 상태에서 기능 구현을 계속 확장하지 않는다.
