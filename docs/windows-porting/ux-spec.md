# Windows UX 명세

> Issue #53 owner-approved Windows UX는 ordinary internal/external PDF clicks와 native authorization을 유지하고 embedded TOC, `f` keyboard hints와 destination indicator/settings를 제외한다. finite `XYZ` point는 document edge가 허용하는 범위에서 viewport 중앙을 목표로 하며, visible landing pages를 bounded materialization한 뒤에만 canonical actual landing을 성공/history로 commit한다. `Fit`/`FitB` page-fit과 `FitR` rectangle-fit은 유지한다. Current registry는 49 actions(45 configurable + 4 fixed)이며 `t`/`J`/`K`/`f`/`I`는 미할당이다.

## 1. 디자인 방향

Modeleaf는 “일반적인 Windows PDF suite”가 아니라 문서를 중심에 둔 keyboard-first 읽기 도구다.

- tone: 조용한 power tool
- priority: PDF content > navigation feedback > chrome
- interaction: Vim-like keys + standard Windows application shortcuts
- visual identity: 현재 7개 theme와 compact status/tab chrome 유지
- platform adaptation: Windows의 titlebar, snap, system menu, Narrator, high contrast를 존중

custom titlebar는 첫 릴리스 범위에서 제외한다. native titlebar 아래에 app tab strip을 둔다. macOS의 transparent titlebar와 78px traffic-light inset을 옮기면 caption button, snap layout, resize, 접근성 문제가 생긴다.

## 2. 고정 layout metric

| Surface | 값 |
|---|---:|
| 초기 content size | `1040 × 760` |
| 최소 window size | `480 × 360` |
| tab bar height | `34px` |
| tab height | `26px` |
| status bar height | `26px` |
| 최소 pane thickness | `160px` |
| regular tab width | `184px` |
| compact inactive tab | `40px` |
| compact active tab minimum | `120px` |
| active PDF focus ring | `1px` |
| prompt preferred / max / min width | `480 / 520 / 360px` |
| retired TOC / indicator geometry | TOC `max 300 / 20 / 24px`와 indicator capture는 재개발 reference에만 보존; current Windows surface 없음 |
| prompt height | `42px` |

근거는 [`WindowVisualMetrics.swift`](../../PDFReaderApp/Window/WindowVisualMetrics.swift), [`TabBarView.swift`](../../PDFReaderApp/Window/TabBarView.swift)다.

기본 root layout:

```text
┌─ native Windows titlebar ───────────────────────────────┐
├─ root tab bar, or pane-owned tab bars in split mode ───┤
│                                                        │
│ PDF / empty state / panes                              │
│ overlays are positioned inside this content region     │
│                                                        │
├─ status bar: help · page · zoom · modes · diagnostics ─┤
└────────────────────────────────────────────────────────┘
```

CSS root는 `grid-template-rows: auto minmax(0, 1fr) 26px`를 기준으로 한다. PDF content와 pane containers에는 `min-width: 0`, `min-height: 0`을 명시해 overflow가 split sizing을 깨지 않게 한다.

## 3. Empty state

