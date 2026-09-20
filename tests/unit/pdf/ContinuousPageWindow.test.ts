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

  it("previews a direct window without mutating committed generation or ownership", () => {
    const model = windowModel();
    const initial = model.plan(1);
    for (const page of initial.plannedPages) { model.begin(page, initial.generation); model.publish(page, initial.generation); }
    const checkpoint = model.checkpoint();

    expect(model.previewPlan(10)).toMatchObject({ plannedPages: [8, 9, 10, 11, 12], residentPages: [1, 2, 3], evictPages: [1, 2, 3] });
    expect(model.checkpoint()).toEqual(checkpoint);
  });

  it("retries only explicitly begun failed or cancelled materializations", () => {
    const model = windowModel();
    const initial = model.plan(10);
    initial.materializePages.forEach((page) => model.begin(page, initial.generation));
    expect(model.plan(10).materializePages).toEqual([]);

    initial.materializePages.forEach((page) => model.fail(page, initial.generation));
    const retry = model.plan(10);
    expect(retry.materializePages).toEqual([8, 9, 10, 11, 12]);
    retry.materializePages.forEach((page) => model.begin(page, retry.generation));
    model.publish(8, retry.generation);
    expect(model.plan(10)).toMatchObject({ residentPages: [8], materializePages: [] });
  });

  it("invalidates residents and rejects stale completions after a transform reset", () => {
    const model = windowModel();
    const plan = model.plan(10);
    model.begin(10, plan.generation);
    model.publish(10, plan.generation);
    expect(model.resetMetricsForTransform()).toEqual([10]);
    expect(() => model.publish(9, plan.generation)).toThrow(/stale/i);
    expect(model.plan(10).materializePages).toEqual([8, 9, 10, 11, 12]);
  });

  it("marks only successfully published pages resident and deterministically evicts distant pages", () => {
    const model = windowModel();
    const initial = model.plan(1);
    expect(initial.plannedPages).toEqual([1, 2, 3]);
    initial.plannedPages.forEach((page) => {
      model.begin(page, initial.generation);
      model.publish(page, initial.generation);
    });
    expect(model.plan(1)).toMatchObject({ residentPages: [1, 2, 3], materializePages: [] });
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

  it("restores a committed planner checkpoint after a failed transition", () => {
    const model = windowModel();
    const initial = model.plan(1);
    initial.materializePages.forEach((page) => {
      model.begin(page, initial.generation);
      model.publish(page, initial.generation);
    });
    const checkpoint = model.checkpoint();
    const moved = model.plan(10);
    model.begin(10, moved.generation);
    model.publish(10, moved.generation);
    expect(model.restore(checkpoint)).toMatchObject({
      plannedPages: [1, 2, 3],
      residentPages: [1, 2, 3],
      materializePages: [],
    });
    expect(() => model.publish(10, moved.generation)).toThrow(/stale/i);
  });

  it("clears stale metrics for scale or rotation changes while retaining CSS metrics for DPR-only changes", () => {
    const model = windowModel();
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

  it("uses retained document metrics for stable spacer and far-page offsets", () => {
    const model = windowModel();
    model.updateMetric(1, { width: 80, height: 150 });
    model.updateMetric(2, { width: 80, height: 120 });

    const plan = model.plan(5);
    expect(plan.topSpacer).toBe(290);
    expect(plan.bottomSpacer).toBeGreaterThan(0);
  });

  it("maps page and gap boundaries using positive-area intersection", () => {
    const model = windowModel();

    expect(model.visibleRangeForViewport(0, 100)).toEqual({ firstVisiblePage: 1, lastVisiblePage: 1 });
    expect(model.visibleRangeForViewport(95, 20)).toEqual({ firstVisiblePage: 1, lastVisiblePage: 2 });
    expect(model.visibleRangeForViewport(100, 11)).toEqual({ firstVisiblePage: 2, lastVisiblePage: 2 });
    expect(model.visibleRangeForViewport(100, 10)).toEqual({ firstVisiblePage: 1, lastVisiblePage: 1 });
  });

  it("maps heterogeneous measurements and clamps zero-height or far viewports", () => {
    const model = windowModel();
    model.updateMetric(1, { width: 80, height: 150 });
    model.updateMetric(2, { width: 80, height: 50 });

    expect(model.visibleRangeForViewport(155, 10)).toEqual({ firstVisiblePage: 2, lastVisiblePage: 2 });
    expect(model.visibleRangeForViewport(165, 0)).toEqual({ firstVisiblePage: 2, lastVisiblePage: 2 });
    expect(model.visibleRangeForViewport(-100, 10)).toEqual({ firstVisiblePage: 1, lastVisiblePage: 1 });
    expect(model.visibleRangeForViewport(100_000, 10)).toEqual({ firstVisiblePage: 20, lastVisiblePage: 20 });
    expect(() => model.visibleRangeForViewport(Number.NaN, 10)).toThrow(/scrollTop/i);
    expect(() => model.visibleRangeForViewport(0, Number.POSITIVE_INFINITY)).toThrow(/viewportHeight/i);
    expect(() => model.visibleRangeForViewport(0, -1)).toThrow(/viewportHeight/i);
  });

  it("maps a 300-page viewport into a capacity-bounded overscan plan", () => {
    const model = windowModel({ pageCount: 300, maxResidentPages: 6 });
    const visible = model.visibleRangeForViewport(149 * 110, 205);
    const plan = model.plan(visible.firstVisiblePage!, visible.lastVisiblePage!);

    expect(visible).toEqual({ firstVisiblePage: 150, lastVisiblePage: 151 });
    expect(plan.plannedPages).toEqual([148, 149, 150, 151, 152, 153]);
    expect(plan.plannedPages).toHaveLength(6);
    expect(plan.plannedPages.every((page) => page >= 148 && page <= 153)).toBe(true);
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

  it("always admits visible pages beyond the overscan preference and rejects invalid identities", () => {
    const model = windowModel({ maxResidentPages: 2 });
    const wide = model.plan(2, 4);
    expect(wide.plannedPages).toEqual([1, 2, 3, 4, 5, 6]);
    wide.materializePages.forEach((page) => {
      model.begin(page, wide.generation);
      model.publish(page, wide.generation);
    });
    expect(model.plan(2, 4).residentPages).toEqual([1, 2, 3, 4, 5, 6]);
    expect(() => model.plan(0)).toThrow(/outside/i);
    expect(() => model.updateMetric(21, { width: 10, height: 10 })).toThrow(/outside/i);
    expect(() => model.begin(20, wide.generation)).toThrow(/not in the current plan/i);
    expect(() => model.publish(1, 0)).toThrow(/stale/i);
  });
  it("retains measured page geometry after more than 256 raster windows", () => {
    const model = windowModel({ pageCount: 300 });
    model.updateMetric(1, { width: 80, height: 150 });
    const offset = model.offsetForPage(300);
    const height = model.documentGeometry().height;
    for (let page = 2; page <= 299; page += 1) {
      model.updateMetric(page, { width: 80, height: 100 });
      model.plan(page);
    }
    expect(model.offsetForPage(300)).toBe(offset);
    expect(model.documentGeometry().height).toBe(height);
    expect(model.pageGeometry(1).height).toBe(150);
  });
  it("reduces only optional overscan and preserves planning generations", () => {
    const model = windowModel();
    const initial = model.plan(10, 11);
    for (const page of initial.materializePages) { model.begin(page, initial.generation); model.publish(page, initial.generation); }
    const preview = model.previewPlan(10, 11, 0);
    expect(preview.plannedPages).toEqual([10, 11]);
    expect(preview.evictPages).toEqual([8, 9, 12, 13]);
    expect(model.checkpoint().plannedPages).toEqual([8, 9, 10, 11, 12, 13]);
    const reduced = model.plan(10, 11, 0);
    expect(reduced.generation).toBeGreaterThan(initial.generation);
    expect(reduced.materializePages).toEqual([]);
    expect(model.plan(10, 11, 0).generation).toBe(reduced.generation);
    expect(model.previewPlan(10, 11, 1).plannedPages).toEqual([9, 10, 11, 12]);
    expect(model.previewPlan(10, 11, 99).plannedPages).toEqual([8, 9, 10, 11, 12, 13]);
    expect(() => model.plan(10, 11, -1)).toThrow("overscanPages");
  });
});
