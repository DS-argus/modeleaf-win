import { currentOutlineRow, type OutlineRow } from "../../domain/outlines/OutlineModel";
import { OutlineSelectorInput, OUTLINE_INPUT_TIMEOUT_MS } from "../../domain/outlines/OutlineSelector";
import {
  centerRow,
  INITIAL_TOC_SCROLL,
  revealRow,
  scrollByRow,
  tocGeometry,
  visibleTocRows,
  type TocContainerSize,
  type TocGeometry,
  type TocRowView,
  type TocScrollState,
} from "./TocWidgetModel";

/**
 * Owns TOC open/closed state, the silent numeric buffer, and scroll position
 * for one tab.
 *
 * The controller is deliberately free of DOM and PDF.js types. Timing is
 * injected so the 400ms selector deadline is proven with a fake clock rather
 * than a real sleep, which `feature-spec.md` §8 requires.
 */

export interface TocNavigationTarget {
  readonly row: OutlineRow;
}

export type TocActivation =
  | { readonly kind: "navigate"; readonly row: OutlineRow }
  | { readonly kind: "rejected"; readonly reason: "disabled" | "unknown-selector" };

export interface TocViewState {
  readonly open: boolean;
  readonly rows: readonly TocRowView[];
  readonly geometry: TocGeometry;
  readonly currentRowId: string | undefined;
  readonly pendingSelector: string;
  readonly empty: boolean;
  readonly totalRows: number;
}

export interface TocPosition {
  readonly pageIndex: number;
  readonly x: number;
  readonly y: number;
}

export type TocTimerHandle = number;
export interface TocClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): TocTimerHandle;
  cancel(handle: TocTimerHandle): void;
}

export interface TocControllerOptions {
  readonly clock: TocClock;
  /** Invoked when a selector commits; the owner performs the verified jump. */
  readonly onActivate: (target: TocNavigationTarget) => void;
  /** Invoked whenever view state changes so the owner can rerender. */
  readonly onChange?: () => void;
}

export class TocController {
  private rowsValue: readonly OutlineRow[] = [];
  private openValue = false;
  private scroll: TocScrollState = INITIAL_TOC_SCROLL;
  private container: TocContainerSize = { width: 0, height: 0 };
  private selector: OutlineSelectorInput = new OutlineSelectorInput([]);
  private pendingTimer: TocTimerHandle | undefined;
  private currentRowIdValue: string | undefined;
  private lastViewportRevision = 0;

  public constructor(private readonly options: TocControllerOptions) {}

  public get isOpen(): boolean { return this.openValue; }
  public get rowCount(): number { return this.rowsValue.length; }
  public get pendingSelector(): string { return this.selector.state().buffer; }

  /**
   * Adopts a normalized outline for the active document.
   *
   * Replacing the outline cancels any pending numeric input: a buffered
   * selector refers to rows that no longer exist.
   */
  public setOutline(rows: readonly OutlineRow[]): void {
    this.rowsValue = rows;
    this.selector = new OutlineSelectorInput(rows);
    this.cancelPending();
    this.scroll = INITIAL_TOC_SCROLL;
    this.currentRowIdValue = undefined;
    this.notify();
  }

  public setContainerSize(size: TocContainerSize): void {
    if (this.container.width === size.width && this.container.height === size.height) return;
    this.container = size;
    this.notify();
  }

  /** Opens the TOC and centers the current row. Never steals PDF focus. */
  public open(): void {
    if (this.openValue) return;
    this.openValue = true;
    this.scroll = { firstVisibleRow: this.centeredFirstRow(), userScrolled: false };
    this.notify();
  }

  public close(): void {
    if (!this.openValue) return;
    this.openValue = false;
    this.cancelPending();
    this.notify();
  }

  public toggle(): void {
    if (this.openValue) this.close();
    else this.open();
  }

  /**
   * Cancels pending numeric input without closing.
   *
   * Every lifecycle event the spec lists — tab switch, document close, prompt
   * or help opening, config reload, window focus loss — routes here so a stale
   * digit can never commit into a new context.
   */
  public cancelPending(): void {
    if (this.pendingTimer !== undefined) {
      this.options.clock.cancel(this.pendingTimer);
      this.pendingTimer = undefined;
    }
    if (this.selector.state().buffer.length > 0) {
      this.selector.cancel();
      this.notify();
    }
  }

