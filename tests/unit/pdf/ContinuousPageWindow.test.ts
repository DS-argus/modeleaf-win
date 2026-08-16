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
  it("plans a visible range with at most two pages of overscan on either side", () => {
    const model = windowModel();

    expect(model.plan(10)).toMatchObject({
      plannedPages: [8, 9, 10, 11, 12],
      residentPages: [],
      materializePages: [8, 9, 10, 11, 12],
      evictPages: [],
    });
  });

  it("retries failed or cancelled materializations until they are published", () => {
    const model = windowModel();
    const initial = model.plan(10);
    expect(model.plan(10).materializePages).toEqual([]);

    initial.materializePages.forEach((page) => model.fail(page, initial.generation));
    const retry = model.plan(10);
    expect(retry.materializePages).toEqual([8, 9, 10, 11, 12]);

    model.publish(8, retry.generation);
    expect(model.plan(10)).toMatchObject({
      residentPages: [8],
      materializePages: [],
    });
  });
  it("invalidates residents and rejects stale completions after a transform reset", () => {
    const model = windowModel();
    const plan = model.plan(10);
    model.publish(10, plan.generation);

    expect(model.resetMetricsForTransform()).toEqual([10]);
    expect(() => model.publish(9, plan.generation)).toThrow(/stale/i);
    expect(model.plan(10).materializePages).toEqual([8, 9, 10, 11, 12]);
  });
  it("marks only successfully published pages resident and deterministically evicts distant pages", () => {
    const model = windowModel();
    const initial = model.plan(1);
    expect(initial.plannedPages).toEqual([1, 2, 3]);
    initial.plannedPages.forEach((page) => model.publish(page, initial.generation));

    expect(model.plan(1)).toMatchObject({
      residentPages: [1, 2, 3],
      materializePages: [],
    });

    const moved = model.plan(10);
    expect(moved).toMatchObject({
      plannedPages: [8, 9, 10, 11, 12],
      residentPages: [1, 2, 3],
      materializePages: [8, 9, 10, 11, 12],
      evictPages: [1, 2, 3],
    });
    moved.evictPages.forEach((page) => model.unpublish(page));
    expect(model.plan(10).residentPages).toEqual([]);
  });

  it("clears stale metrics for scale or rotation changes while retaining CSS metrics for DPR-only changes", () => {
    const model = windowModel({ maxRememberedMetrics: 5 });
    model.updateMetric(1, { width: 80, height: 150 });
    model.updateMetric(2, { width: 80, height: 120 });

    // A DPR-only backing-store change leaves CSS layout metrics valid.
    expect(model.offsetForPage(3)).toBe(290);

    model.resetMetricsForTransform(); // scale change
    expect(model.offsetForPage(3)).toBe(220);

    model.updateMetric(1, { width: 80, height: 140 });
    model.resetMetricsForTransform(); // rotation change
    expect(model.offsetForPage(3)).toBe(220);
  });

  it("uses bounded measured metrics for stable spacer and far-page offsets", () => {
    const model = windowModel({ maxRememberedMetrics: 5 });
    model.updateMetric(1, { width: 80, height: 150 });
    model.updateMetric(2, { width: 80, height: 120 });

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
    expect(() => model.publish(1, 0)).toThrow(/stale/i);

    const initialPlan = model.plan(1);
    initialPlan.plannedPages.forEach((page) => model.publish(page, initialPlan.generation));
    const moved = model.plan(4);
    expect(() => model.publish(3, moved.generation)).toThrow(/capacity/i);
  });
});
