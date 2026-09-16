import { safeDocumentBasename, tabAccessibilitySemantics } from "../AccessibilityController";

export interface TabStripTab {
  readonly id: string;
  readonly title: string;
  readonly selected: boolean;
  readonly disabled?: boolean;
}

export interface TabStripCallbacks {
  readonly activate: (id: string) => void;
  readonly close: (id: string) => void;
}

export interface TabStripRenderer {
  render(tabs: readonly TabStripTab[]): void;
}

interface TabStripItem {
  readonly item: HTMLDivElement;
  readonly tab: HTMLButtonElement;
  readonly close: HTMLButtonElement;
}

const PDF_SUFFIX = ".pdf";

function visibleTitle(title: string): string {
  return title.length > PDF_SUFFIX.length && title.toLowerCase().endsWith(PDF_SUFFIX)
    ? title.slice(0, -PDF_SUFFIX.length)
    : title;
}

function updateItem(item: TabStripItem, tab: TabStripTab, index: number, total: number): void {
  const semantics = tabAccessibilitySemantics({ basename: tab.title, ordinal: index + 1, total, active: tab.selected });
  item.item.dataset.selected = String(tab.selected);
  item.item.dataset.index = String(index);

  item.tab.type = "button";
  item.tab.className = "workspace-tab";
  item.tab.id = `reader-tab-${tab.id}`;
  item.tab.setAttribute("role", semantics.role);
  item.tab.setAttribute("aria-label", semantics.ariaLabel);
  item.tab.setAttribute("aria-selected", semantics.ariaSelected);
  item.tab.setAttribute("aria-setsize", String(semantics.ariaSetSize));
  item.tab.setAttribute("aria-posinset", String(semantics.ariaPosInSet));
  item.tab.setAttribute("aria-controls", `reader-panel-${tab.id}`);
  item.tab.tabIndex = semantics.tabIndex;
  item.tab.disabled = tab.disabled === true;
  item.tab.textContent = visibleTitle(tab.title);
  item.tab.title = tab.title;

  const safeTitle = safeDocumentBasename(tab.title);
  item.close.type = "button";
  item.close.className = "workspace-tab-close";
  item.close.setAttribute("aria-label", `Close ${safeTitle}`);
  item.close.title = `Close ${safeTitle}`;
  item.close.textContent = "×";
}

function revealSelectedTab(container: HTMLElement, item: HTMLElement): void {
  const containerBounds = container.getBoundingClientRect();
  const itemBounds = item.getBoundingClientRect();
  if (itemBounds.left < containerBounds.left) {
    container.scrollLeft += itemBounds.left - containerBounds.left;
  } else if (itemBounds.right > containerBounds.right) {
    container.scrollLeft += itemBounds.right - containerBounds.right;
  }
}

export function createTabStripRenderer(container: HTMLElement, callbacks: TabStripCallbacks): TabStripRenderer {
  container.setAttribute("role", "tablist");
  const keyedItems = new Map<string, TabStripItem>();

  function createItem(id: string): TabStripItem {
    const tab = document.createElement("button");
    const close = document.createElement("button");
    const item = document.createElement("div");
    item.className = "workspace-tab-item";
    item.append(tab, close);
    tab.addEventListener("click", () => { callbacks.activate(id); });
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      callbacks.close(id);
    });
    return { item, tab, close };
  }
  function render(tabs: readonly TabStripTab[]): void {
    const focusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusedInContainer = focusedElement !== null && container.contains(focusedElement);
    const nextIds = new Set<string>();
    for (const [index, tab] of tabs.entries()) {
      let item = keyedItems.get(tab.id);
      if (item === undefined) {
        item = createItem(tab.id);
        keyedItems.set(tab.id, item);
      }
      updateItem(item, tab, index, tabs.length);
      nextIds.add(tab.id);
    }

    let removedFocused = false;
    for (const [id, item] of keyedItems) {
      if (nextIds.has(id)) continue;
      if (focusedInContainer && item.item.contains(focusedElement)) removedFocused = true;
      item.item.remove();
      keyedItems.delete(id);
    }

    for (const [index, tab] of tabs.entries()) {
      const item = keyedItems.get(tab.id);
      if (item === undefined) continue;
      const current = container.children[index];
      if (current !== item.item) container.insertBefore(item.item, current ?? null);
    }

    if (removedFocused) {
      const selected = tabs.find((tab) => tab.selected);
      if (selected !== undefined) keyedItems.get(selected.id)?.tab.focus({ preventScroll: true });
    } else if (focusedElement !== null && focusedInContainer && focusedElement.isConnected) {
      focusedElement.focus({ preventScroll: true });
    }

    const selected = tabs.find((tab) => tab.selected);
    if (selected !== undefined) {
      const item = keyedItems.get(selected.id);
      if (item !== undefined) revealSelectedTab(container, item.item);
    }
  }

  return { render };
}
