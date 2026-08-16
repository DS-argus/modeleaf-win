# 근거 인덱스

기준 commit은 `0f7ff0b54c3674c48f6b555261f939397cfbfb88`이고 annotated tag object는 `1c95412212e3045296fbce9c3fd73b4ac5240e4c`다. line number와 mutable working tree가 아니라 이 immutable commit의 파일을 기준으로 본다.

## 1. Build와 product identity

| 근거 | 계약 |
|---|---|
| [`Package.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/Package.swift) | Swift 6.2, macOS 14 baseline, Core/App/TestSupport 구조 |
| [`PDFReaderApp/Info.plist`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Info.plist) | version 0.10.0, build 12, PDF Viewer role |
| [`ProductScopeTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/ProductScopeTests.swift) | 61 actions, viewer-only vocabulary, PDF document role |
| [v0.10.0 `ci.yml`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/.github/workflows/ci.yml) | one full `swift test`; 517 tests / 59 suites |
| [v0.10.0 `release.yml`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/.github/workflows/release.yml) | tagged full test/package/Homebrew release; Windows에서 재사용하지 않음 |

## 2. Action, key, config

| 근거 | 계약 |
|---|---|
| [`ActionID.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCore/Actions/ActionID.swift) | 61 stable IDs |
| [`ActionRegistry.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCore/Actions/ActionRegistry.swift) | title, scope, repeat, fixed binding |
| [`ActionBindingPolicy.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCore/Actions/ActionBindingPolicy.swift) | collisions/reservations |
| [`ActionSurfaceRegistry.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCore/Actions/ActionSurfaceRegistry.swift) | public surfaces sync |
| [`BuiltInDefaults.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCore/Config/BuiltInDefaults.swift) | defaults, key templates, bounds |
| [`KeyToken.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCore/Input/KeyToken.swift) | mac modifier/named key normalization |
| TOC actions | `toc.toggle`, `toc.scrollDown`, `toc.scrollUp`; defaults `t`, `J`, `K`; navigation/searchResults only |
| [`KeySequenceParser.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCore/Input/KeySequenceParser.swift) | grammar |
| [`KeySequenceEngine.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCore/Input/KeySequenceEngine.swift) | prefix/context dispatch |
| [`PromptSafeBindingPredicate.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCore/Input/PromptSafeBindingPredicate.swift) | prompt native path |
| [`ConfigValidator.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCore/Config/ConfigValidator.swift) | strict sparse overlay/full validation |
| [`ConfigService.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Config/ConfigService.swift) | launch fallback vs reload keep-last-good |
| [`ConfigFileStore.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Config/ConfigFileStore.swift) | write/reset/backup transaction |
| [`CONFIG.md`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/CONFIG.md) | user-facing schema and current mac key table |

핵심 tests:

- [`ActionRegistryTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCoreTests/ActionRegistryTests.swift)
- [`BuiltInDefaultsTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCoreTests/BuiltInDefaultsTests.swift)
- [`KeySequenceEngineTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCoreTests/KeySequenceEngineTests.swift)
- [`KeyGrammarAndPromptSafetyTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCoreTests/KeyGrammarAndPromptSafetyTests.swift)
- [`ConfigValidatorTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCoreTests/ConfigValidatorTests.swift)
- [`ConfigLoadingTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/ConfigLoadingTests.swift)
- [`ConfigReloadIntegrationTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/ConfigReloadIntegrationTests.swift)
- [`ConfigWriteResetIntegrationTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/ConfigWriteResetIntegrationTests.swift)

## 3. Open, recent, state

| 근거 | 계약 |
|---|---|
| [`PDFOpenService.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Reader/PDFOpenService.swift) | local/missing/unreadable/malformed/locked/empty outcomes |
| [`RecentFilesStore.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCore/Recent/RecentFilesStore.swift) | max 15, `.pdf`, dedupe, prune |
| [`RecentFileFilter.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCore/Recent/RecentFileFilter.swift) | filename fuzzy filter |
| [`StateFileStore.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCore/Recent/StateFileStore.swift) | owned fields, unknown retention, field isolation, transaction |
| [`RecentFilesOpenOverlayView.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Window/RecentFilesOpenOverlayView.swift) | Browse + 15 recents UI |

핵심 tests:

- [`PDFOpenServiceTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/PDFOpenServiceTests.swift)
- [`RecentFileFilterTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCoreTests/RecentFileFilterTests.swift)
- [`RecentFilesStoreTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCoreTests/RecentFilesStoreTests.swift)
- [`StateFileStoreTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCoreTests/StateFileStoreTests.swift)
- [`RecentFilesOverlayIntegrationTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/RecentFilesOverlayIntegrationTests.swift)

