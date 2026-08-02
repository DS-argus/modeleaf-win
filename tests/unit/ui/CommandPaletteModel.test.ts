import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BINDINGS,
  isCommandEnabled,
  type CommandAvailabilityContext,
} from "../../../src/core/defaultBindings.windows";
import {
  buildCommandPaletteEntries,
  type CommandPaletteCommandEntry,
  type RecentPaletteRecord,
} from "../../../src/ui/CommandPaletteModel";

const unavailableContext: CommandAvailabilityContext = {
  hasDocument: false,
  canCreateSession: false,
  canOpenDocument: false,
  modalOpen: true,
};
const noDocumentContext: CommandAvailabilityContext = {
  hasDocument: false,
  canCreateSession: true,
  canOpenDocument: true,
  modalOpen: false,
};
const documentContext: CommandAvailabilityContext = {
  hasDocument: true,
  canCreateSession: true,
  canOpenDocument: true,
  modalOpen: false,
};

function recent(recentId: string, displayName: string): RecentPaletteRecord {
  return { recentId, displayName };
}

function commandEnabled(id: string, context: CommandAvailabilityContext): boolean | undefined {
  const entry = buildCommandPaletteEntries(context)
    .find((candidate): candidate is CommandPaletteCommandEntry => candidate.kind === "command" && candidate.id === id);
  return entry?.enabled;
}

describe("CommandPaletteModel", () => {
  it("derives command entries and availability from the canonical registry", () => {
    const commands = buildCommandPaletteEntries(unavailableContext)
      .filter((entry): entry is CommandPaletteCommandEntry => entry.kind === "command");
    const visibleBindings = DEFAULT_BINDINGS.filter((binding) => binding.showInPalette);

    expect(commands.map((entry) => entry.id)).toEqual(visibleBindings.map((binding) => binding.id));
    expect(commands.map((entry) => entry.enabled)).toEqual(
      visibleBindings.map((binding) => isCommandEnabled(binding, unavailableContext)),
    );
    expect(commands.find((entry) => entry.id === "tab.new")?.enabled).toBe(false);
  });

  it("disables document commands without a document while retaining global commands", () => {
    expect(commandEnabled("page.next", noDocumentContext)).toBe(false);
    expect(commandEnabled("search.open", noDocumentContext)).toBe(false);
    expect(commandEnabled("linkHints.toggle", noDocumentContext)).toBe(false);
    expect(commandEnabled("view.fitWidth", noDocumentContext)).toBe(false);
    expect(commandEnabled("scroll.down", noDocumentContext)).toBe(false);
    expect(commandEnabled("document.open", noDocumentContext)).toBe(true);
    expect(commandEnabled("help.toggle", noDocumentContext)).toBe(true);
    expect(commandEnabled("tab.new", noDocumentContext)).toBe(true);
  });

  it("enables document commands with a document and gates new tabs by capacity and modals", () => {
    expect(commandEnabled("page.next", documentContext)).toBe(true);
    expect(commandEnabled("search.open", documentContext)).toBe(true);
    expect(commandEnabled("linkHints.toggle", documentContext)).toBe(true);
    expect(commandEnabled("document.open", { ...documentContext, canOpenDocument: false })).toBe(false);
    expect(commandEnabled("view.fitWidth", documentContext)).toBe(true);
    expect(commandEnabled("document.open", { ...documentContext, modalOpen: true })).toBe(false);
    expect(commandEnabled("scroll.down", documentContext)).toBe(true);
    expect(commandEnabled("tab.new", { ...documentContext, canCreateSession: false })).toBe(false);
    expect(commandEnabled("tab.new", { ...documentContext, modalOpen: true })).toBe(false);
  });

  it("normalizes Korean composed and decomposed text before ranking", () => {
    const entries = buildCommandPaletteEntries(undefined, [
      recent("exact", "가"),
      recent("prefix", "가나다"),
    ], "가");

    expect(entries.filter((entry) => entry.kind === "recent").map((entry) => entry.recentId))
      .toEqual(["exact", "prefix"]);
  });

  it("caps opaque native recents and preserves registry then native order for an empty query", () => {
    const recents = Array.from({ length: 16 }, (_, index) => recent(`recent-${index}`, `Document ${index}`));
    const entries = buildCommandPaletteEntries(undefined, recents);
    const commands = DEFAULT_BINDINGS.filter((binding) => binding.showInPalette);
    const paletteRecents = entries.filter((entry) => entry.kind === "recent");

    expect(entries.slice(0, commands.length).map((entry) => entry.kind === "command" ? entry.id : entry.recentId))
      .toEqual(commands.map((binding) => binding.id));
    expect(paletteRecents.map((entry) => entry.recentId)).toEqual(recents.slice(0, 15).map((entry) => entry.recentId));
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
    const entry = buildCommandPaletteEntries(undefined, [untrustedRecent])
      .find((candidate) => candidate.kind === "recent");

    expect(entry).toEqual({
      kind: "recent",
      recentId: "opaque-id",
      displayName: "Safe name.pdf",
    });
    expect(entry).not.toHaveProperty("path");
  });
});
