import { describe, expect, it } from "vitest";
import { createOverlayOwner, reduceOverlayOwner } from "../../../src/ui/overlays/OverlayOwner";

describe("OverlayOwner", () => {
  it("captures a valid focus target and restores it on Escape", () => {
    const initial = createOverlayOwner("window-a", "reader-a");
    const opened = reduceOverlayOwner(initial, { type: "open", windowId: "window-a", overlay: "help", focusedTarget: "tab-a" });
    expect(opened.effects.map(({ type }) => type)).toEqual(["cancelPendingInput", "show"]);
    const closed = reduceOverlayOwner(opened.state, { type: "escape", windowId: "window-a" });
    expect(closed.effects.at(-1)).toEqual({ type: "focus", target: "tab-a" });
  });
  it("never restores body or a removed target", () => {
    const initial = createOverlayOwner("window-a", "reader-a");
    const body = reduceOverlayOwner(initial, { type: "open", windowId: "window-a", overlay: "theme", focusedTarget: "body" });
    expect(reduceOverlayOwner(body.state, { type: "escape", windowId: "window-a" }).effects.at(-1)).toEqual({ type: "focus", target: "reader-a" });
    const stale = reduceOverlayOwner(initial, { type: "open", windowId: "window-a", overlay: "theme", focusedTarget: "removed" });
    expect(reduceOverlayOwner(stale.state, { type: "escape", windowId: "window-a" }, (target) => target !== "removed").effects.at(-1)).toEqual({ type: "focus", target: "reader-a" });
  });
  it("replaces overlays while preserving the original return target and prompt", () => {
    const prompt = { kind: "search" as const, text: "résumé", selectionStart: 1, selectionEnd: 4 };
    const initial = createOverlayOwner("window-a", "reader-a");
    const help = reduceOverlayOwner(initial, { type: "open", windowId: "window-a", overlay: "help", focusedTarget: "search", suspendedPrompt: prompt });
    const update = reduceOverlayOwner(help.state, { type: "open", windowId: "window-a", overlay: "update", focusedTarget: "help-row" });
    expect(update.effects).toContainEqual({ type: "hide", overlay: "help" });
    const resumed = reduceOverlayOwner(update.state, { type: "close", windowId: "window-a", overlay: "update" });
    expect(resumed.effects).toEqual([{ type: "hide", overlay: "update" }, { type: "show", overlay: "help" }]);
    const closed = reduceOverlayOwner(resumed.state, { type: "close", windowId: "window-a", overlay: "help" });
    expect(closed.effects).toContainEqual({ type: "restorePrompt", prompt });
    expect(closed.effects.at(-1)).toEqual({ type: "focus", target: "search" });
  });
  it("ignores stale overlay and other-window intents", () => {
    const initial = createOverlayOwner("window-a", "reader-a");
    expect(reduceOverlayOwner(initial, { type: "open", windowId: "window-b", overlay: "help" }).effects).toEqual([]);
    const open = reduceOverlayOwner(initial, { type: "open", windowId: "window-a", overlay: "help" });
    expect(reduceOverlayOwner(open.state, { type: "close", windowId: "window-a", overlay: "theme" }).state).toBe(open.state);
  });
});
