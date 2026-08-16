export interface PageMetric {
  readonly width: number;
  readonly height: number;
}

export interface PageWindowPlan {
  readonly generation: number;
  /** Pages requested for the current viewport, whether or not they are rendered yet. */
  readonly plannedPages: readonly number[];
  /** Pages whose materialization has been successfully published. */
  readonly residentPages: readonly number[];
  readonly materializePages: readonly number[];
  readonly evictPages: readonly number[];
  readonly topSpacer: number;
  readonly bottomSpacer: number;
}

export interface VisiblePageGeometry {
  readonly pageNumber: number;
  readonly top: number;
  readonly bottom: number;
}

export interface ContinuousPageWindowOptions {
  readonly pageCount: number;
  readonly estimatedPageHeight: number;
  readonly pageGap: number;
  readonly maxResidentPages: number;
  readonly overscanPages: number;
  readonly maxRememberedMetrics?: number;
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function setsEqual(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  return left.size === right.size && [...left].every((page) => right.has(page));
}
export class ContinuousPageWindow {
  private readonly pageCount: number;
  private readonly estimatedPageHeight: number;
  private readonly pageGap: number;
  private readonly maxResidentPages: number;
  private readonly overscanPages: number;
  private readonly maxRememberedMetrics: number;
  private readonly measuredHeights = new Map<number, number>();
  private planned = new Set<number>();
  private resident = new Set<number>();
  private readonly inFlight = new Map<number, number>();
  private generation = 0;

  public constructor(options: ContinuousPageWindowOptions) {
    this.pageCount = nonNegativeInteger(options.pageCount, "pageCount");
    this.estimatedPageHeight = positiveFinite(options.estimatedPageHeight, "estimatedPageHeight");
    this.pageGap = nonNegativeInteger(options.pageGap, "pageGap");
    this.maxResidentPages = Math.max(1, nonNegativeInteger(options.maxResidentPages, "maxResidentPages"));
    this.overscanPages = nonNegativeInteger(options.overscanPages, "overscanPages");
    this.maxRememberedMetrics = Math.max(
      this.maxResidentPages,
      nonNegativeInteger(options.maxRememberedMetrics ?? 256, "maxRememberedMetrics"),
    );
  }

  public updateMetric(pageNumber: number, metric: PageMetric): void {
    this.assertPage(pageNumber);
    positiveFinite(metric.width, "metric.width");
    const height = positiveFinite(metric.height, "metric.height");
    this.measuredHeights.delete(pageNumber);
    this.measuredHeights.set(pageNumber, height);
    while (this.measuredHeights.size > this.maxRememberedMetrics) {
      const oldest = this.measuredHeights.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.measuredHeights.delete(oldest);
    }
  }

  /** Clears CSS page metrics after a scale or rotation change. */
  public resetMetricsForTransform(): readonly number[] {
    const invalidated = [...this.resident].sort((a, b) => a - b);
    this.measuredHeights.clear();
    this.resident.clear();
    this.inFlight.clear();
    this.generation += 1;
    return invalidated;
  }

  /** Records a completed materialization for a page in the current plan. */
  public publish(pageNumber: number, generation: number): void {
    this.assertPage(pageNumber);
    if (generation !== this.generation || this.inFlight.get(pageNumber) !== generation) {
      throw new Error(`Page ${pageNumber} materialization is stale`);
    }
    if (!this.planned.has(pageNumber)) throw new Error(`Page ${pageNumber} is not in the current plan`);
    if (!this.resident.has(pageNumber) && this.resident.size >= this.maxResidentPages) {
      throw new Error("Resident page capacity exceeded");
    }
    this.inFlight.delete(pageNumber);
    this.resident.add(pageNumber);
  }

  public fail(pageNumber: number, generation: number): void {
    this.assertPage(pageNumber);
    if (this.inFlight.get(pageNumber) === generation) this.inFlight.delete(pageNumber);
  }

  /** Records that the page's published backing has been released. */
  public unpublish(pageNumber: number): void {
    this.assertPage(pageNumber);
    this.resident.delete(pageNumber);
  }

