export interface CopyContextMenuOptions {
  readonly readerHost: HTMLElement;
  readonly writeText: (text: string) => Promise<void>;
}

export interface CopyContextMenuBinding {
  dispose(): void;
}

/** Binds the reader's intentionally limited, app-owned context menu. */
export function bindCopyContextMenu(options: CopyContextMenuOptions): CopyContextMenuBinding {
  const { readerHost, writeText } = options;
  const ownerDocument = readerHost.ownerDocument;
  let menu: HTMLDivElement | undefined;
  let invoker: HTMLElement | undefined;
  let disposed = false;

  const close = (restoreFocus: boolean): void => {
    if (!menu) return;
    menu.remove();
    menu = undefined;
    const focusTarget = invoker;
    invoker = undefined;
    if (restoreFocus && isConnectedReaderInvoker(focusTarget, readerHost)) focusTarget.focus();
  };

  const onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    if (disposed) return;
    close(false);
    const selectedText = readerSelectionText(ownerDocument, readerHost);
    if (selectedText === undefined) return;
    invoker = event.target instanceof HTMLElement && readerHost.contains(event.target) ? event.target : undefined;
    menu = createMenu(ownerDocument, event.clientX, event.clientY, () => {
      close(true);
      try { void Promise.resolve(writeText(selectedText)).catch(() => undefined); }
      catch { /* Clipboard failure is non-fatal after the app-owned menu closes. */ }
    });
    ownerDocument.body.append(menu);
    menu.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !menu) return;
    event.preventDefault();
    close(true);
  };
  const onPointerDown = (event: PointerEvent): void => {
    if (menu && event.target instanceof Node && !menu.contains(event.target)) close(true);
  };

  readerHost.addEventListener("contextmenu", onContextMenu);
  ownerDocument.addEventListener("keydown", onKeyDown);
  ownerDocument.addEventListener("pointerdown", onPointerDown, true);
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      readerHost.removeEventListener("contextmenu", onContextMenu);
      ownerDocument.removeEventListener("keydown", onKeyDown);
      ownerDocument.removeEventListener("pointerdown", onPointerDown, true);
      close(true);
    },
  };
}

function readerSelectionText(ownerDocument: Document, readerHost: HTMLElement): string | undefined {
  const selection = ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  if (!readerHost.contains(selection.anchorNode) || !readerHost.contains(selection.focusNode)) return undefined;
  const text = selection.toString();
  return text.length === 0 ? undefined : text;
}

function createMenu(ownerDocument: Document, x: number, y: number, onCopy: () => void): HTMLDivElement {
  const menu = ownerDocument.createElement("div");
  menu.className = "reader-context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Reader context menu");
  menu.style.position = "fixed";
  menu.style.left = `${Math.max(0, x)}px`;
  menu.style.top = `${Math.max(0, y)}px`;
  const copy = ownerDocument.createElement("button");
  copy.className = "reader-context-copy";
  copy.type = "button";
  copy.setAttribute("role", "menuitem");
  copy.textContent = "Copy";
  copy.addEventListener("click", onCopy, { once: true });
  menu.append(copy);
  return menu;
}

function isConnectedReaderInvoker(invoker: HTMLElement | undefined, readerHost: HTMLElement): invoker is HTMLElement {
  return invoker !== undefined && invoker.isConnected && readerHost.contains(invoker);
}
