import { describe, expect, it } from "vitest";
import { TabStore } from "../../../src/domain/tabs/TabStore";

describe("TabStore", () => {
  it("appends stable IDs, activates, and cycles adjacent tabs", () => {
    const store = new TabStore<string>();
    const first = store.appendAndActivate("a");
    const second = store.appendAndActivate("b");
    expect(first.ok && second.ok).toBe(true);
    const ids = store.snapshot().tabs.map(({ id }) => id);
    expect(store.previous()).toMatchObject({ ok: true, snapshot: { activeId: ids[0] } });
    expect(store.previous()).toMatchObject({ ok: true, snapshot: { activeId: ids[1] } });
    expect(store.next()).toMatchObject({ ok: true, snapshot: { activeId: ids[0] } });
  });

  it("does not impose a non-golden tab cap and keeps tab nine addressable", () => {
    const store = new TabStore<number>();
    for (let index = 0; index < 12; index += 1) expect(store.appendAndActivate(index).ok).toBe(true);
    const ninth = store.snapshot().tabs[8]!.id;
    expect(store.activate(ninth)).toMatchObject({ ok: true, snapshot: { activeId: ninth } });
  });

  it("closes active to right then left and emits removal once", () => {
    const store = new TabStore<string>();
    store.appendAndActivate("a");
    store.appendAndActivate("b");
    store.appendAndActivate("c");
    const ids = store.snapshot().tabs.map(({ id }) => id);
    store.activate(ids[1]!);
    const middle = store.close(ids[1]!);
    expect(middle).toMatchObject({ ok: true, snapshot: { activeId: ids[2] }, effect: { kind: "removed", tab: { value: "b" } } });
    expect(store.close(ids[1]!)).toEqual({ ok: false, reason: "Tab not found" });
    store.close(ids[2]!);
    expect(store.snapshot().activeId).toBe(ids[0]);
  });

  it("stages, commits, and rolls back adoption with explicit effects", () => {
    const store = new TabStore<string>();
    store.appendAndActivate("healthy");
    const healthyId = store.snapshot().activeId;
    expect(store.stageAdoption("candidate")).toMatchObject({ ok: true, snapshot: { activeId: healthyId, tabs: [{ value: "healthy" }] } });
    expect(store.stageAdoption("second")).toEqual({ ok: false, reason: "Adoption already staged" });
    expect(store.rollbackAdoption()).toMatchObject({ ok: true, effect: { kind: "rolled-back", tab: { value: "candidate" } } });
    expect(store.snapshot().tabs.map(({ value }) => value)).toEqual(["healthy"]);
    store.stageAdoption("committed");
    expect(store.commitAdoption().ok).toBe(true);
    expect(store.snapshot().tabs.map(({ value }) => value)).toEqual(["healthy", "committed"]);
  });

  it("returns frozen opaque snapshots", () => {
    const store = new TabStore<string>();
    store.appendAndActivate("a");
    const snapshot = store.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.tabs)).toBe(true);
    expect(Object.isFrozen(snapshot.tabs[0])).toBe(true);
  });
});
