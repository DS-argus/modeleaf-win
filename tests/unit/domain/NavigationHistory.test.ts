import { describe, expect, it } from "vitest";
import { NAVIGATION_HISTORY_LIMIT, NavigationHistory, type NavigationSnapshot } from "../../../src/domain/navigation/NavigationHistory";

const at = (pageIndex: number, x = pageIndex / 10, y = pageIndex / 5): NavigationSnapshot => ({ pageIndex, x, y });
const jump = (history: NavigationHistory, origin: NavigationSnapshot, target: NavigationSnapshot, cause: "page-prompt" | "search" = "page-prompt", epoch?: number) => {
  const prepared = history.prepareJump(origin, target, cause, epoch);
  if (prepared.kind !== "prepared") throw new Error(prepared.kind);
  return prepared.transaction;
};

describe("NavigationHistory", () => {
  it("prepares without mutation and commits only a verified landing within the page-space tolerance", () => {
    const history = new NavigationHistory();
    const transaction = jump(history, at(0), at(1));
    expect(history.snapshot().back).toEqual([]);
    expect(history.commit(transaction, at(1, 0.6, 0.7))).toBe("committed");
    expect(history.snapshot().back).toEqual([at(0)]);
    const failed = jump(history, at(1), at(2));
    expect(history.commit(failed, at(2, 0.701, 0.4))).toBe("failed-verification");
    expect(history.snapshot().back).toEqual([at(0)]);
  });

  it("does not commit a constrained target that resolves to the live origin", () => {
    const history = new NavigationHistory();
    const origin = at(0, 5, 6);
    const transaction = jump(history, origin, at(0, 100, 200));
    expect(history.commit(transaction, origin, origin)).toBe("same-location");
    expect(history.canBack).toBe(false);
  });
  it("excludes ordinary movement, invalid targets, and same locations", () => {
    const history = new NavigationHistory();
    for (const cause of ["ordinary-scroll", "page-next", "page-previous", "zoom", "fit", "rotation", "external-link"] as const) expect(history.prepareJump(at(0), at(1), cause).kind).toBe("excluded");
    expect(history.prepareJump(at(0), at(0, 0.5, -0.5), "page-prompt").kind).toBe("same-location");
    expect(history.prepareJump({ ...at(0), x: Number.NaN }, at(1), "page-prompt").kind).toBe("invalid");
  });

  it("peeks traversal and clears Forward only after a successful new branch", () => {
    const history = new NavigationHistory();
    history.commit(jump(history, at(0), at(1)), at(1));
    history.commit(jump(history, at(1), at(2)), at(2));
    const back = history.prepareBack(at(2))!;
    expect(history.commit(back, at(1))).toBe("committed");
    expect(history.canForward).toBe(true);
    const failedForward = history.prepareForward(at(1))!;
    expect(history.commit(failedForward, at(0))).toBe("failed-verification");
    expect(history.canForward).toBe(true);
    history.commit(jump(history, at(1), at(3)), at(3));
    expect(history.canForward).toBe(false);
  });

  it("does not move traversal stacks when a constrained restore stays at the live origin", () => {
    const history = new NavigationHistory();
    const first = at(0, 0, 0);
    const live = at(0, 10, 10);
    history.commit(jump(history, first, live), live);
    const back = history.prepareBack(live)!;
    expect(history.commit(back, live, live)).toBe("same-location");
    expect(history.canBack).toBe(true);
    expect(history.canForward).toBe(false);
  });
  it("records only the first verified distinct landing in a search epoch", () => {
    const history = new NavigationHistory();
    history.commit(jump(history, at(0), at(1), "search", 7), at(1));
    expect(history.prepareJump(at(1), at(2), "search", 7).kind).toBe("search-epoch-recorded");
  });

  it("bounds back plus live plus forward to 100 positions", () => {
    const history = new NavigationHistory();
    for (let page = 1; page <= NAVIGATION_HISTORY_LIMIT + 20; page += 1) history.commit(jump(history, at(page - 1), at(page)), at(page));
    expect(history.snapshot().back).toHaveLength(NAVIGATION_HISTORY_LIMIT - 1);
  });
});
