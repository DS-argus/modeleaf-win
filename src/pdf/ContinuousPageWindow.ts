export interface PageMetric {
  readonly width: number;
  readonly height: number;
}

export interface PageGeometry extends PageMetric {
  readonly pageNumber: number;
  readonly top: number;
}

export interface DocumentGeometry extends PageMetric {}

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
  readonly measuredMetrics: readonly (readonly [number, PageMetric])[];
}
export interface ViewportPageRange {
  /** Undefined only when this window has no pages. */
  readonly firstVisiblePage: number | undefined;
  /** Undefined only when this window has no pages. */
  readonly lastVisiblePage: number | undefined;
}

export interface ContinuousPageWindowOptions {
  readonly pageCount: number;
  readonly estimatedPageWidth?: number;
  readonly estimatedPageHeight: number;
  readonly pageGap: number;
  readonly maxResidentPages: number;
  readonly overscanPages: number;
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
  private readonly estimatedPageWidth: number;
  private readonly estimatedPageHeight: number;
  private readonly pageGap: number;
  private readonly maxResidentPages: number;
  private readonly overscanPages: number;
  /** Layout metadata is document-scoped and deliberately independent of raster residency. */
  private readonly measuredMetrics = new Map<number, PageMetric>();
  private planned = new Set<number>();
  private resident = new Set<number>();
  private readonly inFlight = new Map<number, number>();
  private generation = 0;

  public constructor(options: ContinuousPageWindowOptions) {
    this.pageCount = nonNegativeInteger(options.pageCount, "pageCount");
    this.estimatedPageWidth = positiveFinite(options.estimatedPageWidth ?? 1, "estimatedPageWidth");
    this.estimatedPageHeight = positiveFinite(options.estimatedPageHeight, "estimatedPageHeight");
    this.pageGap = nonNegativeInteger(options.pageGap, "pageGap");
    this.maxResidentPages = Math.max(1, nonNegativeInteger(options.maxResidentPages, "maxResidentPages"));
    this.overscanPages = nonNegativeInteger(options.overscanPages, "overscanPages");
  }

  public updateMetric(pageNumber: number, metric: PageMetric): void {
    this.updateMetrics([{ pageNumber, metric }]);
  }

  /** Validates a geometry batch before publishing any of it. */
  public updateMetrics(updates: readonly { readonly pageNumber: number; readonly metric: PageMetric }[]): void {
    const validated = updates.map(({ pageNumber, metric }) => {
      this.assertPage(pageNumber);
      return Object.freeze({
        pageNumber,
        metric: Object.freeze({
          width: positiveFinite(metric.width, "metric.width"),
          height: positiveFinite(metric.height, "metric.height"),
        }),
      });
    });
    for (const { pageNumber, metric } of validated) this.measuredMetrics.set(pageNumber, metric);
  }

  public checkpoint(): PageWindowCheckpoint {
    return Object.freeze({
      plannedPages: Object.freeze([...this.planned].sort((a, b) => a - b)),
      residentPages: Object.freeze([...this.resident].sort((a, b) => a - b)),
      measuredMetrics: Object.freeze([...this.measuredMetrics.entries()].map(([page, metric]) =>
        Object.freeze([page, Object.freeze({ ...metric })] as const))),
    });
  }

  public restore(checkpoint: PageWindowCheckpoint, physicallyResidentPages: readonly number[] = checkpoint.residentPages): PageWindowPlan {
    for (const page of [...checkpoint.plannedPages, ...checkpoint.residentPages, ...physicallyResidentPages]) this.assertPage(page);
    const checkpointResidents = new Set(checkpoint.residentPages);
    const physicalResidents = new Set(physicallyResidentPages);
    if (physicalResidents.size !== physicallyResidentPages.length) throw new Error("Physical resident pages must be unique");
    for (const page of physicalResidents) {
      if (!checkpointResidents.has(page)) throw new Error(`Page ${page} is not in the checkpoint`);
    }
    const metrics = checkpoint.measuredMetrics.map(([page, metric]) => {
      this.assertPage(page);
      return Object.freeze([page, Object.freeze({
        width: positiveFinite(metric.width, "measured width"),
        height: positiveFinite(metric.height, "measured height"),
      })] as const);
    });

    this.planned = new Set(checkpoint.plannedPages);
    this.resident = physicalResidents;
    this.inFlight.clear();
    this.measuredMetrics.clear();
    for (const [page, metric] of metrics) this.measuredMetrics.set(page, metric);
    this.generation += 1;
    return this.currentPlan(checkpoint.residentPages.filter((page) => !this.resident.has(page)));
  }