## 4. Reader, search, links, history

| 근거 | 계약 |
|---|---|
| [`ReaderPDFView.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Input/ReaderPDFView.swift) | vertical view, zoom bounds, link/copy/read-only interaction |
| [`PDFViewController.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Reader/PDFViewController.swift) | fit/zoom/rotate/print/navigation rendering |
| [`ReaderSession.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Reader/ReaderSession.swift) | app-owned transactions, status, search/history integration |
| [`ReaderSearchCoordinator.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Reader/ReaderSearchCoordinator.swift) | generation/cancel/latest/search navigation |
| [`ReaderLink.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCore/Reader/ReaderLink.swift) | link DTO/target |
| [`LinkHintMerge.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCore/Reader/LinkHintMerge.swift) | exact duplicate only |
| [`LinkHintLabels.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCore/Input/LinkHintLabels.swift) | hint labels |
| [`NavigationHistory.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCore/Reader/NavigationHistory.swift) | page-space snapshots, max 100, search epoch |
| [`LinkDestinationIndicatorSettings.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCore/Reader/LinkDestinationIndicatorSettings.swift) | styles/colors/ranges/default |

핵심 tests:

- [`ReaderSearchCoordinatorTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/ReaderSearchCoordinatorTests.swift)
- [`ReaderSearchWorkflowTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/ReaderSearchWorkflowTests.swift)
- [`NavigationHistoryTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCoreTests/NavigationHistoryTests.swift)
- [`N11NavigationRedTeamTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/N11NavigationRedTeamTests.swift)
- [`LinkHintMergeTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCoreTests/LinkHintMergeTests.swift)
- [`LinkHintIntegrationTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/LinkHintIntegrationTests.swift)
- [`LinkHintAcceptanceTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/LinkHintAcceptanceTests.swift)
- [`ReadOnlyBoundaryTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/ReadOnlyBoundaryTests.swift)
- [`PDFCapabilityPolicyTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/PDFCapabilityPolicyTests.swift)

### Embedded-outline TOC

Immutable v0.10.0 source:

- [`ReaderOutline.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Reader/ReaderOutline.swift) — preorder, structural IDs, wrapper/two-depth normalization, valid-only selectors, current-row tracking
- [`TOCWidgetView.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Window/TOCWidgetView.swift) — pane-local floating UI, max-300/20/24 metrics, numeric/J/K/Esc, themes/accessibility
- [`PDFViewController.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Reader/PDFViewController.swift) — finite/sentinel/8pt destination normalization and viewport mutation provenance
- [`ReaderSession.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Reader/ReaderSession.swift) — verified `.toc` history producer
- [`MainWindowController.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Window/MainWindowController.swift), [`ReaderRootView.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Window/ReaderRootView.swift) — strict active-pane routing, widget ownership, z-order, lifecycle cancellation

Tests:

