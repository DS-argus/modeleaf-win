import { describe, expect, it } from "vitest";
import { validateProductConfig } from "../../src/domain/config/ConfigValidator";
import { createRootKeyboardRouter, type RootKeyboardEvent } from "../../src/platform/RootKeyboardRouter";
import { createOverlayOwner, reduceOverlayOwner } from "../../src/ui/overlays/OverlayOwner";
import { currentWindowCloseIntent } from "../../src/ui/shell/ShellProjection";
const configResult = validateProductConfig({});
if (!configResult.ok) throw new Error("built-in config invalid");
const runtime = { hasDocument: false, canOpenDocument: true, canCreateSession: true, canCreateWindow: true, tabCount: 1, paneCount: 1, modalOpen: false, updateAvailable: false, configExists: false, searchActive: false, canHistoryBack: false, canHistoryForward: false, linkCount: 0 };
function altF4(): RootKeyboardEvent { return { key: "F4", ctrlKey: false, altKey: true, shiftKey: false, metaKey: false, repeat: false, preventDefault: () => undefined }; }
describe("W05 window isolation", () => {
  it("routes an Alt+F4 action only through the owning window", () => {
    const left: string[] = []; const right: string[] = [];
    const leftRouter = createRootKeyboardRouter({ config: configResult.value, getContext: () => ({ windowId: "left", routeRevision: "left-tab", generation: 1, inputContext: "navigation", runtime }), onDispatch: (id) => left.push(id) });
    const rightRouter = createRootKeyboardRouter({ config: configResult.value, getContext: () => ({ windowId: "right", routeRevision: "right-tab", generation: 1, inputContext: "navigation", runtime }), onDispatch: (id) => right.push(id) });
    leftRouter.handleKeyDown(altF4());
    expect(left).toEqual(["app.quit"]); expect(right).toEqual([]);
    expect(currentWindowCloseIntent("left")).toEqual({ type: "window.close", windowId: "left" });
    leftRouter.dispose(); rightRouter.dispose();
  });
  it("rejects cross-window overlay closure and preserves its focus owner", () => {
    const opened = reduceOverlayOwner(createOverlayOwner("left", "left-reader"), { type: "open", windowId: "left", overlay: "help", focusedTarget: "left-tab" });
    const foreign = reduceOverlayOwner(opened.state, { type: "escape", windowId: "right" });
    expect(foreign.state).toBe(opened.state); expect(foreign.effects).toEqual([]);
    expect(reduceOverlayOwner(opened.state, { type: "escape", windowId: "left" }).effects.at(-1)).toEqual({ type: "focus", target: "left-tab" });
  });
});