  /** Clears CSS page metrics after a scale or rotation change. */
  public resetMetricsForTransform(): readonly number[] {
    const invalidated = [...this.resident].sort((a, b) => a - b);
    this.measuredMetrics.clear();
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
  public previewPlan(firstVisiblePage: number, lastVisiblePage = firstVisiblePage, overscanPages = this.overscanPages): PageWindowPlan {
    if (this.pageCount === 0) return this.emptyPlan(this.generation);
    const pages = this.pagesForViewport(firstVisiblePage, lastVisiblePage, overscanPages);
    const next = new Set(pages);
    const samePlan = setsEqual(next, this.planned);
    return this.describePlan(
      pages,
      samePlan ? this.generation : this.generation + 1,
      pages.filter((page) => !this.resident.has(page) && (!samePlan || !this.inFlight.has(page))),
      [...this.resident].filter((page) => !next.has(page)).sort((a, b) => a - b),
    );
  }

  public plan(firstVisiblePage: number, lastVisiblePage = firstVisiblePage, overscanPages = this.overscanPages): PageWindowPlan {
    if (this.pageCount === 0) {
      this.planned.clear();
      this.resident.clear();
      this.inFlight.clear();
      this.generation += 1;
      return this.emptyPlan(this.generation);
    }
    const pages = this.pagesForViewport(firstVisiblePage, lastVisiblePage, overscanPages);
    const next = new Set(pages);
    if (!setsEqual(next, this.planned)) {
      this.generation += 1;
      this.inFlight.clear();
    }
    const materializePages = pages.filter((page) => !this.resident.has(page) && !this.inFlight.has(page));
    const evictPages = [...this.resident].filter((page) => !next.has(page)).sort((a, b) => a - b);
    this.planned = next;
    return this.describePlan(pages, this.generation, materializePages, evictPages);
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

    const documentHeight = this.documentGeometry().height;
    const start = Math.min(Math.max(0, scrollTop), documentHeight);
    const end = Math.min(documentHeight, start + viewportHeight);
    let firstVisiblePage: number | undefined;
    let lastVisiblePage: number | undefined;
    let nearestPage = 1;
    let nearestDistance = Number.POSITIVE_INFINITY;

    let pageTop = 0;
    for (let pageNumber = 1; pageNumber <= this.pageCount; pageNumber += 1) {
      const geometry = { top: pageTop, height: this.measuredMetrics.get(pageNumber)?.height ?? this.estimatedPageHeight };
      pageTop += geometry.height + this.pageGap;
      const bottom = geometry.top + geometry.height;
      if (bottom > start && geometry.top < end) {
        firstVisiblePage ??= pageNumber;
        lastVisiblePage = pageNumber;
      }

      const distance = bottom < start
        ? start - bottom
        : geometry.top > end
          ? geometry.top - end
          : 0;
      if (distance < nearestDistance) {
        nearestPage = pageNumber;
        nearestDistance = distance;
      }
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

  public pageGeometry(pageNumber: number): PageGeometry {
    this.assertPage(pageNumber);
    const metric = this.measuredMetrics.get(pageNumber);
    return Object.freeze({
      pageNumber,
      top: this.offsetForPage(pageNumber),
      width: metric?.width ?? this.estimatedPageWidth,
      height: metric?.height ?? this.estimatedPageHeight,
    });
  }

  public documentGeometry(): DocumentGeometry {
    if (this.pageCount === 0) return Object.freeze({ width: 0, height: 0 });
    let width = this.estimatedPageWidth;
    let height = this.pageCount * this.estimatedPageHeight + (this.pageCount - 1) * this.pageGap;
    for (const metric of this.measuredMetrics.values()) {
      width = Math.max(width, metric.width);
      height += metric.height - this.estimatedPageHeight;
    }
    return Object.freeze({ width, height: Math.max(0, height) });
  }

  public offsetForPage(pageNumber: number): number {
    this.assertPage(pageNumber);
    let offset = (pageNumber - 1) * (this.estimatedPageHeight + this.pageGap);
    for (const [page, metric] of this.measuredMetrics) {
      if (page >= pageNumber) continue;
      offset += metric.height - this.estimatedPageHeight;
    }
    return Math.max(0, offset);
  }
  private pagesForViewport(firstVisiblePage: number, lastVisiblePage: number, overscanPages: number): number[] {
    this.assertPage(firstVisiblePage);
    this.assertPage(lastVisiblePage);
    const firstVisible = Math.min(firstVisiblePage, lastVisiblePage);
    const lastVisible = Math.max(firstVisiblePage, lastVisiblePage);
    const pages = Array.from({ length: lastVisible - firstVisible + 1 }, (_unused, index) => firstVisible + index);
    const overscan = Math.min(this.overscanPages, nonNegativeInteger(overscanPages, "overscanPages"));
    for (let distance = 1; distance <= overscan; distance += 1) {
      if (firstVisible - distance >= 1) pages.unshift(firstVisible - distance);
      if (lastVisible + distance <= this.pageCount) pages.push(lastVisible + distance);
    }
    return pages;
  }

  private currentPlan(materializePages: readonly number[]): PageWindowPlan {
    const pages = [...this.planned].sort((a, b) => a - b);
    return this.describePlan(pages, this.generation, materializePages, []);
  }

  private describePlan(
    pages: readonly number[],
    generation: number,
    materializePages: readonly number[],
    evictPages: readonly number[],
  ): PageWindowPlan {
    if (pages.length === 0) return this.emptyPlan(generation);
    const first = pages[0]!;
    const last = pages.at(-1)!;
    const lastGeometry = this.pageGeometry(last);
    return {
      generation,
      plannedPages: pages,
      residentPages: [...this.resident].sort((a, b) => a - b),
      materializePages,
      evictPages,
      topSpacer: this.offsetForPage(first),
      bottomSpacer: Math.max(0, this.documentGeometry().height - lastGeometry.top - lastGeometry.height),
    };
  }

  private emptyPlan(generation: number): PageWindowPlan {
    return { generation, plannedPages: [], residentPages: [], materializePages: [], evictPages: [], topSpacer: 0, bottomSpacer: 0 };
  }

  private assertPage(pageNumber: number): void {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > this.pageCount) {
      throw new Error(`Page ${pageNumber} is outside 1-${this.pageCount}`);
    }
  }
}
