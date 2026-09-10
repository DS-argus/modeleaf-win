import { describe, expect, it } from "vitest";
import { performTabActivation, performTabClose, queueRelativeTabActivation, type TabActivationOperations } from "../../../src/application/TabActivationCoordinator";
import { createWorkspaceTransitionQueue } from "../../../src/application/WorkspaceTransitionQueue";
import { TabWorkspace, type TabId } from "../../../src/core/TabWorkspace";

type Payload = { active: boolean; readonly name: string };

function activationHarness() {
  const payloads = new Map<number, Payload>([[1, { active: true, name: "one" }], [2, { active: false, name: "two" }]]);
  const events: string[] = [];
  let activeId = 1;
  let geometryPublishedFor = 0;
  const operations: TabActivationOperations<number, Payload> = {
    activeId: () => activeId,
    payload: (id) => payloads.get(id),
    isActive: (payload) => payload.active,
    cancelPending: (payload) => { events.push(`cancel:${payload.name}`); },
    deactivate: async (payload) => { events.push(`deactivate:${payload.name}`); payload.active = false; },
    activateWorkspace: (id) => { if (!payloads.has(id) || id === activeId) return false; activeId = id; events.push(`workspace:${id}`); return true; },
    activateCurrent: async (restoreFocus) => {
      events.push(`activate:${activeId}:${String(restoreFocus)}`);
      expect(geometryPublishedFor).toBe(activeId);
      payloads.get(activeId)!.active = true;
      if (restoreFocus) events.push(`focus:${activeId}`);
    },
    publish: () => { geometryPublishedFor = activeId; events.push(`publish:${activeId}`); },
    reportFailure: (payload) => { events.push(`failure:${payload.name}`); },
  };
  return { payloads, events, operations, activeId: () => activeId };
}

describe("TabActivationCoordinator", () => {
  it("publishes the selected host geometry before activation and restores reader focus", async () => {
    const harness = activationHarness();
    await performTabActivation(2, harness.operations);
    expect(harness.activeId()).toBe(2);
    expect(harness.payloads.get(2)?.active).toBe(true);
    expect(harness.events).toEqual([
      "cancel:one",
      "deactivate:one",
      "workspace:2",
      "publish:2",
      "activate:2:true",
      "focus:2",
    ]);
  });

  it("rolls workspace ownership back and reports failure when target activation fails", async () => {
    const harness = activationHarness();
    let activationAttempts = 0;
    const operations = { ...harness.operations, activateCurrent: async (restoreFocus: boolean) => {
      activationAttempts += 1;
      if (activationAttempts === 1) { harness.events.push("activate:2:true"); throw new Error("activation failed"); }
      await harness.operations.activateCurrent(restoreFocus);
    } };
    await performTabActivation(2, operations);
    expect(harness.activeId()).toBe(1);
    expect(harness.payloads.get(1)?.active).toBe(true);
    expect(harness.events).toEqual([
      "cancel:one",
      "deactivate:one",
      "workspace:2",
      "publish:2",
      "activate:2:true",
      "workspace:1",
      "publish:1",
      "activate:1:true",
      "focus:1",
      "failure:one",
      "publish:1",
    ]);
  });

  it("serializes rapid relative P and N moves against the latest committed tab", async () => {
    const workspace = new TabWorkspace(() => undefined);
    const second = workspace.appendAndActivate(undefined)!;
    const third = workspace.appendAndActivate(undefined)!;
    expect(workspace.activeTabId).toBe(third);
    const queue = createWorkspaceTransitionQueue(() => { throw new Error("overflow"); });
    const visited: number[] = [];
    const activate = async (id: TabId): Promise<void> => {
      await Promise.resolve();
      expect(workspace.activate(id)).toBe(true);
      visited.push(id as number);
    };
    const enqueue = queue.enqueueActivation;

    await Promise.all([
      queueRelativeTabActivation(-1, enqueue, (direction) => workspace.adjacentId(direction), activate),
      queueRelativeTabActivation(-1, enqueue, (direction) => workspace.adjacentId(direction), activate),
    ]);
    expect(visited).toEqual([second as number, 1]);

    await Promise.all([
      queueRelativeTabActivation(1, enqueue, (direction) => workspace.adjacentId(direction), activate),
      queueRelativeTabActivation(1, enqueue, (direction) => workspace.adjacentId(direction), activate),
    ]);
    expect(visited).toEqual([second as number, 1, second as number, third as number]);
  });
});

describe("tab close activation", () => {
  function harness() {
    const workspace = new TabWorkspace(() => ({ active: false, name: "empty" }));
    const first = workspace.activeTabId;
    workspace.setPayload(first, { active: false, name: "one" });
    const second = workspace.appendAndActivate({ active: true, name: "two" })!;
    let visibleId = second;
    const events: string[] = [];
    const operations = {
      activeId: () => workspace.activeTabId,
      cancelPending: () => { events.push("cancel"); },
      closeWorkspace: (id: TabId) => { events.push("close"); return workspace.close(id); },
      publish: () => { visibleId = workspace.activeTabId; events.push("publish"); },
      activateCurrent: async () => {
        expect(visibleId).toBe(workspace.activeTabId);
        events.push("activate");
        workspace.getPayload(workspace.activeTabId)!.active = true;
      },
    };
    return { workspace, first, second, events, operations };
  }

  it("reveals a remaining inactive tab before restoring its presentation", async () => {
    const h = harness();
    await performTabClose(h.second, h.operations);
    expect(h.workspace.activeTabId).toBe(h.first);
    expect(h.workspace.getPayload(h.first)?.active).toBe(true);
    expect(h.events).toEqual(["cancel", "close", "publish", "activate"]);
  });

  it("closes an inactive tab without cancelling or reactivating the current tab", async () => {
    const h = harness();
    await performTabClose(h.first, h.operations);
    expect(h.workspace.activeTabId).toBe(h.second);
    expect(h.events).toEqual(["close", "publish"]);
  });

  it("publishes and activates the empty replacement after closing the last tab", async () => {
    const h = harness();
    h.workspace.close(h.first);
    await performTabClose(h.second, h.operations);
    expect(h.workspace.snapshot.tabs).toHaveLength(1);
    expect(h.workspace.getPayload(h.workspace.activeTabId)?.name).toBe("empty");
    expect(h.events).toEqual(["cancel", "close", "publish", "activate"]);
  });

  it("propagates restore failure while retaining the visible surviving tab", async () => {
    const h = harness();
    await expect(performTabClose(h.second, { ...h.operations, activateCurrent: async () => {
      expect(h.events.at(-1)).toBe("publish");
      throw new Error("PDF_PRESENTATION_RESTORE_FAILED");
    } })).rejects.toThrow("PDF_PRESENTATION_RESTORE_FAILED");
    expect(h.workspace.activeTabId).toBe(h.first);
    expect(h.workspace.getPayload(h.second)).toBeUndefined();
  });

  it("ignores a repeated close without another activation", async () => {
    const h = harness();
    h.workspace.close(h.first);
    await performTabClose(h.first, h.operations);
    expect(h.events).toEqual(["close"]);
  });
});
