export interface ApplicationMenuOwnerBinding {
  close(): void;
  dispose(): void;
}

export interface ApplicationMenuOwnerOptions {
  readonly menu: HTMLElement;
  readonly onCommand: (actionId: string) => void;
}

/**
 * Owns the application-menu disclosure state. The menu contents are replaced on
 * every shell render, so all event handling is delegated from the durable nav.
 */
export function bindApplicationMenuOwner({ menu, onCommand }: ApplicationMenuOwnerOptions): ApplicationMenuOwnerBinding {
  let openMenu: HTMLDetailsElement | undefined;
  let disposed = false;

  const ownedDetails = (target: EventTarget | null): HTMLDetailsElement | undefined => {
    const details = target instanceof Element ? target.closest("details") : undefined;
    return details instanceof HTMLDetailsElement && details.parentElement === menu ? details : undefined;
  };
  const currentOpenMenu = (): HTMLDetailsElement | undefined => {
    if (openMenu !== undefined && (!openMenu.isConnected || openMenu.parentElement !== menu || !openMenu.open)) openMenu = undefined;
    return openMenu;
  };
  const close = (restoreFocus = false): void => {
    const details = currentOpenMenu();
    openMenu = undefined;
    if (details === undefined) return;
    details.open = false;
    if (!restoreFocus || !details.isConnected) return;
    const summary = details.querySelector(":scope > summary");
    if (summary instanceof HTMLElement && summary.isConnected) summary.focus({ preventScroll: true });
  };
  const onToggle = (event: Event): void => {
    const details = ownedDetails(event.target);
    if (details === undefined) return;
    if (!details.open) {
      if (openMenu === details) openMenu = undefined;
      return;
    }
    const previous = currentOpenMenu();
    if (previous !== undefined && previous !== details) previous.open = false;
    openMenu = details;
  };
  const onClick = (event: MouseEvent): void => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-menu-command]") : null;
    if (button === null || !menu.contains(button) || ownedDetails(button) === undefined || button.disabled) return;
    const actionId = button.dataset.menuCommand;
    if (actionId === undefined) return;
    close();
    onCommand(actionId);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || currentOpenMenu() === undefined) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close(true);
  };
  const onPointerDown = (event: PointerEvent): void => {
    const details = currentOpenMenu();
    if (details !== undefined && !(event.target instanceof Node && details.contains(event.target))) close();
  };
  const onBlur = (): void => close();

  menu.addEventListener("toggle", onToggle, true);
  menu.addEventListener("click", onClick);
  window.addEventListener("keydown", onKeyDown, { capture: true });
  document.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("blur", onBlur);
  return {
    close: () => close(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      close();
      menu.removeEventListener("toggle", onToggle, true);
      menu.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("blur", onBlur);
    },
  };
}
