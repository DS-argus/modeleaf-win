import type { Action } from "./Action";

export type ZoomMode = "custom" | "fit-width" | "fit-page";
const DEFAULT_SCALE = 1.25;
const MIN_SCALE = 0.1;
const MAX_SCALE = 8;

export interface PendingScrollIntent {
  readonly horizontalCssPixels: number;
  readonly verticalCssPixels: number;
  readonly viewportFactor: number;
}

export interface ReaderSnapshot {
  readonly hasDocument: boolean;
  readonly page: number;
  readonly pageCount: number;
  readonly documentGeneration: number;
  readonly helpVisible: boolean;
  readonly zoomMode: ZoomMode;
  readonly customScale: number;
  readonly rotationQuarterTurns: number;
  readonly pendingScroll: PendingScrollIntent;
  readonly status: string;
}

export class ReaderState {
  private statusSource: "search" | undefined;
  private snapshotValue: ReaderSnapshot = {
    hasDocument: false,
    page: 0,
    pageCount: 0,
    documentGeneration: 0,
    helpVisible: false,
    zoomMode: "fit-width",
    customScale: DEFAULT_SCALE,
    rotationQuarterTurns: 0,
    pendingScroll: {
      horizontalCssPixels: 0,
      verticalCssPixels: 0,
      viewportFactor: 0,
    },
    status: "No document open",
  };

  get snapshot(): ReaderSnapshot {
    return this.snapshotValue;
  }

