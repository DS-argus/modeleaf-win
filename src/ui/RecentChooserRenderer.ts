import type { OpenChooserRow } from "./OpenChooserModel";
import { fitRecentPath } from "./RecentPathPresentation";

interface RowView {
  readonly item: HTMLLIElement;
  readonly button: HTMLButtonElement;
  readonly label: HTMLSpanElement | undefined;
  row: OpenChooserRow;
  displayPath: string;
  index: number;
}

export function createRecentChooserRenderer(list: HTMLElement, activate: (index: number) => void) {
  const document = list.ownerDocument;
  const views = new Map<string, RowView>();
  const heading = document.createElement("li");
  heading.className = "file-opener-recents-heading";
  heading.textContent = "Recent";
  heading.setAttribute("role", "heading");
  heading.setAttribute("aria-level", "2");
  const diagnostic = document.createElement("li");
  diagnostic.className = "file-opener-diagnostic";
  diagnostic.setAttribute("role", "status");
  diagnostic.setAttribute("aria-live", "polite");
  let ordered: RowView[] = [];
  let selected: RowView | undefined;
  let lastDiagnostic: string | undefined;
  let running = false;
  let observer: ResizeObserver | undefined;
  let frame: number | undefined;
  let lastWidth = -1;
  let context: CanvasRenderingContext2D | null | undefined;
  let measureProbe: HTMLSpanElement | undefined;

  const fit = () => {
    if (!running || list.clientWidth <= 0) return;
    lastWidth = list.clientWidth;
    if (!ordered.some(view => view.row.kind === "recent")) return;
    if (context === undefined) context = document.createElement("canvas").getContext("2d");
    if (context === null && measureProbe === undefined) {
      measureProbe = document.createElement("span");
      measureProbe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;white-space:pre;left:0;top:0";
      measureProbe.setAttribute("aria-hidden", "true");
      document.body.append(measureProbe);
    }
    for (const view of ordered) {
      if (view.row.kind !== "recent" || view.label === undefined) continue;
      const style = getComputedStyle(view.button);
      const available = view.button.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight) - 1;
      if (!(available > 0)) continue;
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      if (context !== null) context!.font = font;
      else measureProbe!.style.font = font;
      const fitted = fitRecentPath(view.displayPath, view.row.displayName, available, text => {
        if (context !== null) return context!.measureText(text).width;
        measureProbe!.textContent = text;
        return measureProbe!.getBoundingClientRect().width;
      });
      const text = fitted.directoryText + fitted.filenameText;
      if (view.label.textContent !== text) view.label.textContent = text;
    }
  };
  const requestFit = () => {
    if (!running || frame !== undefined) return;
    frame = requestAnimationFrame(() => { frame = undefined; fit(); });
  };
  const start = () => {
    if (running) return;
    running = true;
    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver(() => { if (list.clientWidth !== lastWidth) requestFit(); });
      observer.observe(list);
    }
    void document.fonts?.ready.then(() => { if (running) requestFit(); });
  };
  const keepSelectionVisible = () => {
    if (selected === undefined) return;
    const box = list.getBoundingClientRect(), row = selected.button.getBoundingClientRect();
    const top = row.top - box.top - list.clientTop;
    const bottom = row.bottom - box.top - list.clientTop;
    if (top < 0) list.scrollTop += top;
    else if (bottom > list.clientHeight) list.scrollTop += bottom - list.clientHeight;
  };
  return {
    render(rows: readonly OpenChooserRow[], activeIndex: number, message?: string, aliases?: ReadonlyMap<string, string>): void {
      start();
      let contentChanged = false;
      const next = rows.map((row, index) => {
        const key = row.kind === "browse" ? "browse" : row.recentId;
        const displayPath = row.kind === "recent" ? aliases?.get(row.recentId) ?? row.displayPath : "";
        let view = views.get(key);
        if (view === undefined) {
          const item = document.createElement("li");
          const button = document.createElement("button");
          button.type = "button";
          button.className = `overlay-list-entry file-opener-entry file-opener-${row.kind}`;
          const label = row.kind === "recent" ? document.createElement("span") : undefined;
          if (label !== undefined) { label.className = "file-opener-recent-path"; button.append(label); }
          else if (row.kind === "browse") { button.textContent = row.label; button.setAttribute("aria-label", "Browse for a PDF"); }
          item.append(button);
          view = { item, button, label, row, displayPath, index };
          const ownedView = view;
          button.addEventListener("click", () => activate(ownedView.index));
          views.set(key, view);
          contentChanged = true;
        }
        if (row.kind === "recent") {
          if (view.row.kind !== "recent" || view.displayPath !== displayPath || view.row.displayName !== row.displayName || view.row.displayPath !== row.displayPath) contentChanged = true;
          if (view.button.title !== row.displayPath) view.button.title = row.displayPath;
          if (view.button.getAttribute("aria-label") !== displayPath) view.button.setAttribute("aria-label", displayPath);
        }
        view.row = row; view.displayPath = displayPath; view.index = index;
        return view;
      });
      const structureChanged = next.length !== ordered.length || next.some((view, index) => view !== ordered[index]);
      const diagnosticChanged = message !== lastDiagnostic;
      if (structureChanged || diagnosticChanged) {
        const nodes: HTMLElement[] = [];
        next.forEach((view, index) => { if (index === 1) nodes.push(heading); nodes.push(view.item); });
        if (message !== undefined) { diagnostic.textContent = message; nodes.push(diagnostic); }
        list.replaceChildren(...nodes);
        const retained = new Set(next);
        for (const [key, view] of views) if (!retained.has(view)) views.delete(key);
      }
      ordered = next; lastDiagnostic = message;
      const target = ordered[activeIndex];
      if (selected !== target) {
        selected?.button.setAttribute("aria-selected", "false");
        selected?.button.setAttribute("aria-current", "false");
        selected = target;
      }
      for (const view of ordered) {
        const current = view === selected;
        if (view.button.getAttribute("aria-selected") !== String(current)) view.button.setAttribute("aria-selected", String(current));
        if (view.button.getAttribute("aria-current") !== String(current)) view.button.setAttribute("aria-current", String(current));
      }
      // New rows initially have empty labels, never oversized raw path text.
      // Fit synchronously before selection scrolling; arrow movement skips this work.
      if (structureChanged || contentChanged || diagnosticChanged || list.clientWidth !== lastWidth) fit();
      keepSelectionVisible();
    },
    requestFit,
    stop(): void {
      running = false;
      observer?.disconnect(); observer = undefined;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      lastWidth = -1;
      measureProbe?.remove(); measureProbe = undefined;
    },
  };
}
