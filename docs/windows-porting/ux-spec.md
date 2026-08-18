# Windows UX 명세

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
| TOC width / row / footer | `max 300 / 20 / 24px`; 실제 width는 `min(300px, pane width - 24px)`; 높이는 owning pane의 최대 50% |
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
- shortcut badge는 Windows active keymap의 `Ctrl+O`를 표시한다.
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

Layout 변경, divider drag, window resize가 시작되면 link hint와 destination indicator를 즉시 dismiss한다.

## 6. PDF surface

- page background, 12px page break 느낌, shadow를 유지한다.
- PDF pixel layer에 theme filter/blend/invert를 적용하지 않는다.
- text selection은 native cursor와 selection UX를 사용한다.
- annotation link 위에서는 pointer cursor를 보인다.
- context menu는 선택이 있으면 Copy만, 없으면 빈 allowlist를 보인다.
- PDF surface가 keyboard focus를 가지면 1px theme focus indicator를 보인다.
- inactive pane PDF surface에는 focus ring이 없다.

HiDPI acceptance:

- 100/125/150/200%에서 canvas는 선명하다.
- text selection, annotation hit box, search highlight, hint label, indicator가 같은 위치를 가리킨다.
- 다른 DPI monitor로 window를 이동한 후에도 다음 render generation에서 모두 재계산된다.

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
- link indicator picker
- update instructions
- link hint overlay

공통 규칙:

1. 한 시점에 한 overlay가 keyboard routing owner다.
2. help/update가 prompt 위에 열릴 수는 있지만 prompt는 suspended 상태로 남고 닫힌 뒤 정확히 복원된다.
3. Esc는 current overlay를 닫고 이전 valid focus target으로 돌아간다.
4. modal 동안 history/viewer keys는 consume하되 viewer에 dispatch하지 않는다.
5. overlay가 close된 tab/pane을 return target으로 기억했다면 active PDF 또는 empty-state로 fallback한다.
6. overlay는 content bounds 안에 있고 최소 창에서도 핵심 controls가 scroll/focus 가능하다.

구현은 DOM focus 호출 모음이 아니라 다음 state를 갖는 reducer로 한다.

```ts
type OverlayState = {
  active: OverlayKind | null;
  suspendedPrompt: PromptState | null;
  returnTarget: FocusTarget;
};
```

TOC는 이 modal owner stack과 별개인 non-focus pane overlay다. modal을 열 때 TOC의 pending numeric input은 취소하지만 TOC visibility는 owning pane state로 유지한다.

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
- 첫 row `Browse…`
- 이후 recents 최대 15개
- 정상 창에서는 15개가 모두 보이되 작은 창에서는 내부 scroll
- filename이 primary, path가 secondary
- query는 Unicode filename fuzzy search
- `Ctrl+C` clear, arrows/`Ctrl+J/K`, Enter, Esc
- missing entry open 실패는 inline error 후 해당 entry만 prune
- permission/locked/network error는 inline error지만 prune하지 않음

기준 이미지: [`ui/02-open-recent-cmd-o.png`](./ui/02-open-recent-cmd-o.png).

## 11. Page/Search prompt

- bottom centered, content bottom에서 16px
- preferred 480px, max 520px, min 360px, height 42px
- page prompt label `go to page`, search prefix `/`
- Enter commit/next, Shift+Enter previous, Esc cancel/clear의 fixed lifecycle 계약
- validation/error line은 layout jump가 최소가 되게 reserve하거나 안정적으로 expand
- IME composition 중 Enter가 후보 확정인지 prompt commit인지 구분한다. composing이면 action commit을 실행하지 않는다.

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

## 13. Link indicator picker

- style, color, size, duration을 preview/commit/cancel model로 편집한다.
- slider/input은 accessible label, current value, min/max를 노출한다.
- custom hex는 `#RRGGBB`만 허용한다.
- preview는 PDF 목적지로 실제 이동하지 않고 picker 안의 sample 또는 현재 safe viewport에만 그린다.
- Esc는 모든 settings를 open 전 값으로 rollback한다.

기준 이미지: [`ui/04-link-indicator-picker-shift-i.png`](./ui/04-link-indicator-picker-shift-i.png).

## 14. Help

- centered bounded overlay
- preferred width 840px
- list max height 520px
- available width에 따라 1/2/3 columns
- rows는 live registry categories와 active bindings에서 생성
- Windows notation만 표시: `Ctrl`, `Alt`, `Shift`; `Cmd`/`⌘` 금지
- tab selection row는 `Ctrl+1..9`로 collapse 가능
- `?`는 navigation context에서 열고 Esc로 닫는다.

## 15. Link hints와 destination indicator

- PDF surface 위 transparent overlay다.
- visible annotation links만 labels를 갖는다.
- lower-case ASCII label을 사용하고 matching prefix는 강조, non-match는 dim한다.
- plain/Shift/Caps ASCII letter는 lowercase label 입력으로 normalize한다. Ctrl/Alt/Meta/AltGraph, IME/composition, keyCode 229, dead/process/unidentified, non-letter input은 받지 않는다.
- exact duplicate가 아닌 rectangles는 겹쳐 보여도 별도 labels다.
- scroll/wheel/pinch/zoom/rotate/resize/divider drag/tab/pane switch에서 dismiss한다.
- destination indicator는 successful point GoTo에만 보이고 timeout 후 사라진다.
- high contrast theme에서도 outline이 식별 가능해야 한다.

## 16. Embedded outline TOC

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
indicatorPickerOverlay
linkHintOverlay
tocWidget
```

필수 수동 검사:

- Narrator가 active window/pane/tab, page, zoom, mode, diagnostic을 읽는다.
- Tab/Shift+Tab 순서가 예측 가능하고 focus trap에서 빠져나오지 않는다.
- keyboard만으로 Open, search, link hint, TOC toggle/scroll/numeric jump, split/focus/unsplit, print가 가능하다.
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
- inactive pane가 numeric/`J`/`K`/`Esc`를 받거나 TOC가 PDF canvas 아래로 내려감