  mountDocument(pageCount: number): void {
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
      throw new RangeError("pageCount must be a positive safe integer");
    }
    this.statusSource = undefined;
    this.snapshotValue = {
      ...this.snapshotValue,
      hasDocument: true,
      page: 1,
      pageCount,
      documentGeneration: this.snapshotValue.documentGeneration + 1,
      zoomMode: "fit-width",
      customScale: DEFAULT_SCALE,
      rotationQuarterTurns: 0,
      pendingScroll: this.emptyScrollIntent(),
      status: this.pageStatus(1, pageCount, "fit-width", DEFAULT_SCALE, 0),
    };
  }

  closeDocument(): void {
    this.statusSource = undefined;
    this.snapshotValue = {
      ...this.snapshotValue,
      hasDocument: false,
      page: 0,
      pageCount: 0,
      documentGeneration: this.snapshotValue.documentGeneration + 1,
      zoomMode: "fit-width",
      customScale: DEFAULT_SCALE,
      rotationQuarterTurns: 0,
      pendingScroll: this.emptyScrollIntent(),
      status: "No document open",
    };
  }

  apply(action: Action): void {
    switch (action.type) {
      case "document.open":
        this.setStatus("Open PDF requested");
        break;
      case "page.next":
        this.navigateTo(this.snapshotValue.page + 1);
        break;
      case "page.previous":
        this.navigateTo(this.snapshotValue.page - 1);
        break;
      case "page.first":
        this.navigateTo(1);
        break;
      case "page.last":
        this.navigateTo(this.snapshotValue.pageCount);
        break;
      case "page.goTo":
        this.navigateTo(action.page);
        break;
      case "scroll.byCssPixels":
        this.addCssScroll(action.axis, action.delta);
        break;
      case "scroll.byViewport":
        this.addViewportScroll(action.factor);
        break;
      case "view.fitWidth":
        this.setZoomMode("fit-width");
        break;
      case "view.fitPage":
        this.setZoomMode("fit-page");
        break;
      case "view.zoom":
        this.zoomBy(action.factor);
        break;
      case "view.actualSize":
        this.setActualSize();
        break;
      case "view.rotate":
        this.rotateBy(action.quarterTurns);
        break;
      case "help.toggle":
        this.snapshotValue = {
          ...this.snapshotValue,
          helpVisible: !this.snapshotValue.helpVisible,
        };
        break;
      case "prompt.open":
        this.setStatus("Go to page");
        break;
      case "prompt.cancel":
        if (this.snapshotValue.helpVisible) {
          this.snapshotValue = { ...this.snapshotValue, helpVisible: false };
        }
        this.refreshPageStatus();
        break;
    }
  }

  consumePendingScroll(): PendingScrollIntent {
    const pendingScroll = this.snapshotValue.pendingScroll;
    this.snapshotValue = {
      ...this.snapshotValue,
      pendingScroll: this.emptyScrollIntent(),
    };
    return pendingScroll;
  }
  restoreView(view: Pick<ReaderSnapshot, "zoomMode" | "customScale" | "rotationQuarterTurns">): void {
    if (!this.snapshotValue.hasDocument) return;
    this.snapshotValue = {
      ...this.snapshotValue,
      zoomMode: view.zoomMode,
      customScale: Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.customScale)),
      rotationQuarterTurns: ((view.rotationQuarterTurns % 4) + 4) % 4,
    };
    this.refreshPageStatus();
  }

  setStatus(status: string, source?: "search"): void {
    this.statusSource = source;
    this.snapshotValue = { ...this.snapshotValue, status };
  }

  clearSearchStatus(): boolean {
    if (this.statusSource !== "search") return false;
    this.refreshPageStatus();
    return true;
  }

  private navigateTo(requestedPage: number): void {
    if (!this.snapshotValue.hasDocument) {
      return;
    }
    const page = Math.max(1, Math.min(this.snapshotValue.pageCount, requestedPage));
    this.statusSource = undefined;
    this.snapshotValue = {
      ...this.snapshotValue,
      page,
      status: this.pageStatus(
        page,
        this.snapshotValue.pageCount,
        this.snapshotValue.zoomMode,
        this.snapshotValue.customScale,
        this.snapshotValue.rotationQuarterTurns,
      ),
    };
  }

  private addCssScroll(axis: "horizontal" | "vertical", delta: number): void {
    if (!this.snapshotValue.hasDocument || !Number.isFinite(delta)) {
      return;
    }
    const pendingScroll = this.snapshotValue.pendingScroll;
    this.snapshotValue = {
      ...this.snapshotValue,
      pendingScroll: {
        ...pendingScroll,
        horizontalCssPixels: pendingScroll.horizontalCssPixels
          + (axis === "horizontal" ? delta : 0),
        verticalCssPixels: pendingScroll.verticalCssPixels
          + (axis === "vertical" ? delta : 0),
      },
    };
  }

  private addViewportScroll(factor: number): void {
    if (!this.snapshotValue.hasDocument || !Number.isFinite(factor)) {
      return;
    }
    this.snapshotValue = {
      ...this.snapshotValue,
      pendingScroll: {
        ...this.snapshotValue.pendingScroll,
        viewportFactor: this.snapshotValue.pendingScroll.viewportFactor + factor,
      },
    };
  }

  private setZoomMode(zoomMode: ZoomMode): void {
    if (!this.snapshotValue.hasDocument) {
      return;
    }
    this.snapshotValue = {
      ...this.snapshotValue,
      zoomMode,
    };
    this.refreshPageStatus();
  }

  private zoomBy(factor: number): void {
    if (!this.snapshotValue.hasDocument || !Number.isFinite(factor) || factor <= 0) {
      return;
    }
    const customScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.snapshotValue.customScale * factor));
    this.snapshotValue = {
      ...this.snapshotValue,
      zoomMode: "custom",
      customScale,
    };
    this.refreshPageStatus();
  }

  private setActualSize(): void {
    if (!this.snapshotValue.hasDocument) {
      return;
    }
    this.snapshotValue = {
      ...this.snapshotValue,
      zoomMode: "custom",
      customScale: 1,
    };
    this.refreshPageStatus();
  }

  private rotateBy(quarterTurns: number): void {
    if (!this.snapshotValue.hasDocument || !Number.isFinite(quarterTurns)) {
      return;
    }
    const rotationQuarterTurns = (
      (this.snapshotValue.rotationQuarterTurns + quarterTurns) % 4 + 4
    ) % 4;
    this.snapshotValue = {
      ...this.snapshotValue,
      rotationQuarterTurns,
    };
    this.refreshPageStatus();
  }

  private emptyScrollIntent(): PendingScrollIntent {
    return {
      horizontalCssPixels: 0,
      verticalCssPixels: 0,
      viewportFactor: 0,
    };
  }

  private pageStatus(
    page: number,
    pageCount: number,
    zoomMode: ZoomMode,
    customScale: number,
    rotationQuarterTurns: number,
  ): string {
    const zoom = zoomMode === "custom"
      ? `Custom ${this.formatScale(customScale)}`
      : zoomMode === "fit-width" ? "Fit width" : "Fit page";
    return `Page ${page} of ${pageCount} · ${zoom} · ${rotationQuarterTurns * 90}°`;
  }

  private formatScale(scale: number): string {
    return `${Number((scale * 100).toFixed(2))}%`;
  }

  private refreshPageStatus(): void {
    this.setStatus(this.snapshotValue.hasDocument
      ? this.pageStatus(
        this.snapshotValue.page,
        this.snapshotValue.pageCount,
        this.snapshotValue.zoomMode,
        this.snapshotValue.customScale,
        this.snapshotValue.rotationQuarterTurns,
      )
      : "No document open");
  }
}
