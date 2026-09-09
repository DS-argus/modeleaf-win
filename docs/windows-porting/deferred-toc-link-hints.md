# Deferred embedded TOC and keyboard link hints

## Owner decision and current status

On 2026-09-09 the owner requested removing embedded TOC and the `f` keyboard-link feature from the active product, stabilizing basic reading first, and retaining implementation references for later redevelopment. The report mentions `1740_TaiwanVQA…` for TOC and no useful response from `f`. This is owner-reported behavior, not an independent diagnosis of the PDF's embedded outline or annotations.

At this document's creation, removal is requested but not yet complete. Whether ordinary mouse link activation is retained is a separate scope decision; do not silently conflate it with keyboard hint removal. Browse-border and Recent-path corrections remain in scope. Path shortcuts `y`, `yy`, and `of` remain deferred in Issue #55.

## Immutable implementation backup

The complete prior implementation is retained in Git at **`7e00424d30c5ffeab5a846d087236371644af53a`** ([browse source](https://github.com/DS-argus/modeleaf-win/tree/7e00424d30c5ffeab5a846d087236371644af53a)). It contains the verified reader follow-up from `ac2efd75ab0f010f3cb42ee44d40522b70d59867`; the later commit changes evidence wording only.

Inspect any saved file without restoring it into the active product:

```text
git show 7e00424d30c5ffeab5a846d087236371644af53a:src/main.ts
git show 7e00424d30c5ffeab5a846d087236371644af53a:src/pdf/PdfContentController.ts
```

Do not retain dormant copies, hidden feature switches, compatibility aliases, or callable dead commands as a substitute for removal. Do not commit the owner's PDFs.

### TOC reference map

- `src/domain/outlines/OutlineModel.ts`, `OutlineSelector.ts`: immutable rows, numeric selectors, hierarchy/current-row rules.
- `src/pdf/PdfOutlineAdapter.ts`, `PdfOutlineProbe.ts`: PDF.js outline and destination adaptation.
- `src/ui/reader/TocController.ts`, `TocWidgetModel.ts`, `TocWidgetView.ts`: lifetime, buffered numeric input, floating widget.
- `src/main.ts`: tab ownership, lazy outline loading, TOC key dispatch and row activation.
- `src/pdf/PdfTabSession.ts`, `PdfReaderController.ts`: document lifetime, outline resolution, guarded navigation and history.
- Tests at the saved commit: `tests/unit/domain/OutlineModel.test.ts`, `OutlineSelector.test.ts`; `tests/unit/pdf/PdfOutlineAdapter.test.ts`; `tests/unit/ui/TocController.test.ts`, `TocWidgetModel.test.ts`, `TocWidgetView.test.ts`, `TocThemeContrast.test.ts`; `tests/integration/tocOutlineFixture.test.ts`, `pdfOutlineProbe.test.ts`.

### Keyboard-link reference map

- `src/domain/links/LinkHints.ts`: label allocation, merging and hint state.
- `src/pdf/PdfContentController.ts`: annotation ownership, hint publication, activation and destination settlement; some mechanisms are shared with ordinary link clicks.
- `src/main.ts`, `src/platform/RootKeyboardRouter.ts`, `src/domain/actions/ActionRegistry.ts`, `DefaultBindings.ts`: action/context/input integration.
- `src/styles/app.css`: link hit targets and hint presentation.
- Tests at the saved commit: `tests/unit/domain/LinkHints.test.ts`, `tests/contract/linkHintReliabilityContract.test.ts`, and relevant `tests/integration/pdfContentController.test.ts` cases.
- Rust external-link authorization, session identities, generation checks, read-only handles and bounded cleanup are security foundations, not synonymous with keyboard hint UI. Preserve any foundation still used by retained behavior.

## Redevelopment acceptance, not current completion claims

The immutable macOS behavior remains at `0f7ff0b54c3674c48f6b555261f939397cfbfb88`; see feature-spec §§7–8 and the superseding PR references in pr-history. Old passing unit counts are not proof of current native usability.

Before reintroduction:

1. Confirm embedded outline/annotation availability in the actual test PDF. A printed contents page or painted URL alone does not establish either structure; do not add OCR or inferred outlines.
2. Establish working end-to-end behavior on the basic reader before expanding UI or state machinery.
3. For `t` on a confirmed outline-free PDF, provide noticeable accessible status feedback, not a false empty result for extraction failure. This feedback was separately requested and deferred by the owner.
4. Test actual packaged WebView2 input, focus, selected tab, visible viewport, destination landing, cancellation and repeated activation.
5. Prove stale document callbacks cannot publish, ordinary navigation remains intact, resources settle, and source PDFs remain byte-identical.
6. Reintroduce registry/default/config/menu/palette/help projections and native authority contracts together, without activating retired aliases.
