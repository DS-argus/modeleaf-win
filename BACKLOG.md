# Modeleaf Backlog

Source: `검토.md` review, audited against the current Windows implementation on 2026-08-04.

## P0 — Directly implementable

- [x] **Hide the release console window**
  - Add the Windows GUI subsystem attribute for non-debug builds.
  - Debug/dev runs may retain a console for diagnostics; release EXE must open only the app window.

- [x] **Simplify and center the empty state**
  - Center a minimal `Ctrl+O로 PDF 열기` affordance in both axes.
  - Preserve keyboard and screen-reader accessibility.

- [x] **Remove redundant in-app branding chrome**
  - Remove the in-app top-left `Modeleaf` heading and `Windows foundation` label.
  - Remove the visible `Theme` button while retaining keyboard/palette access to themes.

- [x] **Repair theme-picker keyboard behavior**
  - Keep `T` and command-palette access.
  - Arrow keys and `Ctrl+J`/`Ctrl+K` preview; Enter commits and closes; Escape restores the prior durable theme and closes; reopening focuses the durable theme.

- [x] **Continue vertical scrolling across page boundaries**
  - `j`/`d` at the bottom navigate to the next page and continue from its top.
  - `k`/`u` at the top navigate to the previous page and continue from its bottom.
  - Preserve bounded render ownership under held/repeated keys and at first/last page.

- [x] **Restore standard keyboard and mouse PDF navigation**
  - `ArrowLeft`/`ArrowRight` move to the previous/next page; `ArrowUp`/`ArrowDown` scroll vertically.
  - Native mouse-wheel scrolling remains enabled and turns pages at the top/bottom boundary without skipping in-flight renders.
  - Disable conflicting WebView2 browser accelerator handling so application-owned `Ctrl+J`/`Ctrl+K` reaches command and theme dialogs instead of opening browser downloads.

- [ ] **Repair fit-width reapplication**
  - `w` always recomputes fit width from the current viewport after custom zoom, resize, or DPI changes.
  - Add focused regression coverage; preserve `F` fit-page behavior.

- [ ] **Replace the low-visibility goto prompt**
  - Use a compact, high-contrast prompt fixed immediately above the status bar.
  - Show entered page and page count without covering document content.
  - Preserve digit, Backspace, Enter, and Escape semantics.

- [x] **Extend and stabilize the command palette**
  - Add `:` as an opener alongside `Ctrl+Shift+P`.
  - Handle `Ctrl+J`/`Ctrl+K`, arrows, Enter, and Escape across the entire dialog rather than only the query input.
  - Keep the input at a fixed location and reserve stable result-list height when fuzzy matching returns zero items.

- [x] **Add previous/next tab shortcuts**
  - `N` activates the next tab and `P` the previous tab.
  - Define cyclic behavior at the first/last tab and preserve lowercase `n`/`p` page navigation.

- [ ] **Move search into a non-obstructive bottom prompt**
  - Share visual structure and placement with goto.
  - [x] First-pass slice complete: Escape closes search, cancels pending search ownership, clears query/results, and removes all highlights while preserving reading position.

- [x] **Improve PDF link and hint visibility**
  - Increase hint labels from 11px to a readable 13–14px.
  - Show a strong accent rectangle and underline across link annotation regions, using valid PDF annotation colors and border widths when present.
  - Preserve mouse click, keyboard activation, forced-colors, annotation-provided color/border styling, and external-link safety behavior.

- [ ] **Replace direct Ctrl+O browsing with an open palette**
  - First entry: `Browse…`, which opens the native file chooser.
  - Then show up to 15 recent files with sanitized filename and display-only path.
  - Support fuzzy filtering, arrows, `Ctrl+J`/`Ctrl+K`, Enter, and Escape.
  - Keep native opaque recent IDs as authority; do not allow a renderer-provided path to open a file.

- [ ] **Integrate the native Windows title bar visually**
  - Apply dark mode/title-bar colors through supported Windows DWM/Tauri integration.
  - Do not replace it with a custom title bar in this item.

## P1 — Needs a reference image or product decision

- [ ] **Match the `?` help UI to the macOS version**
  - Blocked on the referenced macOS screenshot or exact layout specification.
  - Preserve generated shortcut data rather than duplicating shortcut text in markup.

- [ ] **Run a cohesive macOS-inspired visual redesign**
  - Needs visual references for spacing, typography, tab treatment, prompt treatment, and desired density.
  - Covers tabs, empty state, dialogs, status line, command/open palettes, and visual hierarchy.

- [ ] **Decide the transparency material and scope**
  - Choose CSS translucency versus native Windows Mica/Acrylic.
  - Specify which surfaces may be translucent; keep PDF pixels and text legible.
  - Recommended scope is application chrome, palettes, and prompts—not the PDF page itself.

- [ ] **Decide whether to replace the native title bar completely**
  - A custom borderless title bar requires explicit approval and reference design.
  - It must reimplement drag regions, minimize/maximize/close, Snap behavior, maximized bounds, DPI handling, and keyboard/accessibility semantics.

## Confirmed existing behavior to retain

- Command-palette fuzzy matching already exists.
- Command-palette `Ctrl+J`/`Ctrl+K`, arrows, Enter, and Escape are covered by focused DOM interaction regression; final native-app feel remains in the user review checklist.
- Recent history is bounded to 15 native records and uses opaque recent IDs.
- Theme palettes and durable theme persistence already exist.
- Lowercase `n`/`p` remain PDF page navigation; uppercase `N`/`P` are reserved for tabs.