  /** Recomputes the current row from a verified viewport position. */
  public syncViewport(position: TocPosition, viewportRevision: number): void {
    const current = currentOutlineRow(this.rowsValue, position);
    const changed = current?.id !== this.currentRowIdValue;
    this.currentRowIdValue = current?.id;

    // Only a verified user movement may reveal the row; an ordinary rerender
    // must not rewind a position the user scrolled to deliberately.
    if (viewportRevision !== this.lastViewportRevision) {
      this.lastViewportRevision = viewportRevision;
      if (this.openValue && current !== undefined) {
        const index = this.rowsValue.indexOf(current);
        if (index >= 0) this.scroll = revealRow(index, this.scroll, this.rowsValue.length, this.visibleRowCount());
      }
    }
    if (changed) this.notify();
  }

  public scrollRows(direction: 1 | -1): void {
    if (!this.openValue) return;
    this.scroll = scrollByRow(direction, this.scroll, this.rowsValue.length, this.visibleRowCount());
    this.notify();
  }

  /**
   * Feeds one decimal digit into the silent selector buffer.
   *
   * An unambiguous selector commits immediately. An ambiguous prefix arms the
   * 400ms deadline, which commits the buffered selector if no further digit
   * arrives.
   */
  public appendDigit(key: string): boolean {
    if (!this.openValue) return false;
    const result = this.selector.append(key, this.options.clock.now());
    this.clearTimer();
    if (result.kind === "selected") { this.activate(result.row); return true; }
    if (result.kind === "pending") { this.armDeadline(); this.notify(); return true; }
    if (result.kind === "invalid") { this.notify(); return true; }
    this.notify();
    return true;
  }

  /** Deletes the last digit and renews the deadline. */
  public backspace(): boolean {
    if (!this.openValue) return false;
    const result = this.selector.backspace(this.options.clock.now());
    this.clearTimer();
    if (result.kind === "pending") this.armDeadline();
    this.notify();
    return true;
  }

  /** Activates a row directly, as a click or accessible press does. */
  public activateRow(row: OutlineRow): TocActivation {
    if (!row.enabled || row.destination === undefined) return { kind: "rejected", reason: "disabled" };
    this.activate(row);
    return { kind: "navigate", row };
  }

  public view(): TocViewState {
    const geometry = tocGeometry(this.container, this.rowsValue.length);
    return Object.freeze({
      open: this.openValue,
      rows: this.openValue ? visibleTocRows(this.rowsValue, this.scroll, geometry.visibleRows, this.currentRowIdValue) : Object.freeze([]),
      geometry,
      currentRowId: this.currentRowIdValue,
      pendingSelector: this.selector.state().buffer,
      empty: this.rowsValue.length === 0,
      totalRows: this.rowsValue.length,
    });
  }

  public dispose(): void {
    this.clearTimer();
    this.openValue = false;
    this.rowsValue = [];
  }

  private activate(row: OutlineRow): void {
    this.clearTimer();
    this.selector.cancel();
    if (!row.enabled || row.destination === undefined) { this.notify(); return; }
    this.options.onActivate({ row });
    this.notify();
  }

  private armDeadline(): void {
    this.pendingTimer = this.options.clock.schedule(() => {
      this.pendingTimer = undefined;
      const result = this.selector.expire(this.options.clock.now());
      if (result.kind === "selected") this.activate(result.row);
      else this.notify();
    }, OUTLINE_INPUT_TIMEOUT_MS);
  }

  private clearTimer(): void {
    if (this.pendingTimer === undefined) return;
    this.options.clock.cancel(this.pendingTimer);
    this.pendingTimer = undefined;
  }

  private visibleRowCount(): number {
    return tocGeometry(this.container, this.rowsValue.length).visibleRows;
  }

  private centeredFirstRow(): number {
    const visible = this.visibleRowCount();
    const index = this.currentRowIdValue === undefined
      ? 0
      : Math.max(0, this.rowsValue.findIndex((row) => row.id === this.currentRowIdValue));
    return centerRow(index, this.rowsValue.length, visible);
  }

  private notify(): void { this.options.onChange?.(); }
}
