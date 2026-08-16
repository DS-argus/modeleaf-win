import { describe, expect, it } from "vitest";
import { ContinuousPageWindow } from "../../../src/pdf/ContinuousPageWindow";

function windowModel(overrides: Partial<ConstructorParameters<typeof ContinuousPageWindow>[0]> = {}) {
  return new ContinuousPageWindow({
    pageCount: 20,
    estimatedPageHeight: 100,
    pageGap: 10,
    maxResidentPages: 5,
    overscanPages: 2,
    ...overrides,
  });
}

describe("ContinuousPageWindow", () => {
  it("materializes a bounded visible window and deterministically evicts distant pages", () => {
    const model = windowModel();
    expect(model.plan(1)).toMatchObject({
      residentPages: [1, 2, 3],
      materializePages: [1, 2, 3],
      evictPages: [],
      topSpacer: 0,
    });

    const moved = model.plan(10);
    expect(moved.residentPages).toEqual([8, 9, 10, 11, 12]);
    expect(moved.materializePages).toEqual([8, 9, 10, 11, 12]);
    expect(moved.evictPages).toEqual([1, 2, 3]);
    expect(moved.residentPages).toHaveLength(5);
  });

  it("uses bounded measured metrics for stable spacer and far-page offsets", () => {
    const model = windowModel({ maxRememberedMetrics: 5 });
    model.updateMetric(1, { width: 80, height: 150 });
    model.updateMetric(2, { width: 80, height: 120 });

    expect(model.offsetForPage(3)).toBe(290);
    const plan = model.plan(5);
    expect(plan.topSpacer).toBe(290);
    expect(plan.bottomSpacer).toBeGreaterThan(0);
  });

  it("selects the page containing the viewport center, then the nearest page", () => {
    const model = windowModel();
    const geometry = [
      { pageNumber: 4, top: 0, bottom: 100 },
      { pageNumber: 5, top: 110, bottom: 210 },
      { pageNumber: 6, top: 220, bottom: 320 },
    ];

    expect(model.pageNearestViewportCenter(geometry, 170)).toBe(5);
    expect(model.pageNearestViewportCenter(geometry, 215)).toBe(5);
    expect(model.pageNearestViewportCenter(geometry, 218)).toBe(6);
  });

  it("fails closed when the visible range exceeds capacity or page identity is invalid", () => {
    const model = windowModel({ maxResidentPages: 2 });
    expect(() => model.plan(2, 4)).toThrow(/capacity/i);
    expect(() => model.plan(0)).toThrow(/outside/i);
    expect(() => model.updateMetric(21, { width: 10, height: 10 })).toThrow(/outside/i);
  });
});