- PDF가 하나도 없을 때 content 중앙에 `Open PDF` action pill 하나를 보인다.
- shortcut badge는 Windows active keymap에서 파생하며 기본값은 `Ctrl+Shift+O`다 (Issue #53 owner amendment).
- Tab으로 focus 가능하고 Enter/Space/click이 모두 `document.open`을 dispatch한다.
- 별도 recent cards, onboarding carousel, 광고성 문구를 추가하지 않는다.
- config/update diagnostic이 있으면 status bar에서만 표시한다.

기준 이미지: [`ui/01-empty-state.png`](./ui/01-empty-state.png).

Acceptance:

- no-document 상태에서도 Open, New Window, Close Window(`app.quit`), Write/Reset Config 같은 global action은 palette/menu에서 규칙대로 보인다.
- Tab focus가 Open PDF에 도달하고 Narrator가 이름과 shortcut을 읽는다.

## 4. Tab bar

### Single pane

- root tab bar 한 개를 보인다.
- active tab은 title과 position을 보이고 selected state를 갖는다.
- inactive close button은 hover/focus에서 강해지고 active tab close는 항상 발견 가능해야 한다.
- active tab이 overflow 밖이면 layout 후 scroll into view한다.
- Regular tab slot은 파일명 길이와 관계없이 `184px × 26px`로 통일한다. 긴 이름은 ellipsis로 줄이고 accessible name/tooltip에는 전체 filename을 유지한다. 좁은 창은 수평 overflow를 사용하며 close button은 줄어들지 않는다.

### Multi-pane

- root tab bar를 숨기고 각 pane 상단에 자신의 tab bar를 둔다.
- tab click은 먼저 pane을 active로 만들고 그 다음 tab을 activate한다.
- compact mode에서 inactive tab은 40px slot, active tab은 최소 120px다.
- tab title은 filename을 사용하고 전체 path는 accessible description/tooltip에 둔다.

Windows 차이:

- plus button은 accessible name `Open PDF in New Tab`을 갖는다.
- macOS first-mouse 개념은 없지만 inactive window/pane click에서 click target을 잃지 않도록 event order를 테스트한다.
- `Ctrl+1..9`, `Ctrl+W` 표기를 쓴다.

## 5. Panes와 divider

- 1, 2, 3, 4 pane binary topology를 지원한다.
- split right는 side-by-side, split down은 stacked다.
- divider는 얇고 draggable이며 collapse되지 않는다.
- 양쪽 최소 thickness 160px를 보장한다.
- 4 panes에서 split action은 disabled reason을 제공한다.
- active pane 표시는 selected tab과 PDF canvas 1px focus ring으로 충분해야 한다. 두꺼운 전체 border는 쓰지 않는다.
- nested layout의 accessible label은 `Left`, `Right`, `Top`, `Bottom`, `Top Left`처럼 위치를 설명한다.
- divider는 separator role과 orientation, value/min/max를 노출하고 keyboard 이동을 지원한다.

Layout 변경, window resize, raw user scroll 또는 newer navigation은 in-flight point-destination transaction을 supersede하며 stale success/history publication을 허용하지 않는다.

## 6. PDF surface

- page background, 12px page break 느낌, shadow를 유지한다.
- PDF pixel layer에 theme filter/blend/invert를 적용하지 않는다.
- point destination은 가능한 viewport 중앙에 보이고 document edge에서는 실제 bounds로 clamp한다.
- internal-link success 시점에는 별도 scroll 없이 결과 viewport와 교차하는 page raster/text가 bounded resident policy 안에서 준비돼 있어야 한다.
- destination indicator나 keyboard link-hint overlay를 표시하지 않는다.
- text selection은 native cursor와 selection UX를 사용한다.
- annotation link 위에서는 pointer cursor를 보인다.
- ordinary annotation hit target은 app-authored idle border, background, shadow를 추가하지 않고 hover는 pointer cursor로만 알린다.
- PDF border metadata가 없거나 width 0이면 transparent 상태를 유지한다. 현재 canvas annotation rendering이 disabled인 동안 positive source-authored border metadata는 overlay가 소유하며 canvas와 overlay가 중복해서 그리지 않는다.
- annotation link의 keyboard focus는 idle presentation을 바꾸지 않는 theme focus outline을 사용한다. forced colors에서도 idle target box는 나타나지 않고 system `Highlight` color로 focus를 표시한다.
- context menu는 선택이 있으면 Copy만, 없으면 빈 allowlist를 보인다.
- PDF surface가 keyboard focus를 가지면 1px theme focus indicator를 보인다.
- inactive pane PDF surface에는 focus ring이 없다.

HiDPI acceptance:

- 100/125/150/200%에서 canvas는 선명하다.
- text selection, annotation hit box와 search highlight가 같은 위치를 가리킨다.
- 다른 DPI monitor로 window를 이동한 후에도 다음 render generation에서 모두 재계산된다.
- finite `XYZ` point의 attainable midpoint와 document-edge clamp는 rotation/DPI 변경 뒤에도 canonical actual landing으로 계산된다.

## 7. Status bar

높이는 26px다.

왼쪽에서 오른쪽 권장 순서:

1. `? help`
2. page `current / total`
3. zoom `%`
4. `FIT PAGE` 또는 `SEARCH` mode pill
5. pending prefix
6. flexible spacer
7. update banner
8. config/state diagnostic
9. app version

규칙:

- 현재 active window/pane/tab의 projection만 보여준다.
- diagnostic은 normal/error state와 상세 accessible description을 가진다.
- update banner click과 `U`는 같은 `update.show` action을 실행한다.
- Homebrew 문구는 Windows status/overlay에 나타나지 않는다.
- status bar의 clickable items는 button semantics와 visible focus를 갖는다.

## 8. Overlay 공통 계약

Transient overlay 종류:

- command palette
- recent/open picker
- page prompt
- search prompt/results mode
- help
- theme picker
- update instructions

공통 규칙:

1. 한 시점에 한 overlay가 keyboard routing owner다.
2. help/update가 prompt 위에 열릴 수는 있지만 prompt는 suspended 상태로 남고 닫힌 뒤 정확히 복원된다.
3. Esc는 current overlay를 닫고 이전 valid focus target으로 돌아간다.
4. modal 동안 history/viewer keys는 consume하되 viewer에 dispatch하지 않는다.
5. overlay가 close된 tab/pane을 return target으로 기억했다면 active PDF 또는 empty-state로 fallback한다.
6. overlay는 content bounds 안에 있고 최소 창에서도 핵심 controls가 scroll/focus 가능하다.

Issue #79 owner-approved delta: `.prompt`/search는 inactive-tab, `.mac-overlay`는 active-tab의 **85% background alpha**를 사용한다. 부모 opacity나 전역 theme token을 바꾸지 않는다. 기존 base color, backdrop(일반 44% dimming/search transparent), normal-color blur/shadow, 위치와 크기는 유지한다. 내부 help card와 chooser input 배경도 유지한다.

초기 후보는 기존 글자색으로 대비 기준을 통과하지 못했으나, owner가 오버레이 내부 foreground 보정을 승인했다. 로컬 `--overlay-*` 색은 dark theme에서 white, Catppuccin Latte에서 black 방향으로 혼합한다. primary text는 foreground 40%, secondary/placeholder는 foreground 70%, accent text는 accent 25%, focus는 focus-indicator 40%를 유지하고 나머지를 해당 끝색으로 채운다. 모든 글자는 불투명하며 placeholder opacity는 1이다. 선택/hover/focus한 palette shortcut은 row의 보정된 글자색을 따른다. 선택행 marker와 keyboard focus는 보정된 focus color를 사용한다. 공통 palette/config/state schema는 변경하지 않는다.

7개 theme와 6개 표면의 브라우저 computed-color 합성 비교에서 0.90/0.85/0.80 최소 작은 글자 대비는 각각 4.80/4.58/4.31:1이다. 따라서 0.85를 채택하고 0.80은 거부한다. 0.85의 focus 비교 최소값은 4.35:1이다. Forced colors는 불투명 Canvas/CanvasText, 선택행은 Highlight/HighlightText, focus는 Highlight를 사용하며 panel blur/shadow를 제거한다. 이 수치는 native DPI/text-scale 인증이 아니며 새 투명도 preview는 owner 검토 대상이다.
구현은 DOM focus 호출 모음이 아니라 다음 state를 갖는 reducer로 한다.

```ts
type OverlayState = {
  active: OverlayKind | null;
  suspendedPrompt: PromptState | null;
  returnTarget: FocusTarget;
};
```

TOC, keyboard link hint와 destination indicator는 current overlay-owner graph에 포함하지 않는다. 퇴역 surface의 hidden focus owner나 Escape handler를 남기지 않는다.

## 9. Command palette

- content top에서 72px, centered
- width 360px
- 최대 12 visible rows
- query input + result list
- `Ctrl+J/K`, Up/Down, Enter, Esc
- enabled result가 먼저, disabled result도 이유와 함께 유지
- action availability가 tab/pane/document 변화에 따라 즉시 갱신
- row label, active binding, disabled reason을 Narrator가 읽을 수 있어야 함

Palette 자체가 독자 action list를 가지면 안 된다. action registry descriptor, live keymap, current availability를 projection한다.

## 10. Recent/Open picker

- content top에서 72px, centered
- 첫 frame부터 첫 row `Browse…`와 startup에 준비된 recents 최대 15개를 native 순서로 표시한다. loading/false-empty frame은 없다.
- Issue #53 owner amendment: Browse 앞 glyph와 희미한 버튼 테두리를 제거하되 keyboard focus outline은 유지한다. Recent heading이 있을 때만 그 위에 theme/forced-colors를 따르는 구분선을 표시한다.
- 정상 창에서는 15개가 모두 보이되 작은 창에서는 내부 scroll한다.
- Issue #53 owner amendment: renderer는 opaque `recentId`, `displayName`, 표시 전용 전체 `displayPath`를 받는다. 경로가 넘치면 디렉터리 가운데를 줄이고 파일명은 항상 전부 표시한다. 필요하면 행 글꼴을 축소한다. 전체 경로는 accessible name/title로도 유지하며 열기 권한은 경로가 아니라 `recentId`로만 전달한다.
- query는 Unicode NFC filename fuzzy search이며 입력 자체가 refresh trigger가 아니다.
- `Ctrl+Shift+C` clear history, arrows/`Ctrl+J/K`, Enter, Esc를 지원한다.
- Browse는 app chooser overlay를 먼저 닫은 뒤 HWND-owned Windows dialog를 연다. native dialog는 app overlay owner에 포함하지 않는다.
- missing entry는 durable prune 성공 후에만 row를 제거한다. stale selection은 최신 snapshot으로 갱신하고 chooser/focus를 유지한다.
- permission/locked/network/state/persistence error는 typed inline error로 남기며 prune하거나 `Could not read this PDF`로 오진하지 않는다.
기준 이미지: [`ui/02-open-recent-cmd-o.png`](./ui/02-open-recent-cmd-o.png).

## 11. Page/Search prompt

- bottom centered, content bottom에서 16px
- preferred 480px, max 520px, min 360px, height 42px
- page prompt label `go to page`, search prefix `/`
- Enter commit/next, Shift+Enter previous, Esc cancel/clear의 fixed lifecycle 계약
- validation/error line은 layout jump가 최소가 되게 reserve하거나 안정적으로 expand
- IME composition 중 Enter가 후보 확정인지 prompt commit인지 구분한다. composing이면 action commit을 실행하지 않는다.

Issue #79 Windows search presentation: form은 `align-items: center`로 `/`, input content box와 footer text를 중앙 정렬한다. 480px 이하에서는 기존 footer 다음 행 배치를 유지한다. 폰트, line-height, input appearance, markup, IME/Enter/Escape/focus lifecycle은 변경하지 않는다. Forced colors에서는 search footer의 `kbd`도 직접 `CanvasText`를 사용한다.
기준 이미지: [`ui/06-search-prompt.png`](./ui/06-search-prompt.png), [`ui/07-goto-page-prompt.png`](./ui/07-goto-page-prompt.png).

## 12. Theme picker

- centered, width 300px
- 7개 built-in theme를 source order로 표시
- row move/hover는 preview
- Enter/click은 commit + persist
- Esc는 picker open 전 theme로 rollback
- persistence 실패면 현재 theme는 유지하고 session-only diagnostic을 표시

Theme token은 다음 12개를 그대로 사용한다.

```text
background foreground muted-text border accent active-tab inactive-tab
statusline error search-highlight active-search-highlight focus-indicator
```

UI font는 `Segoe UI Variable`, fallback `Segoe UI`, key/status token은 `Cascadia Mono` 또는 `ui-monospace`를 사용한다. 색 값은 [`BuiltInThemes.swift`](../../PDFReaderCore/Theme/BuiltInThemes.swift)의 exact palette를 복제한다.

기준 이미지: [`ui/03-theme-picker.png`](./ui/03-theme-picker.png).

## 13. Retired Link indicator picker (재개발 reference)

> Issue #53 owner amendment로 picker/action/default `I`, settings model, preview UI와 native state API를 current Windows 제품에서 제거한다. 기존 user config/state를 자동 rewrite하거나 저장된 indicator JSON을 삭제하지 않으며, unknown state sibling으로만 보존한다.

아래 macOS baseline UX는 current acceptance가 아니다: style/color/size/duration preview, `#RRGGBB` validation, commit/cancel rollback과 `ui/04-link-indicator-picker-shift-i.png`. 마지막 Windows implementation/tests는 `dedcff8513e034efb904ef7d50fd59cc11444798`의 [deferred reference](./deferred-toc-link-hints.md)에 보존한다.

## 14. Help

- centered bounded overlay
- preferred width 840px
- list max height 520px
- available width에 따라 1/2/3 columns
- rows는 live registry categories와 active bindings에서 생성
- Windows notation만 표시: `Ctrl`, `Alt`, `Shift`; `Cmd`/`⌘` 금지
- tab selection row는 `Ctrl+1..9`로 collapse 가능
- `?`는 navigation context에서 열고 Esc로 닫는다.

## 15. Ordinary links; retired hints and destination indicator

> Issue #53: ordinary PDF annotation clicks와 native authorization은 유지한다. `f` link hints와 destination indicator는 current Windows UI가 아니며 `f`/`I`를 routing하지 않는다.

- internal `XYZ` link의 finite 축은 rotation-aware viewport midpoint를 목표로 하고 unspecified axis는 기존 canonical 축을 보존한다. 실제 scroll은 document edge에서 clamp한다.
- `Fit`/`FitB`는 page-fit, `FitR`은 rectangle-fit placement를 유지한다.
- destination scroll settlement 뒤 결과 viewport와 교차하는 page들을 existing resident/resource bound 안에서 materialize한 후에만 success/history를 commit한다.
- edge clamp 뒤 actual landing이 history authority이고 newer navigation, lifecycle change 또는 raw user scroll은 stale landing work를 fence한다.
- failed/cancelled landing은 history나 newer input을 덮지 않으며 manual/synthetic scroll, detached repair 또는 unbounded residency로 보정하지 않는다.
- destination indicator, hint labels/overlay, settings picker, timer와 indicator-specific focus/Escape behavior는 없어야 한다. Search highlight와 focus ring은 그대로 유지한다.

macOS hint/indicator UX와 captures는 current support가 아니라 [deferred redevelopment reference](./deferred-toc-link-hints.md)다. 마지막 Windows source/tests는 hints `7e00424d30c5ffeab5a846d087236371644af53a`, indicator `dedcff8513e034efb904ef7d50fd59cc11444798`에서 조회한다.

## 16. Embedded outline TOC

> Issue #53: 현재 Windows UI에는 TOC를 제공하지 않는다. 이 절의 macOS 계약과 captures는 향후 재개발 참고용으로만 보존하며 `t`/`J`/`K`를 라우팅하지 않는다.

TOC는 sidebar가 아니라 각 pane content 안의 floating, non-focus overlay다. PDF canvas 크기를 바꾸지 않는다.

- owning pane의 top-right에서 `12px` inset, maximum width `300px`; actual width `min(300px, owning pane width - 24px)`
- header 없음; `20px` rows와 `24px` footer
- content height 또는 pane 높이의 50% 중 작은 값, whole-row 단위
- selector는 right-aligned, 1px divider, title은 left-aligned; second depth만 6px indent
- current/exact row는 2px accent marker와 selected accessibility value로 표시
- invalid destination은 hierarchy에 남지만 dimmed/disabled, selector 없음
- empty outline은 `No table of contents`; thumbnail/bookmark/attachment/outline-generation UI를 대신 열지 않음
- footer는 live Windows bindings를 투영해 기본 `J / K  Scroll    #  Jump    Esc / t  Close`
- bare 숫자는 footer에 즉시 보이고 마지막 입력 400ms 뒤 valid selector 하나를 atomic commit; invalid selector는 silent
- `J/K`는 한 row씩 scroll한다. Backspace는 마지막 digit을 지우고 400ms deadline을 갱신하며, `Esc` 또는 `t`는 close + pending buffer cancel
- active pane의 TOC만 numeric/scroll/Esc 입력을 받고 다른 pane으로 fallback하지 않음
- overlay 자체는 reader focus를 빼앗지 않지만 enabled rows는 pointer와 Narrator press를 지원
- prompt/help/theme/indicator/recent/palette가 열리거나 config reload, focus loss, tab/pane close가 발생하면 pending numeric input 취소
- user가 list를 scroll한 뒤 ordinary rerender는 위치를 유지하고 verified reader movement만 tracked row를 minimally reveal

Windows에서는 PDF.js `getOutline()`을 사용하지만 generic viewer sidebar DOM/CSS를 가져오지 않는다. semantic list와 button rows를 Modeleaf theme/token으로 직접 만든다. reference: [`ui/05-toc-overlay.png`](./ui/05-toc-overlay.png).

Stable IDs:

```text
tocWidget
tocWidget.empty
tocWidget.hint
tocWidget.row.<structural-path>
tocWidget.row.<structural-path>.selector
tocWidget.row.<structural-path>.separator
tocWidget.row.<structural-path>.title
```

Accessibility acceptance:

- enabled row는 button role, `Section <selector>, <title>` name, selected value를 노출하고 invoke 가능하다.
- disabled row는 비활성 group/row semantics이며 click, first-mouse equivalent, invoke를 거부한다.
- Dracula와 Solarized Dark에서 selector와 second-depth title contrast ratio가 최소 4.0이다.
- 200% text scaling과 최소 pane에서도 footer와 최소 한 row가 잘리지 않는다.

## 17. Windows accessibility

semantic HTML을 먼저 쓰고 ARIA는 native semantics로 표현할 수 없을 때만 보완한다.

안정적인 test IDs/landmarks:

```text
mainWindow
readerRoot
tabBar
pane.<id>
statusBar
pdfCanvas
pdfDocumentView
commandPaletteOverlay
recentFilesOpenOverlay
promptOverlay
helpOverlay
themePickerOverlay
```

Retired `indicatorPickerOverlay`, `linkHintOverlay`와 `tocWidget` ID는 current DOM/accessibility tree에 존재하지 않아야 한다.

필수 수동 검사:

- Narrator가 active window/pane/tab, page, zoom, mode, diagnostic을 읽는다.
- Tab/Shift+Tab 순서가 예측 가능하고 focus trap에서 빠져나오지 않는다.
- keyboard만으로 Open, search, scroll/fit, history와 print를 실행할 수 있다. Ordinary annotation link target은 pointer와 applicable accessible activation semantics를 유지한다.
- Windows high contrast/forced colors에서 text, selected row, focus ring이 보인다.
- 200% text scaling에서 overlay action이 잘리지 않는다.

공식 참고:

- [Windows typography](https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/typography)
- [Keyboard accessibility](https://learn.microsoft.com/en-us/windows/apps/design/accessibility/keyboard-accessibility)
- [Accessibility overview](https://learn.microsoft.com/en-us/windows/apps/design/accessibility/accessibility-overview)
- [Accessibility testing](https://learn.microsoft.com/en-us/windows/apps/design/accessibility/accessibility-testing)

## 18. UX 출시 차단 조건

- custom titlebar 때문에 snap/system menu/resize/Narrator가 깨짐
- prompt에서 IME 또는 AltGraph가 reader action으로 새어 나감
- overlay close 후 focus가 body 또는 닫힌 pane으로 감
- DPI 변경 후 link/search layer가 1 CSS px 이상 어긋남
- split 최소 크기에서 tab/status/prompt 핵심 action이 접근 불가능
- high contrast에서 focus/selected/error 상태를 구분할 수 없음
- point link가 attainable viewport center/document-edge clamp를 지키지 않거나 visible landing pages가 준비되기 전에 success를 보고함
- retired TOC/hint/indicator action, overlay, style, timer 또는 accessible landmark가 current UI에 다시 나타남
