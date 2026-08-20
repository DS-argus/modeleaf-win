import { describe, expect, it } from "vitest";
import { adoptChooserSnapshot, chooserRows, createOpenChooser, retainChooserFailure, updateChooserQuery } from "../../../src/ui/OpenChooserModel";

const entry = (n: number, displayName = `${n}.pdf`) => ({ recentId: `recent-${n.toString(16).padStart(32, "0")}`, displayName });
describe("OpenChooserModel", () => {
  it("projects Browse first from a prepared snapshot without a loading frame", () => {
    const model = createOpenChooser({ tag: "READY", snapshot: { revision: "2", entries: [entry(1), entry(2)] } });
    expect(chooserRows(model).map((row) => row.kind)).toEqual(["browse", "recent", "recent"]);
  });
  it("retains unavailable state and chooser-owned diagnostics", () => {
    const initial = createOpenChooser({ tag: "STATE_UNAVAILABLE", reason: "STATE_INVALID_JSON" });
    const model = retainChooserFailure(initial, initial.generation, "State unavailable");
    expect(chooserRows(model)).toEqual([{ kind: "browse", label: "Browse..." }]);
    expect(model.diagnostic).toBe("State unavailable");
  });
  it("rejects stale generation and revision snapshots", () => {
    const model = createOpenChooser({ tag: "READY", snapshot: { revision: "3", entries: [entry(1)] } }, 4);
    expect(adoptChooserSnapshot(model, 3, { revision: "4", entries: [entry(2)] })).toBe(model);
    expect(adoptChooserSnapshot(model, 4, { revision: "2", entries: [entry(2)] })).toBe(model);
  });
  it("normalizes queries without using input as a refresh trigger", () => {
    const model = createOpenChooser({ tag: "READY", snapshot: { revision: "1", entries: [entry(1, "résumé.pdf")] } });
    const matched = updateChooserQuery(model, "rés");
    expect(chooserRows(matched)).toHaveLength(2);
    expect(matched.activeIndex).toBe(1);
    expect(chooserRows(matched)[matched.activeIndex]).toMatchObject({ kind: "recent", displayName: "résumé.pdf" });
    expect(updateChooserQuery(model, "missing").activeIndex).toBe(0);
  });
});
