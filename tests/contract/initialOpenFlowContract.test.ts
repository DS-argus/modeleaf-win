import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const source = (path: string): string => readFileSync(path, "utf8");

describe("initial open flow contract", () => {
  const main = source("src/main.ts");
  const styles = source("src/styles/app.css");
  const native = source("src-tauri/src/lib.rs");
  const recent = source("src-tauri/src/recent.rs");
  const adoptionOwnership = source("src/application/OpenAdoptionOwnership.ts");

  it("has one canonical centered empty action with a live shortcut badge", () => {
    expect(main.match(/id="empty-reader-open"/gu)).toHaveLength(1);
    expect(main).toContain('<span>Open PDF</span><kbd id="empty-reader-shortcut"></kbd>');
    expect(main).not.toContain("No PDF open");
    expect(main).toContain("emptyReaderShortcut.textContent = shortcut");
    expect(main).toContain("tabStrip.hidden = documentTabs.length === 0");
    expect(styles).toContain(".tab-strip[hidden] { display: none; }");
    expect(styles).toContain("place-content: center");
  });

  it("uses reducer-only application dialogs and a separate native transition gate", () => {
    expect(main).toContain("modalOpen: overlayOwner.active !== undefined");
    expect(main).not.toContain("dialogOpenPending");
    expect(main).not.toContain("fileOpenerDialog.showModal()");
    expect(main).not.toContain("paletteDialog.showModal()");
    expect(main).toContain("nativeOpenPending");
  });

  it("prepares native-owned recent display metadata before revealing the chooser", () => {
    expect(main).toContain('fileOpenerDialog.addEventListener("close"');
    const preload = main.indexOf("const initialRecentsReady = recentListenerReady.then");
    expect(preload).toBeGreaterThanOrEqual(0);
    expect(preload).toBeLessThan(main.indexOf("async function openFileOpener"));
    expect(main).toContain("await Promise.all([initialRecentsReady, shellOpen.ready]);");
    expect(recent).toContain("RecentListOutcome");
    expect(recent).not.toContain("available_documents");
    const listener = main.indexOf("const recentListenerReady = listen(\"recent-state-changed\"");
    const fetch = main.indexOf("recentListenerReady.then(() => listRecentDocuments(invoke))");
    expect(listener).toBeGreaterThanOrEqual(0);
    expect(listener).toBeLessThan(fetch);
    expect(main).toContain("fileOpenerModel = adoptChooserSnapshot(fileOpenerModel");
    expect(native).not.toContain("recent_recovery_needed");
  });

  it("returns typed dialog/recent outcomes and requires a nonzero HWND", () => {
    expect(native).toContain("enum NativeDialogOutcome");
    expect(native).toContain("RecentOpenOutcome");
    expect(native).toContain("if !hwnd.0.is_null()");
    expect(source("src-tauri/src/open_dialog.rs")).toContain("IFileOpenDialog");
    expect(source("src-tauri/src/open_dialog.rs")).toContain("FOS_DONTADDTORECENT");
    expect(native).toContain("spawn_blocking");
  });

  it("commits visible adoption before acknowledgement and records recents only from a typed terminal", () => {
    const adoptStart = main.indexOf("async function adoptRequest");
    const terminalStart = main.indexOf("function handleOpenTerminal");
    expect(main.slice(adoptStart, terminalStart)).not.toContain("recordRecentDocument");
    expect(main.indexOf("recordRecentDocument(invoke, pending.request.sessionId", terminalStart)).toBeGreaterThan(terminalStart);
    expect(main.slice(adoptStart, terminalStart)).toContain("workspace.commitAdoption(id)");
    expect(main).toContain("rollbackOpenAdoptionOwnership(settled.id, settled.priorActiveId");
    expect(adoptionOwnership).toContain("operations.close(settledId)");
    expect(main).toContain('await activateCurrentTab(terminal.tag !== "DISPOSED")');
    const terminalRollback = main.slice(terminalStart);
    expect(terminalRollback.indexOf("cancelPagePromptOwnership()"))
      .toBeLessThan(terminalRollback.indexOf("rollbackOpenAdoptionOwnership(settled.id"));
    expect(source("src/platform/ShellOpenCoordinator.ts")).toContain("flow.advance(epoch, requestId, progress.step");
    const adoptionSlice = main.slice(adoptStart, terminalStart);
    expect(adoptionSlice.indexOf("pendingOpenAdoptions.set(request.requestId")).toBeLessThan(adoptionSlice.indexOf("publishActivateAndAdoptPdfTab"));
    expect(main).toContain("onTerminal: handleOpenTerminal");
    expect(adoptionSlice.indexOf("pendingOpenAdoptions.set(request.requestId")).toBeLessThan(adoptionSlice.indexOf("queueWorkspaceOwnership"));
    expect(main).toContain("pending.request.ownerGeneration");
    expect(source("src/platform/OpenRequestClient.ts")).toContain("if (!active) return true;");
  });
  it("keeps retired outline parsing out of opening and reader lifetimes", () => {
    expect(main).toContain("async function adoptRequest");
    for (const text of [main, source("src/pdf/PdfReaderController.ts"), source("src/pdf/PdfTabSession.ts")]) {
      expect(text).not.toMatch(/loadOutline|getOutline|readOutline/);
    }
  });

  it("clears durable recents instead of only resetting the filter", () => {
    const clear = main.slice(main.indexOf("async function clearFileOpenerHistory"), main.indexOf("function closeFileOpener"));
    expect(clear).toContain("await clearRecentDocuments(invoke)");
    expect(clear).toContain('outcome.tag === "COMMITTED"');
    expect(clear).toContain("retainChooserFailure");
    expect(clear).not.toContain("updateChooserQuery");
    expect(main).toContain("void clearFileOpenerHistory()");
  });

  it("never jumps to the whole continuous document bottom at a page boundary", () => {
    expect(main).not.toContain("payload.host.scrollTop = Math.max");
    expect(main).toContain('behavior: "instant"');
    const scroll = main.slice(main.indexOf('if (type.startsWith("scroll."))'), main.indexOf("const rootKeyboard ="));
    expect(scroll).not.toContain("wheelPageDirection");
    expect(main).toContain('active().session.snapshot.reader.zoomMode === "fit-page"');
    expect(main).not.toContain("turnFittedPage");
    expect(main).toContain("fitPageScrollDirection");
    expect(main).toContain('type === "scroll.byCssPixels" && action.axis === "vertical"');
    expect(scroll).toContain("payload.host.scrollBy({ left: intent.horizontalCssPixels, top: verticalCssPixels");
    expect(main).toContain('overlayOwner.active === undefined && result.kind === "verifiedLanding"');
  });
});
