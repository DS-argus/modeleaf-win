import { describe, expect, it } from "vitest";
import {
  NAVIGATION_HISTORY_LIMIT,
  NavigationHistory,
  type NavigationSnapshot,
} from "../../../src/domain/navigation/NavigationHistory";

const at = (pageIndex: number): NavigationSnapshot => ({ pageIndex, x: pageIndex / 10, y: pageIndex / 5 });
const prepared = (history: NavigationHistory, from: NavigationSnapshot, to: NavigationSnapshot, epoch?: number) => {
  const result = history.prepareJump(from, to, epoch === undefined ? "page-prompt" : "search", epoch);
  if (result.kind !== "prepared") throw new Error(`Expected prepared, got ${result.kind}`);
  return result.transaction;
};

describe("NavigationHistory", () => {
  it("mutates only after verified commit and terminally consumes failure/rollback", () => {
    const history = new NavigationHistory();
    const failed = prepared(history, at(0), at(1));
    expect(history.commit(failed, at(2))).toBe("failed-verification");
    expect(history.commit(failed, at(1))).toBe("stale");
    expect(history.snapshot().positions).toEqual([]);
    const rolledBack = prepared(history, at(0), at(1));
    expect(history.rollback(rolledBack)).toBe("rolled-back");
    expect(history.commit(rolledBack, at(1))).toBe("stale");
    const committed = prepared(history, at(0), at(1));
    expect(history.commit(committed, at(1))).toBe("committed");
    expect(history.snapshot().positions).toEqual([at(0), at(1)]);
    expect(history.commit(committed, at(1))).toBe("stale");
  });
  it("excludes ordinary movement, external URLs, invalid and same locations", () => {
    const history = new NavigationHistory();
    for (const cause of ["ordinary-scroll", "page-next", "page-previous", "zoom", "fit", "rotation", "external-link"] as const) {
      expect(history.prepareJump(at(0), at(1), cause).kind).toBe("excluded");
    }
    expect(history.prepareJump(at(0), at(0), "outline").kind).toBe("same-location");
    expect(history.prepareJump({ ...at(0), x: Number.NaN }, at(1), "outline").kind).toBe("invalid");
  });

  it("commits back/forward only after displayed-target verification and clears forward on a new jump", () => {
    const history = new NavigationHistory();
    history.commit(prepared(history, at(0), at(1)), at(1));
    history.commit(prepared(history, at(1), at(2)), at(2));
    const back = history.prepareBack()!;
    expect(history.commit(back, at(1))).toBe("committed");
    expect(history.current()).toEqual(at(1));
    expect(history.prepareForward()).toBeDefined();
    history.commit(prepared(history, at(1), at(3)), at(3));
    expect(history.prepareForward()).toBeUndefined();
    expect(history.snapshot().positions).toEqual([at(0), at(1), at(3)]);
  });

  it("records only the first successful distinct landing for each search epoch", () => {
    const history = new NavigationHistory();
    history.commit(prepared(history, at(0), at(1), 7), at(1));
    expect(history.prepareJump(at(1), at(2), "search", 7).kind).toBe("search-epoch-recorded");
    const next = history.prepareJump(at(1), at(2), "search", 8);
    expect(next.kind).toBe("prepared");
  });

  it("retains at most 100 page-space positions", () => {
    const history = new NavigationHistory();
    for (let page = 1; page <= NAVIGATION_HISTORY_LIMIT + 20; page += 1) {
      history.commit(prepared(history, at(page - 1), at(page)), at(page));
    }
    expect(history.snapshot().positions).toHaveLength(NAVIGATION_HISTORY_LIMIT);
    expect(history.current()).toEqual(at(NAVIGATION_HISTORY_LIMIT + 20));
  });
});
