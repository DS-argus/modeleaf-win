import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTION_DESCRIPTORS,
  ACTION_IDS,
  CONFIGURABLE_ACTION_DESCRIPTORS,
  FIXED_ACTION_IDS,
  INPUT_CONTEXTS,
  getActionDescriptor,
  getActionRuntimeAvailability,
  isActionAvailable,
} from "../../../src/domain/actions/ActionRegistry";

const snapshot = JSON.parse(readFileSync(
  join(process.cwd(), "tests/contract/snapshots/action-ids.json"),
  "utf8",
)) as { readonly ids: readonly string[]; readonly count: number };

describe("ActionRegistry", () => {
  it("matches the exact frozen 54-action order with no duplicates", () => {
    expect(ACTION_IDS).toEqual(snapshot.ids);
    expect(ACTION_IDS).toHaveLength(snapshot.count);
    expect(new Set(ACTION_IDS).size).toBe(54);
    expect(ACTION_DESCRIPTORS.map(({ id }) => id)).toEqual(ACTION_IDS);
  });

  it("has exactly the four frozen fixed-binding actions", () => {
    expect(FIXED_ACTION_IDS).toEqual([
      "prompt.commit",
      "prompt.cancel",
      "search.next",
      "search.previous",
    ]);
    expect(CONFIGURABLE_ACTION_DESCRIPTORS).toHaveLength(50);
  });

  it("exposes exactly four input contexts and context-scoped availability", () => {
    expect(INPUT_CONTEXTS).toEqual(["navigation", "pagePrompt", "searchPrompt", "searchResults"]);
    expect(isActionAvailable("prompt.commit", "pagePrompt")).toBe(true);
    expect(isActionAvailable("prompt.commit", "navigation")).toBe(false);
    expect(isActionAvailable("toc.toggle", "navigation")).toBe(true);
    expect(isActionAvailable("toc.toggle", "searchResults")).toBe(true);
    expect(isActionAvailable("toc.toggle", "pagePrompt")).toBe(false);
    expect(isActionAvailable("document.open", "searchPrompt")).toBe(true);
  });

  it("uses the Windows Close Window product label for stable app.quit", () => {
    expect(getActionDescriptor("app.quit")?.displayName).toBe("Close Window");
  });

  it("returns explicit runtime availability reasons for capacities and ownership", () => {
    const ready = { hasDocument: true, canOpenDocument: true, canCreateSession: true, canCreateWindow: true, tabCount: 2, modalOpen: false, updateAvailable: true, configExists: true, searchActive: true, canHistoryBack: true, canHistoryForward: true, linkCount: 2 };
    expect(getActionRuntimeAvailability("document.print", ready)).toEqual({ enabled: true });
    expect(getActionRuntimeAvailability("document.print", { ...ready, hasDocument: false })).toEqual({ enabled: false, reason: "No document open" });
    expect(getActionRuntimeAvailability("document.open", { ...ready, canCreateSession: false })).toEqual({ enabled: false, reason: "Document capacity unavailable" });
    expect(getActionRuntimeAvailability("app.new", { ...ready, canCreateWindow: false })).toEqual({ enabled: false, reason: "Window capacity unavailable" });
    expect(getActionRuntimeAvailability("tab.select.3", ready)).toEqual({ enabled: false, reason: "Tab not open" });
    expect(getActionRuntimeAvailability("tab.next", { ...ready, tabCount: 1 })).toEqual({ enabled: false, reason: "Only one tab open" });
    expect(getActionRuntimeAvailability("config.writeDefault", ready)).toEqual({ enabled: false, reason: "Config already exists" });
    expect(getActionRuntimeAvailability("config.resetDefault", { ...ready, configExists: false })).toEqual({ enabled: false, reason: "No config to reset" });
    expect(getActionRuntimeAvailability("search.cancel", { ...ready, searchActive: false })).toEqual({ enabled: false, reason: "No active search" });
    expect(getActionRuntimeAvailability("history.back", { ...ready, canHistoryBack: false })).toEqual({ enabled: false, reason: "No back history" });
    expect(getActionRuntimeAvailability("history.forward", { ...ready, canHistoryForward: false })).toEqual({ enabled: false, reason: "No forward history" });
    expect(getActionRuntimeAvailability("link.hint", { ...ready, linkCount: 0 })).toEqual({ enabled: false, reason: "No links on page" });
    expect(getActionRuntimeAvailability("update.show", { ...ready, updateAvailable: false })).toEqual({ enabled: false, reason: "No update available" });
    expect(getActionRuntimeAvailability("document.open", { ...ready, modalOpen: true })).toEqual({ enabled: false, reason: "Close the current dialog" });
    expect(getActionRuntimeAvailability("app.quit", { ...ready, modalOpen: true })).toEqual({ enabled: true });
  });
  it("freezes every exported registry projection", () => {
    expect(Object.isFrozen(ACTION_IDS)).toBe(true);
    expect(Object.isFrozen(ACTION_DESCRIPTORS)).toBe(true);
    expect(ACTION_DESCRIPTORS.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(FIXED_ACTION_IDS)).toBe(true);
  });
});
