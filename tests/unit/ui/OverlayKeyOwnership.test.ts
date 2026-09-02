import { describe, expect, it } from "vitest";
import { overlayOwnsKey } from "../../../src/ui/overlays/OverlayKeyOwnership";
const key = (dialogId: string, value: string, ctrlKey = false) => overlayOwnsKey({ dialogId, key: value, ctrlKey, altKey: false, metaKey: false });
describe("OverlayKeyOwnership", () => {
  it("leaves Help viewer arrows to modal-disabled root routing", () => {
    expect(key("help-dialog", "ArrowDown")).toBe(false);
    expect(key("help-dialog", "Escape")).toBe(true);
    expect(key("help-dialog", "Tab")).toBe(true);
  });
  it("owns only keys implemented by each interactive overlay", () => {
    expect(key("theme-dialog", "ArrowDown")).toBe(true);
    expect(key("theme-dialog", "j", true)).toBe(true);
    expect(key("theme-dialog", "j")).toBe(true);
    expect(key("theme-dialog", "k")).toBe(true);
    expect(key("theme-dialog", "ArrowLeft")).toBe(true);
    expect(key("theme-dialog", "ArrowRight")).toBe(true);
    expect(key("theme-dialog", "Home")).toBe(false);
    expect(key("theme-dialog", "ArrowDown", true)).toBe(false);
    expect(key("command-palette-dialog", "ArrowUp")).toBe(true);
    expect(key("search-dialog", "Enter")).toBe(true);
    expect(key("search-dialog", "ArrowDown")).toBe(false);
    expect(overlayOwnsKey({ dialogId: "theme-dialog", key: "ArrowDown", ctrlKey: false, altKey: true, metaKey: false })).toBe(false);
  });
});