- [`ReaderOutlineTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/ReaderOutlineTests.swift)
- [`TOCWidgetTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/TOCWidgetTests.swift)
- [`TOCNumericRoutingTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/TOCNumericRoutingTests.swift)
- [`PaneShellTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/PaneShellTests.swift), [`ReaderSessionTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/ReaderSessionTests.swift), [`ReaderWorkflowUITests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderUITests/ReaderWorkflowUITests.swift)
- [`PDFFixtureFactory.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderTestSupport/PDFFixtureFactory.swift) — nested/duplicate/invalid/edge TOC fixture

## 5. Tabs, panes, windows, UI

| 근거 | 계약 |
|---|---|
| [`TabStore.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCore/Tabs/TabStore.swift) | tab state |
| [`ReaderSessionStore.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Reader/ReaderSessionStore.swift) | session/tab presentation |
| [`PaneCoordinator.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Reader/PaneCoordinator.swift) | split/focus/unsplit transaction |
| [`ReaderDuplicationSnapshot.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Reader/ReaderDuplicationSnapshot.swift) | position-only duplicate |
| [`ApplicationController.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/App/ApplicationController.swift) | app composition/new mac process/open routing |
| [`MainWindowController.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Window/MainWindowController.swift) | input/overlay/focus orchestration |
| [`WindowVisualMetrics.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Window/WindowVisualMetrics.swift) | fixed UI metrics |
| [`ReaderRootView.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Window/ReaderRootView.swift) | root layout |
| [`TabBarView.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Window/TabBarView.swift) | regular/compact tabs |
| [`StatusBarView.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Window/StatusBarView.swift) | status projection |

핵심 tests:

- [`TabStoreTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCoreTests/TabStoreTests.swift)
- [`PaneCoordinatorTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/PaneCoordinatorTests.swift)
- [`PaneShellTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/PaneShellTests.swift)
- [`PaneRedTeamTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/PaneRedTeamTests.swift)
- [`FourPaneLiveDisplayTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/FourPaneLiveDisplayTests.swift)
- [`CommandPaletteIntegrationTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/CommandPaletteIntegrationTests.swift)
- [`HelpOverlayIntegrationTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/HelpOverlayIntegrationTests.swift)
- [`ThemePickerTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/ThemePickerTests.swift)

### UI reference captures

- [`ui/01-empty-state.png`](./ui/01-empty-state.png)
- [`ui/02-open-recent-cmd-o.png`](./ui/02-open-recent-cmd-o.png)
- [`ui/03-theme-picker.png`](./ui/03-theme-picker.png)
- [`ui/04-link-indicator-picker-shift-i.png`](./ui/04-link-indicator-picker-shift-i.png)
- [`ui/05-toc-overlay.png`](./ui/05-toc-overlay.png)
- [`ui/06-search-prompt.png`](./ui/06-search-prompt.png)
- [`ui/07-goto-page-prompt.png`](./ui/07-goto-page-prompt.png)

Captures are v0.10.0 AppKit content views at `1040 × 760`, 2× backing scale. Native macOS titlebar is excluded because the Windows contract keeps the native Windows titlebar.

## 6. Theme와 update

| 근거 | 계약 |
|---|---|
| [`Theme.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCore/Theme/Theme.swift) | 7 IDs, 12 tokens |
| [`BuiltInThemes.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCore/Theme/BuiltInThemes.swift) | exact colors |
| [`ThemeSelectionStore.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCore/Theme/ThemeSelectionStore.swift) | selected theme persistence |
| [`UpdateCheck.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderCore/Update/UpdateCheck.swift) | version comparison |
| [`UpdateChecker.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/App/UpdateChecker.swift) | launch async/silent failure |
| [`UpdateBannerTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/UpdateBannerTests.swift) | banner/action UI contract |

## 7. Performance fixture source

| 근거 | 계약 |
|---|---|
| [`PDFFixtureFactory.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderTestSupport/PDFFixtureFactory.swift) | macOS fixture generator |
| [`PerformanceFixtureContractTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/PerformanceFixtureContractTests.swift) | S/L/F/B names, page counts, sentinels |
| [`PDFOpenMetrics.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderApp/Reader/PDFOpenMetrics.swift) | open timing stages |
| [`PDFOpenMetricsTests.swift`](https://github.com/DS-argus/modeleaf/blob/0f7ff0b54c3674c48f6b555261f939397cfbfb88/PDFReaderAppTests/PDFOpenMetricsTests.swift) | metric contract |

## 8. GitHub history

- Repository: [DS-argus/modeleaf](https://github.com/DS-argus/modeleaf)
- Release baseline: [v0.10.0](https://github.com/DS-argus/modeleaf/releases/tag/v0.10.0)
- Feature issue: [#44](https://github.com/DS-argus/modeleaf/issues/44)
- TOC and release PR: [#45](https://github.com/DS-argus/modeleaf/pull/45)
- Annotated tag object: `1c95412212e3045296fbce9c3fd73b4ac5240e4c` → commit `0f7ff0b54c3674c48f6b555261f939397cfbfb88`
- Feature-grouped links: [PR 이력과 교훈](./pr-history.md)

## 9. Post-v0.10.0 verification infrastructure

아래는 app behavior baseline을 바꾸지 않는 후속 engineering evidence다.

- [PR #48](https://github.com/DS-argus/modeleaf/pull/48), merge [`0218e0a`](https://github.com/DS-argus/modeleaf/commit/0218e0a8a8a34aa8812dcd252b23290746cebd36)
- [`Tools/verify.sh`](https://github.com/DS-argus/modeleaf/blob/0218e0a8a8a34aa8812dcd252b23290746cebd36/Tools/verify.sh): focused/core/app/full/hygiene layered verification
- [sharded CI](https://github.com/DS-argus/modeleaf/blob/0218e0a8a8a34aa8812dcd252b23290746cebd36/.github/workflows/ci.yml): Core 145/17, App 372/42, project validation independent reporting and compatible caches
- [release workflow](https://github.com/DS-argus/modeleaf/blob/0218e0a8a8a34aa8812dcd252b23290746cebd36/.github/workflows/release.yml): tagged commit still runs the full fail-closed gate
- Issue [#46](https://github.com/DS-argus/modeleaf/issues/46)의 real-sleep flake를 fake clock과 explicit 399/400ms assertions로 교체했다. Windows timer tests도 wall-clock sleep을 쓰지 않는다.

이 evidence는 v0.10.0의 400ms product behavior를 바꾸지 않는다.

## 10. Tauri 공식 자료

- [Prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Architecture/start](https://v2.tauri.app/start/)
- [Calling Rust and optimized binary responses](https://v2.tauri.app/develop/calling-rust/)
- [Capabilities](https://v2.tauri.app/security/capabilities/)
- [Content Security Policy](https://v2.tauri.app/security/csp/)
- [Dialog plugin](https://v2.tauri.app/plugin/dialog/)
- [Opener plugin](https://v2.tauri.app/plugin/opener/)
- [Single-instance plugin](https://v2.tauri.app/plugin/single-instance/)
- [Updater plugin](https://v2.tauri.app/plugin/updater/)
- [Path API](https://v2.tauri.app/reference/javascript/api/namespacepath/)
- [Configuration reference: file associations and NSIS install mode](https://v2.tauri.app/reference/config/)
- [Custom protocol builder API](https://docs.rs/tauri/latest/tauri/struct.Builder.html)
- [Asset protocol Range implementation](https://docs.rs/tauri/latest/src/tauri/protocol/asset.rs.html)
- [WebDriver testing](https://v2.tauri.app/develop/tests/webdriver/)
- [WebDriver CI](https://v2.tauri.app/develop/tests/webdriver/ci/)
- [Windows installer](https://v2.tauri.app/distribute/windows-installer/)
- [Windows code signing](https://v2.tauri.app/distribute/sign/windows/)
- [GitHub release pipeline](https://v2.tauri.app/distribute/pipelines/github/)
- [Microsoft Store](https://v2.tauri.app/distribute/microsoft-store/) — 첫 릴리스 비범위 참고

Tauri plugin은 공식 문서에 있다고 모두 설치하지 않는다. 현재 권장 최소는 dialog, opener, single-instance이고, update installer를 쓰지 않는 동안 updater plugin도 필수가 아니다. broad filesystem/store/window-state/CLI/deep-link plugin은 제품 계약과 security review 없이 추가하지 않는다.

## 11. PDF.js 공식 자료

- [Getting started and distribution files](https://mozilla.github.io/pdf.js/getting_started/)
- [API index](https://mozilla.github.io/pdf.js/api/)
- [`getDocument` / pdfjsLib](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html)
- [`PDFPageProxy`](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html)
- [FAQ](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions)
- [Repository and Apache-2.0 license](https://github.com/mozilla/pdf.js)

사용할 핵심 API 범위:

- `getDocument`
- `getPage`
- `getViewport`
- `render` / `RenderTask.cancel`
- `getTextContent`
- `getAnnotations({ intent: "display" })`
- destination resolution primitives

generic viewer internal API를 쓸 때는 adapter 뒤에 감추고 exact package version과 full fixture test를 요구한다.

## 12. Microsoft 공식 UX 자료

- [Windows typography](https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/typography)
- [Keyboard accessibility](https://learn.microsoft.com/en-us/windows/apps/design/accessibility/keyboard-accessibility)
- [Accessibility overview](https://learn.microsoft.com/en-us/windows/apps/design/accessibility/accessibility-overview)
- [Accessibility testing](https://learn.microsoft.com/en-us/windows/apps/design/accessibility/accessibility-testing)

## 13. 공식 자료에서 확정되지 않은 항목

다음은 “Tauri 옵션 하나면 끝”이라고 가정하지 말고 packaged Windows evidence로 확인한다.

- `bundle.fileAssociations`로 만든 NSIS `.pdf` Open With registry와 uninstall cleanup의 실제 결과
- custom protocol의 packaged WebView2 Range/CORS/origin 세부
- PDF.js print service의 WebView2 system dialog/cancel 동작
- SmartScreen reputation 형성 시간
- multi-monitor DPI 전환 시 overlay geometry

이 항목은 transport/geometry는 W02, print는 W12, file association·installer·SmartScreen은 W13 gate에 속한다.