  public plan(firstVisiblePage: number, lastVisiblePage = firstVisiblePage): PageWindowPlan {
    if (this.pageCount === 0) {
      this.planned.clear();
      this.resident.clear();
      this.inFlight.clear();
      this.generation += 1;
      return { generation: this.generation, plannedPages: [], residentPages: [], materializePages: [], evictPages: [], topSpacer: 0, bottomSpacer: 0 };
    }
    this.assertPage(firstVisiblePage);
    this.assertPage(lastVisiblePage);
    const firstVisible = Math.min(firstVisiblePage, lastVisiblePage);
    const lastVisible = Math.max(firstVisiblePage, lastVisiblePage);
    const visibleCount = lastVisible - firstVisible + 1;
    if (visibleCount > this.maxResidentPages) throw new Error("Visible page range exceeds resident page capacity");

    const pages: number[] = [];
    for (let page = firstVisible; page <= lastVisible; page += 1) pages.push(page);
    for (let distance = 1; pages.length < this.maxResidentPages; distance += 1) {
      let added = false;
      const before = firstVisible - distance;
      const after = lastVisible + distance;
      if (distance <= this.overscanPages && before >= 1 && pages.length < this.maxResidentPages) {
        pages.unshift(before);
        added = true;
      }
      if (distance <= this.overscanPages && after <= this.pageCount && pages.length < this.maxResidentPages) {
        pages.push(after);
        added = true;
      }
      if (!added || distance >= this.overscanPages) break;
    }

    const next = new Set(pages);
    if (!setsEqual(next, this.planned)) {
      this.generation += 1;
      this.inFlight.clear();
    }
    const materializePages = pages.filter((page) => !this.resident.has(page) && !this.inFlight.has(page));
    for (const page of materializePages) this.inFlight.set(page, this.generation);
    const evictPages = [...this.resident].filter((page) => !next.has(page)).sort((a, b) => a - b);
    this.planned = next;
    const firstResident = pages[0]!;
    const lastResident = pages.at(-1)!;
    return {
      generation: this.generation,
      plannedPages: pages,
      residentPages: [...this.resident].sort((a, b) => a - b),
      materializePages,
      evictPages,
      topSpacer: this.offsetForPage(firstResident),
      bottomSpacer: Math.max(0, this.totalHeight() - this.offsetForPage(lastResident) - this.heightForPage(lastResident)),
    };
  }

  public pageNearestViewportCenter(geometry: readonly VisiblePageGeometry[], viewportCenter: number): number | undefined {
    if (!Number.isFinite(viewportCenter) || geometry.length === 0) return undefined;
    let nearest: VisiblePageGeometry | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const page of geometry) {
      this.assertPage(page.pageNumber);
      if (!Number.isFinite(page.top) || !Number.isFinite(page.bottom) || page.bottom < page.top) continue;
      if (viewportCenter >= page.top && viewportCenter <= page.bottom) return page.pageNumber;
      const distance = Math.min(Math.abs(viewportCenter - page.top), Math.abs(viewportCenter - page.bottom));
      if (distance < nearestDistance || (distance === nearestDistance && page.pageNumber < (nearest?.pageNumber ?? Number.POSITIVE_INFINITY))) {
        nearest = page;
        nearestDistance = distance;
      }
    }
    return nearest?.pageNumber;
  }

  public offsetForPage(pageNumber: number): number {
    this.assertPage(pageNumber);
    let offset = (pageNumber - 1) * (this.estimatedPageHeight + this.pageGap);
    for (const [page, height] of this.measuredHeights) {
      if (page >= pageNumber) continue;
      offset += height - this.estimatedPageHeight;
    }
    return Math.max(0, offset);
  }

  private heightForPage(pageNumber: number): number {
    return this.measuredHeights.get(pageNumber) ?? this.estimatedPageHeight;
  }

  private totalHeight(): number {
    if (this.pageCount === 0) return 0;
    let total = this.pageCount * this.estimatedPageHeight + (this.pageCount - 1) * this.pageGap;
    for (const height of this.measuredHeights.values()) total += height - this.estimatedPageHeight;
    return Math.max(0, total);
  }

  private assertPage(pageNumber: number): void {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > this.pageCount) {
      throw new Error(`Page ${pageNumber} is outside 1-${this.pageCount}`);
    }
  }
}
