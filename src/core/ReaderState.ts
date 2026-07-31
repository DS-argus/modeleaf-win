import type { Action } from "./Action";

export interface ReaderSnapshot {
  readonly hasDocument: boolean;
  readonly page: number;
  readonly pageCount: number;
  readonly documentGeneration: number;
  readonly helpVisible: boolean;
  readonly status: string;
}

export class ReaderState {
  private snapshotValue: ReaderSnapshot = {
    hasDocument: false,
    page: 0,
    pageCount: 0,
    documentGeneration: 0,
    helpVisible: false,
    status: "No document open",
  };

  get snapshot(): ReaderSnapshot {
    return this.snapshotValue;
  }

  mountDocument(pageCount: number): void {
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
      throw new RangeError("pageCount must be a positive safe integer");
    }
    this.snapshotValue = {
      ...this.snapshotValue,
      hasDocument: true,
      page: 1,
      pageCount,
      documentGeneration: this.snapshotValue.documentGeneration + 1,
      status: `Page 1 of ${pageCount}`,
    };
  }

  closeDocument(): void {
    this.snapshotValue = {
      ...this.snapshotValue,
      hasDocument: false,
      page: 0,
      pageCount: 0,
      documentGeneration: this.snapshotValue.documentGeneration + 1,
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

  setStatus(status: string): void {
    this.snapshotValue = { ...this.snapshotValue, status };
  }

  private navigateTo(requestedPage: number): void {
    if (!this.snapshotValue.hasDocument) {
      return;
    }
    const page = Math.max(1, Math.min(this.snapshotValue.pageCount, requestedPage));
    this.snapshotValue = {
      ...this.snapshotValue,
      page,
      status: `Page ${page} of ${this.snapshotValue.pageCount}`,
    };
  }

  private refreshPageStatus(): void {
    this.setStatus(this.snapshotValue.hasDocument
      ? `Page ${this.snapshotValue.page} of ${this.snapshotValue.pageCount}`
      : "No document open");
  }
}
