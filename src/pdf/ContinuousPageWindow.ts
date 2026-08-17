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
export interface PageWindowCheckpoint {
  readonly plannedPages: readonly number[];
  readonly residentPages: readonly number[];
  readonly measuredHeights: readonly (readonly [number, number])[];
}
export interface ViewportPageRange {
  /** Undefined only when this window has no pages. */
  readonly firstVisiblePage: number | undefined;
  /** Undefined only when this window has no pages. */
  readonly lastVisiblePage: number | undefined;
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

  public checkpoint(): PageWindowCheckpoint {
    return Object.freeze({
      plannedPages: Object.freeze([...this.planned].sort((a, b) => a - b)),
      residentPages: Object.freeze([...this.resident].sort((a, b) => a - b)),
      measuredHeights: Object.freeze([...this.measuredHeights.entries()].map((entry) => Object.freeze(entry))),
    });
  }

  public restore(checkpoint: PageWindowCheckpoint, physicallyResidentPages: readonly number[] = checkpoint.residentPages): PageWindowPlan {
    for (const page of [...checkpoint.plannedPages, ...checkpoint.residentPages]) this.assertPage(page);
    this.planned = new Set(checkpoint.plannedPages);
    for (const page of physicallyResidentPages) {
      this.assertPage(page);
      if (!checkpoint.residentPages.includes(page)) throw new Error(`Page ${page} is not in the checkpoint`);
    }
    this.resident = new Set(physicallyResidentPages);
    this.inFlight.clear();
    this.measuredHeights.clear();
    for (const [page, height] of checkpoint.measuredHeights) {
      this.assertPage(page);
      this.measuredHeights.set(page, positiveFinite(height, "measured height"));
    }
    this.generation += 1;
    const pages = [...this.planned].sort((a, b) => a - b);
    if (pages.length === 0) return { generation: this.generation, plannedPages: [], residentPages: [], materializePages: [], evictPages: [], topSpacer: 0, bottomSpacer: 0 };
    const first = pages[0]!;
    const last = pages.at(-1)!;
    return {
      generation: this.generation,
      plannedPages: pages,
      residentPages: [...this.resident].sort((a, b) => a - b),
      materializePages: checkpoint.residentPages.filter((page) => !this.resident.has(page)),
      evictPages: [],
      topSpacer: this.offsetForPage(first),
      bottomSpacer: Math.max(0, this.totalHeight() - this.offsetForPage(last) - this.heightForPage(last)),
    };
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

  /** Begins one planned materialization without claiming unstarted siblings. */
  public begin(pageNumber: number, generation: number): void {
    this.assertPage(pageNumber);
    if (generation !== this.generation) throw new Error(`Page ${pageNumber} materialization is stale`);
    if (!this.planned.has(pageNumber)) throw new Error(`Page ${pageNumber} is not in the current plan`);
    if (this.resident.has(pageNumber) || this.inFlight.has(pageNumber)) return;
    this.inFlight.set(pageNumber, generation);
  }

  /** Records a completed materialization for a page in the current plan. */
  public publish(pageNumber: number, generation: number): void {
    this.assertPage(pageNumber);
    if (generation !== this.generation || this.inFlight.get(pageNumber) !== generation) {
      throw new Error(`Page ${pageNumber} materialization is stale`);
    }
    if (!this.planned.has(pageNumber)) throw new Error(`Page ${pageNumber} is not in the current plan`);
    if (!this.resident.has(pageNumber) && this.resident.size >= Math.max(this.maxResidentPages, this.planned.size)) {
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

  /** Describes a prospective window without changing generation, ownership, or in-flight work. */
  public previewPlan(firstVisiblePage: number, lastVisiblePage = firstVisiblePage): PageWindowPlan {
    if (this.pageCount === 0) return { generation: this.generation, plannedPages: [], residentPages: [], materializePages: [], evictPages: [], topSpacer: 0, bottomSpacer: 0 };
    this.assertPage(firstVisiblePage);
    this.assertPage(lastVisiblePage);
    const firstVisible = Math.min(firstVisiblePage, lastVisiblePage);
    const lastVisible = Math.max(firstVisiblePage, lastVisiblePage);
    const pages: number[] = [];
    for (let page = firstVisible; page <= lastVisible; page += 1) pages.push(page);
    for (let distance = 1; distance <= this.overscanPages; distance += 1) {
      const before = firstVisible - distance;
      const after = lastVisible + distance;
      if (before >= 1) pages.unshift(before);
      if (after <= this.pageCount) pages.push(after);
    }
    const next = new Set(pages);
    const samePlan = setsEqual(next, this.planned);
    const firstResident = pages[0]!;
    const lastResident = pages.at(-1)!;
    return {
      generation: samePlan ? this.generation : this.generation + 1,
      plannedPages: pages,
      residentPages: [...this.resident].sort((a, b) => a - b),
      materializePages: pages.filter((page) => !this.resident.has(page) && (!samePlan || !this.inFlight.has(page))),
      evictPages: [...this.resident].filter((page) => !next.has(page)).sort((a, b) => a - b),
      topSpacer: this.offsetForPage(firstResident),
      bottomSpacer: Math.max(0, this.totalHeight() - this.offsetForPage(lastResident) - this.heightForPage(lastResident)),
    };
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
    const pages: number[] = [];
    for (let page = firstVisible; page <= lastVisible; page += 1) pages.push(page);
    for (let distance = 1; distance <= this.overscanPages; distance += 1) {
      const before = firstVisible - distance;
      const after = lastVisible + distance;
      if (before >= 1) pages.unshift(before);
      if (after <= this.pageCount) pages.push(after);
    }
    const next = new Set(pages);
    if (!setsEqual(next, this.planned)) {
      this.generation += 1;
      this.inFlight.clear();
    }
    const materializePages = pages.filter((page) => !this.resident.has(page) && !this.inFlight.has(page));
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

  /**
   * Maps a finite scroll interval to the pages with positive-area viewport
   * intersection. A gap-only or zero-height interval chooses its nearest page
   * so callers always have a stable page target for a non-empty document.
   */
  public visibleRangeForViewport(scrollTop: number, viewportHeight: number): ViewportPageRange {
    if (!Number.isFinite(scrollTop)) throw new Error("scrollTop must be finite");
    if (!Number.isFinite(viewportHeight) || viewportHeight < 0) {
      throw new Error("viewportHeight must be a non-negative finite number");
    }
    if (this.pageCount === 0) return { firstVisiblePage: undefined, lastVisiblePage: undefined };

    const documentHeight = this.totalHeight();
    const start = Math.min(Math.max(0, scrollTop), documentHeight);
    const end = Math.min(documentHeight, start + viewportHeight);
    let firstVisiblePage: number | undefined;
    let lastVisiblePage: number | undefined;
    let nearestPage = 1;
    let nearestDistance = Number.POSITIVE_INFINITY;
    let top = 0;

    for (let pageNumber = 1; pageNumber <= this.pageCount; pageNumber += 1) {
      const bottom = top + this.heightForPage(pageNumber);
      if (bottom > start && top < end) {
        firstVisiblePage ??= pageNumber;
        lastVisiblePage = pageNumber;
      }

      const distance = bottom < start
        ? start - bottom
        : top > end
          ? top - end
          : 0;
      if (distance < nearestDistance) {
        nearestPage = pageNumber;
        nearestDistance = distance;
      }
      top = bottom + this.pageGap;
    }

    if (firstVisiblePage === undefined || lastVisiblePage === undefined) {
      return { firstVisiblePage: nearestPage, lastVisiblePage: nearestPage };
    }
    return { firstVisiblePage, lastVisiblePage };
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
