import { describe, expect, it } from "vitest";
import { MAX_TAB_COUNT, TabWorkspace, type TabId } from "../../../src/core/TabWorkspace";

describe("TabWorkspace", () => {
  it("starts with one empty tab and appends then activates Ctrl+N-style tabs", () => {
    let emptyCount = 0;
    const workspace = new TabWorkspace(() => ({ kind: "empty", serial: ++emptyCount }));
    const initial = workspace.activeTabId;

    const added = workspace.appendAndActivate({ kind: "new", serial: 2 });

    expect(added).not.toBeNull();
    expect(workspace.snapshot.tabs.map((tab) => tab.id)).toEqual([initial, added]);
    expect(workspace.activeTabId).toBe(added);
    expect(workspace.snapshot.tabs[0]!.payload).toEqual({ kind: "empty", serial: 1 });
  });

  it("denies an append at the cap without changing the active tab or snapshot", () => {
    const workspace = new TabWorkspace<{ empty?: boolean; index?: number }>(() => ({ empty: true }));
    for (let index = 1; index < MAX_TAB_COUNT; index += 1) {
      expect(workspace.appendAndActivate({ index })).not.toBeNull();
    }
    const before = workspace.snapshot;

    expect(workspace.appendAndActivate({ index: MAX_TAB_COUNT })).toBeNull();
    expect(workspace.snapshot).toBe(before);
    expect(workspace.activeTabId).toBe(before.activeTabId);
  });

  it("preserves order and chooses right, then left, when closing the active tab", () => {
    const workspace = new TabWorkspace(() => "empty");
    const first = workspace.activeTabId;
    const second = workspace.appendAndActivate("second") as TabId;
    const third = workspace.appendAndActivate("third") as TabId;

    workspace.activate(second);
    expect(workspace.close(second)).toBe(true);
    expect(workspace.snapshot.tabs.map((tab) => tab.id)).toEqual([first, third]);
    expect(workspace.activeTabId).toBe(third);

    expect(workspace.close(third)).toBe(true);
    expect(workspace.activeTabId).toBe(first);

    expect(workspace.close(first)).toBe(true);
    expect(workspace.snapshot.tabs).toHaveLength(1);
    expect(workspace.snapshot.activeTabId).not.toBe(first);
    expect(workspace.snapshot.tabs[0]!.payload).toBe("empty");
  });

  it("rolls back only a staged candidate and restores the prior active tab", () => {
    const disposed: string[] = [];
    const workspace = new TabWorkspace(() => "empty");
    const prior = workspace.appendAndActivate("ready") as TabId;
    const candidate = workspace.stageAdoption("failed", {
      dispose(payload) {
        disposed.push(payload);
      },
    }) as TabId;

    expect(workspace.activeTabId).toBe(candidate);
    expect(workspace.rollbackAdoption(candidate)).toBe(true);
    expect(workspace.activeTabId).toBe(prior);
    expect(workspace.snapshot.tabs.map((tab) => tab.payload)).toEqual(["empty", "ready"]);
    expect(disposed).toEqual(["failed"]);
  });

  it("keeps caller-owned payloads local to each tab and snapshots structurally stable", () => {
    const workspace = new TabWorkspace(() => ({ count: 0 }));
    const initial = workspace.activeTabId;
    const firstSnapshot = workspace.snapshot;
    const secondPayload = { count: 1 };
    const second = workspace.appendAndActivate(secondPayload) as TabId;

    expect(workspace.getPayload(initial)).toEqual({ count: 0 });
    expect(workspace.getPayload(second)).toBe(secondPayload);
    expect(firstSnapshot.tabs).toHaveLength(1);
    expect(workspace.setPayload(initial, { count: 9 })).toBe(true);
    expect(workspace.getPayload(second)).toBe(secondPayload);
    expect(Object.isFrozen(workspace.snapshot.tabs)).toBe(true);
  });

  it("makes duplicate close and rollback harmless and disposes each lifecycle once", () => {
    let disposals = 0;
    const workspace = new TabWorkspace(() => "empty");
    const committed = workspace.appendAndActivate("committed", {
      dispose() {
        disposals += 1;
      },
    }) as TabId;
    const staged = workspace.stageAdoption("staged", {
      dispose() {
        disposals += 1;
      },
    }) as TabId;

    expect(workspace.commitAdoption(staged)).toBe(true);
    expect(workspace.rollbackAdoption(staged)).toBe(false);
    expect(workspace.close(committed)).toBe(true);
    expect(workspace.close(committed)).toBe(false);
    expect(workspace.close(staged)).toBe(true);
    expect(workspace.close(staged)).toBe(false);
    expect(disposals).toBe(2);
  });

  it("exposes opaque tab state without location fields", () => {
    const workspace = new TabWorkspace(() => ({ empty: true }));
    const tab = workspace.snapshot.tabs[0];

    expect(Object.keys(tab!).sort()).toEqual(["id", "payload", "staged"]);
    expect(Object.keys(workspace.snapshot).sort()).toEqual(["activeTabId", "history", "tabs"]);
  });
});
