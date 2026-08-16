import { describe, expect, it } from "vitest";
import { PaneTopology, paneOwnerId, type PaneId } from "../../../src/domain/panes/PaneTopology";

const owner = paneOwnerId;
const ids = (topology: PaneTopology): PaneId[] => {
  const visit = (node: ReturnType<PaneTopology["snapshot"]>["root"]): PaneId[] => node.kind === "leaf" ? [node.paneId] : [...visit(node.first), ...visit(node.second)];
  return visit(topology.snapshot().root);
};

describe("PaneTopology", () => {
  it("rejects empty and duplicate pane-local owner identities", () => {
    expect(() => paneOwnerId(" ")).toThrow("must not be empty");
    const topology = new PaneTopology(owner("one"));
    expect(topology.stageSplit(topology.snapshot().focusedPaneId, "horizontal", owner("one"))).toEqual({ ok: false, reason: "Pane owner already installed" });
  });

  it("stages without layout mutation, commits focus, and rolls back cleanly", () => {
    const topology = new PaneTopology(owner("one"));
    const first = ids(topology)[0]!;
    expect(topology.stageSplit(first, "horizontal", owner("two"))).toMatchObject({ ok: true, snapshot: { paneCount: 1 } });
    expect(topology.rollbackSplit()).toMatchObject({ ok: true, snapshot: { paneCount: 1 } });
    topology.stageSplit(first, "horizontal", owner("two"));
    expect(topology.commitSplit()).toMatchObject({ ok: true, snapshot: { paneCount: 2 } });
    expect(topology.snapshot().focusedPaneId).not.toBe(first);
  });

  it("grows deterministically to four and rejects a fifth with exact reason", () => {
    const topology = new PaneTopology(owner("one"));
    for (const name of ["two", "three", "four"]) {
      topology.stageSplit(topology.snapshot().focusedPaneId, name === "three" ? "vertical" : "horizontal", owner(name));
      expect(topology.commitSplit().ok).toBe(true);
    }
    expect(topology.snapshot().paneCount).toBe(4);
    expect(topology.stageSplit(topology.snapshot().focusedPaneId, "horizontal", owner("five"))).toEqual({ ok: false, reason: "Maximum panes open" });
  });

  it("prioritizes perpendicular overlap in asymmetric directional focus", () => {
    const topology = new PaneTopology(owner("left"));
    const left = topology.snapshot().focusedPaneId;
    topology.stageSplit(left, "horizontal", owner("right-top")); topology.commitSplit();
    const rightTop = topology.snapshot().focusedPaneId;
    topology.stageSplit(rightTop, "vertical", owner("right-bottom")); topology.commitSplit();
    const rightBottom = topology.snapshot().focusedPaneId;
    topology.focus(rightTop);
    expect(topology.focusDirection("down")).toMatchObject({ ok: true, snapshot: { focusedPaneId: rightBottom } });
    expect(topology.focusDirection("left")).toMatchObject({ ok: true, snapshot: { focusedPaneId: left } });
  });

  it("Close Other Pane retains the requested pane and detaches every other owner", () => {
    const topology = new PaneTopology(owner("one"));
    const first = topology.snapshot().focusedPaneId;
    topology.stageSplit(first, "horizontal", owner("two")); topology.commitSplit();
    const second = topology.snapshot().focusedPaneId;
    topology.stageSplit(second, "vertical", owner("three")); topology.commitSplit();
    expect(topology.unsplit(second)).toMatchObject({
      ok: true,
      snapshot: { paneCount: 1, focusedPaneId: second },
      effect: { kind: "detached", ownerIds: [owner("one"), owner("three")] },
    });
    expect(topology.unsplit(second)).toEqual({ ok: false, reason: "Cannot close last pane" });
  });

  it("rejects stale owners and concurrent staged splits", () => {
    const topology = new PaneTopology(owner("one"));
    const first = topology.snapshot().focusedPaneId;
    topology.stageSplit(first, "horizontal", owner("two"));
    expect(topology.stageSplit(first, "vertical", owner("three"))).toEqual({ ok: false, reason: "Split already staged" });
    topology.rollbackSplit();
    expect(topology.stageSplit(999 as PaneId, "vertical", owner("bad"))).toEqual({ ok: false, reason: "Stale pane owner" });
  });
});
