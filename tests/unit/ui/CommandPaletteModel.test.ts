// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ActionRuntimeContext } from "../../../src/domain/actions/ActionRegistry";
import {
  buildCommandPaletteEntries,
  commandPaletteKeyAction,
  isPaletteClearShortcut,
  moveCommandPaletteIndex,
  type CommandPaletteCommandEntry,
  type RecentPaletteRecord,
} from "../../../src/ui/CommandPaletteModel";

const baseContext: ActionRuntimeContext = {
  hasDocument: true, canCreateSession: true, canOpenDocument: true, canCreateWindow: true,
  tabCount: 2, modalOpen: false, updateAvailable: false, configExists: false,
  searchActive: false, canHistoryBack: false, canHistoryForward: false, linkCount: 1,
};
const unavailableContext: ActionRuntimeContext = { ...baseContext, hasDocument: false, canCreateSession: false, canOpenDocument: false, canCreateWindow: false, modalOpen: true, linkCount: 0 };
function recent(recentId: string, displayName: string): RecentPaletteRecord {
  return { recentId, displayName };
}

describe("CommandPaletteModel", () => {
  it("uses the authoritative enabled-first twelve-row projection", () => {
    const entries = buildCommandPaletteEntries(unavailableContext, [recent("recent", "PDF")]);
    expect(entries).toHaveLength(12);
    const enabled = entries.filter((entry): entry is CommandPaletteCommandEntry => entry.kind === "command").map(({ enabled }) => enabled);
    const firstDisabled = enabled.indexOf(false);
    expect(firstDisabled).toBeGreaterThanOrEqual(0);
    expect(enabled.slice(firstDisabled)).not.toContain(true);
    expect(new Set(entries.map((entry) => entry.kind === "command" ? `action:${entry.id}` : `recent:${entry.recentId}`)).size).toBe(entries.length);
  });
  it("reports a foreign modal as the blocking reason", () => {
    const command = buildCommandPaletteEntries(unavailableContext)
      .find((entry): entry is CommandPaletteCommandEntry => entry.kind === "command" && entry.id === "document.open");

    expect(command).toMatchObject({ enabled: false, disabledReason: "Close the current dialog" });
  });
  it("makes actions activatable when the palette explicitly owns the modal", () => {
    const command = buildCommandPaletteEntries({ ...baseContext, modalOpen: true }, [], "", undefined, { modalOwner: "palette" })
      .find((entry): entry is CommandPaletteCommandEntry => entry.kind === "command" && entry.id === "document.open");

    expect(command).toMatchObject({ enabled: true });
    expect(command).not.toHaveProperty("disabledReason");
  });
  it("normalizes Korean composed and decomposed text before ranking", () => {
    const entries = buildCommandPaletteEntries(undefined, [
      recent("exact", "가"),
      recent("prefix", "가나다"),
    ], "가");

    expect(entries.filter((entry) => entry.kind === "recent").map((entry) => entry.recentId))
      .toEqual(["exact", "prefix"]);
  });

  it("caps the combined command and recent projection at twelve rows", () => {
    const recents = Array.from({ length: 16 }, (_, index) => recent(`recent-${index}`, `Document ${index}`));
    const entries = buildCommandPaletteEntries(undefined, recents, "Document");
    const paletteRecents = entries.filter((entry) => entry.kind === "recent");
    expect(entries).toHaveLength(12);
    expect(paletteRecents.map((entry) => entry.recentId)).toEqual(recents.slice(0, paletteRecents.length).map((entry) => entry.recentId));
  });

  it("rejects pasted queries over the Unicode code-point limit", () => {
    const oversizedQuery = "😀".repeat(257);
    const entries = buildCommandPaletteEntries(undefined, [recent("oversized", oversizedQuery)], oversizedQuery);

    expect(entries).toEqual([]);
  });

  it("rejects oversized raw input before Unicode normalization", () => {
    const normalize = vi.spyOn(String.prototype, "normalize");

    expect(buildCommandPaletteEntries(undefined, [], "x".repeat(513))).toEqual([]);
    expect(normalize).not.toHaveBeenCalled();

    normalize.mockRestore();
  });

  it("retains native most-recent order for equal-score recent matches", () => {
    const entries = buildCommandPaletteEntries(undefined, [
      { recentId: "native-most-recent", displayName: "same" },
      { recentId: "stable-id-would-sort-first", displayName: "same" },
    ], "same");

    expect(entries.filter((entry) => entry.kind === "recent").map((entry) => entry.recentId))
      .toEqual(["native-most-recent", "stable-id-would-sort-first"]);
  });

  it("ranks exact and prefix matches, fuzzy score, then native recency", () => {
    const matchKindOrder = buildCommandPaletteEntries(undefined, [
      recent("subsequence", "xdoc"),
      recent("prefix", "document"),
      recent("exact", "doc"),
    ], "doc");
    expect(matchKindOrder.filter((entry) => entry.kind === "recent").map((entry) => entry.recentId))
      .toEqual(["exact", "prefix", "subsequence"]);

    const scoreOrder = buildCommandPaletteEntries(undefined, [
      recent("spaced", "xaxb"),
      recent("contiguous", "xaab"),
    ], "ab");
    expect(scoreOrder.filter((entry) => entry.kind === "recent").map((entry) => entry.recentId))
      .toEqual(["contiguous", "spaced"]);

    const tieBreakOrder = buildCommandPaletteEntries(undefined, [
      recent("native-most-recent", "same"),
      recent("native-next", "same"),
      recent("native-oldest", "same"),
    ], "same");
    expect(tieBreakOrder.filter((entry) => entry.kind === "recent").map((entry) => entry.recentId))
      .toEqual(["native-most-recent", "native-next", "native-oldest"]);
  });

  it("accepts two-field native recent payloads and exposes only palette fields", () => {
    const untrustedRecent = {
      recentId: "opaque-id",
      displayName: "Safe name.pdf",
      path: "C:\\secret\\Safe name.pdf",
    } as RecentPaletteRecord;
    const entry = buildCommandPaletteEntries(undefined, [untrustedRecent], "Safe name.pdf")
      .find((candidate) => candidate.kind === "recent");

    expect(entry).toEqual({
      kind: "recent",
      recentId: "opaque-id",
      displayName: "Safe name.pdf",
    });
    expect(entry).not.toHaveProperty("path");
  });

  it("recognizes Ctrl+Shift+C by physical key code under non-Latin input", () => {
    expect(isPaletteClearShortcut({ key: "ㅊ", code: "KeyC", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, isComposing: false })).toBe(true);
    expect(isPaletteClearShortcut({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, isComposing: false })).toBe(false);
  });

  it("handles Ctrl+J/K across dialog controls without moving an empty palette", () => {
    const dialog = document.createElement("dialog");
    const input = document.createElement("input");
    const button = document.createElement("button");
    dialog.append(input, button);
    let activeIndex = 0;
    let entryCount = 3;
    const actions: string[] = [];
    dialog.addEventListener("keydown", (event) => {
      const action = commandPaletteKeyAction(event);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      actions.push(action);
      if (action === "next" || action === "previous") {
        activeIndex = moveCommandPaletteIndex(activeIndex, entryCount, action);
      }
    }, { capture: true });
    const press = (target: HTMLElement, key: string, ctrlKey = false): void => {
      const event = new KeyboardEvent("keydown", { key, ctrlKey, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    };

    press(input, "j", true);
    expect(activeIndex).toBe(1);
    press(button, "ArrowDown");
    expect(activeIndex).toBe(2);
    press(button, "k", true);
    expect(activeIndex).toBe(1);
    press(input, "ArrowUp");
    expect(activeIndex).toBe(0);
    entryCount = 0;
    press(button, "j", true);
    expect(activeIndex).toBe(0);
    press(button, "Enter");
    press(button, "Escape");
    expect(actions).toEqual(["next", "next", "previous", "previous", "next", "submit", "close"]);
  });
});
