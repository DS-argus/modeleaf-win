import type { OutlineRow } from "../../domain/outlines/OutlineModel";
import type { TocViewState } from "./TocController";
import { TOC_ROW_HEIGHT_PX } from "./TocWidgetModel";

/**
 * Floating TOC overlay.
 *
 * The widget is created once per reader host and re-raised rather than
 * recreated, because `feature-spec.md` §8 makes "overlay sinks below the PDF
 * canvas after a tab replacement" a blocker. It also never takes focus: rows
 * are activated through pointer and accessibility APIs while keyboard input
 * stays owned by the root router.
 */
export interface TocWidgetViewOptions {
  readonly host: HTMLElement;
  readonly onActivateRow: (row: OutlineRow) => void;
}

export class TocWidgetView {
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly footer: HTMLElement;
  private readonly onActivateRow: (row: OutlineRow) => void;
  private disposed = false;

  public constructor(options: TocWidgetViewOptions) {
    this.onActivateRow = options.onActivateRow;

    this.root = document.createElement("div");
    this.root.className = "toc-widget";
    this.root.dataset.testid = "toc-widget";
    this.root.hidden = true;
    // The widget is a labelled region, not a focus trap.
    this.root.setAttribute("role", "region");
    this.root.setAttribute("aria-label", "Table of contents");

    this.list = document.createElement("div");
    this.list.className = "toc-widget-list";
    this.list.setAttribute("role", "list");

    this.footer = document.createElement("div");
    this.footer.className = "toc-widget-footer";
    this.footer.dataset.testid = "toc-widget-footer";
    // Announce the pending selector politely; it must not interrupt reading.
    this.footer.setAttribute("aria-live", "polite");

    this.root.append(this.list, this.footer);
    options.host.append(this.root);
  }

  /** Re-appends the widget so it stays above a replaced canvas. */
  public raise(): void {
    if (this.disposed) return;
    this.root.parentElement?.append(this.root);
  }

  public render(state: TocViewState): void {
    if (this.disposed) return;
    this.root.hidden = !state.open;
    if (!state.open) {
      this.list.replaceChildren();
      this.footer.textContent = "";
      return;
    }

    this.root.style.width = `${String(state.geometry.width)}px`;
    this.root.style.height = `${String(state.geometry.height)}px`;
    this.root.style.top = `${String(state.geometry.offsetTop)}px`;
    this.root.style.right = `${String(state.geometry.offsetRight)}px`;

    if (state.empty) {
      const empty = document.createElement("p");
      empty.className = "toc-widget-empty";
      empty.dataset.testid = "toc-widget-empty";
      empty.textContent = "No table of contents";
      this.list.replaceChildren(empty);
      this.footer.textContent = "";
      return;
    }

    this.list.replaceChildren(...state.rows.map((entry) => this.renderRow(entry.row, entry.indentPx, entry.isCurrent)));
    this.footer.textContent = state.pendingSelector.length > 0 ? state.pendingSelector : "";
  }

  private renderRow(row: OutlineRow, indentPx: number, isCurrent: boolean): HTMLElement {
    const item = document.createElement("div");
    item.className = "toc-widget-row";
    item.style.height = `${String(TOC_ROW_HEIGHT_PX)}px`;
    item.dataset.rowId = row.id;
    if (isCurrent) item.dataset.current = "true";

    const selector = document.createElement("span");
    selector.className = "toc-widget-selector";
    selector.textContent = row.selector ?? "";
    selector.setAttribute("aria-hidden", "true");

    const title = document.createElement("button");
    title.type = "button";
    title.className = "toc-widget-title";
    title.style.paddingLeft = `${String(indentPx)}px`;
    title.textContent = row.title;
    // Narrator must read an enabled row as a pressable button and a disabled
    // row as disabled, so the state is carried by the button itself.
    title.disabled = !row.enabled;
    if (!row.enabled) title.setAttribute("aria-disabled", "true");
    if (isCurrent) title.setAttribute("aria-current", "true");
    title.setAttribute("aria-label", row.selector === undefined ? row.title : `${row.selector}. ${row.title}`);
    // The widget never steals PDF focus; rows are reachable by screen reader
    // navigation and pointer, not by Tab from the reader surface.
    title.tabIndex = -1;
    if (row.enabled) {
      title.addEventListener("click", (event) => {
        event.preventDefault();
        this.onActivateRow(row);
      });
    }

    item.setAttribute("role", "listitem");
    item.append(selector, title);
    return item;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.remove();
  }
}
