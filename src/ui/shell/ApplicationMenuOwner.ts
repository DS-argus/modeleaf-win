export interface ApplicationMenuOwnerBinding {
  close(): void;
  reconcile(): void;
  dispose(): void;
}

export interface ApplicationMenuOwnerOptions {
  readonly menu: HTMLElement;
  readonly onCommand: (actionId: string) => void;
  readonly canOpen?: () => boolean;
  readonly onOpen?: () => void;
}

type OpenMethod = "hover" | "pointer" | "keyboard";

const VIEWPORT_MARGIN = 6;
const POINTER_BRIDGE_MARGIN = 1;

/**
 * Owns the application-menu disclosure state. The durable nav delegates events
 * so menu sections and commands can be reconciled without replacing listeners.
 */
export function bindApplicationMenuOwner({ menu, onCommand, canOpen, onOpen }: ApplicationMenuOwnerOptions): ApplicationMenuOwnerBinding {
  let openMenu: HTMLDetailsElement | undefined;
  let openMethod: OpenMethod | undefined;
  let pointerBridge: HTMLDetailsElement | undefined;
  let focusedMenuTarget: HTMLElement | undefined;
  let focusedMenuDetails: HTMLDetailsElement | undefined;
  let focusedTargetWasSummary = false;
  let disposed = false;

  const detailsSections = (): HTMLDetailsElement[] => Array.from(menu.children).filter(
    (child): child is HTMLDetailsElement => child instanceof HTMLDetailsElement,
  );
  const summaryFor = (details: HTMLDetailsElement): HTMLElement | undefined => {
    const summary = details.querySelector(":scope > summary");
    return summary instanceof HTMLElement ? summary : undefined;
  };
  const flyoutFor = (details: HTMLDetailsElement): HTMLElement | undefined => {
    const flyout = details.querySelector(":scope > .windows-menu-commands");
    return flyout instanceof HTMLElement ? flyout : undefined;
  };
  const ownedDetails = (target: EventTarget | null): HTMLDetailsElement | undefined => {
    const details = target instanceof Element ? target.closest("details") : undefined;
    return details instanceof HTMLDetailsElement && details.parentElement === menu ? details : undefined;
  };
  const ownedSummary = (target: EventTarget | null): { readonly details: HTMLDetailsElement; readonly summary: HTMLElement } | undefined => {
    const summary = target instanceof Element ? target.closest("summary") : undefined;
    if (!(summary instanceof HTMLElement)) return undefined;
    const details = ownedDetails(summary);
    return details !== undefined && summaryFor(details) === summary ? { details, summary } : undefined;
  };
  const ownedCommand = (target: EventTarget | null): { readonly details: HTMLDetailsElement; readonly button: HTMLButtonElement } | undefined => {
    const button = target instanceof Element ? target.closest<HTMLButtonElement>("button[data-menu-command]") : null;
    if (button === null || !menu.contains(button)) return undefined;
    const details = ownedDetails(button);
    return details === undefined ? undefined : { details, button };
  };
  const isEnabledCommand = (button: HTMLButtonElement): boolean => !button.disabled
    && !button.hidden
    && button.closest("[hidden]") === null
    && button.closest("[inert]") === null;
  const enabledCommands = (details: HTMLDetailsElement): HTMLButtonElement[] => Array.from(
    details.querySelectorAll<HTMLButtonElement>("button[data-menu-command]"),
  ).filter((button) => ownedDetails(button) === details && isEnabledCommand(button));
  const isWithinInteractiveRegion = (details: HTMLDetailsElement, target: EventTarget | null): boolean => target instanceof Node
    && (summaryFor(details)?.contains(target) === true || flyoutFor(details)?.contains(target) === true);
  const isWithinPointerBridge = (details: HTMLDetailsElement, clientX: number, clientY: number): boolean => {
    const summary = summaryFor(details);
    const flyout = flyoutFor(details);
    if (summary === undefined || flyout === undefined || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
    const summaryRect = summary.getBoundingClientRect();
    const flyoutRect = flyout.getBoundingClientRect();
    const left = Math.max(summaryRect.left, flyoutRect.left) - POINTER_BRIDGE_MARGIN;
    const right = Math.min(summaryRect.right, flyoutRect.right) + POINTER_BRIDGE_MARGIN;
    const top = Math.min(summaryRect.bottom, flyoutRect.top) - POINTER_BRIDGE_MARGIN;
    const bottom = Math.max(summaryRect.bottom, flyoutRect.top) + POINTER_BRIDGE_MARGIN;
    return left <= right && clientX >= left && clientX <= right && clientY >= top && clientY <= bottom;
  };
  const focusWithoutScroll = (target: HTMLElement | undefined): void => {
    target?.focus({ preventScroll: true });
    if (target !== undefined && ownedCommand(target) !== undefined) target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };
  const forgetTrackedFocus = (): void => {
    focusedMenuTarget = undefined;
    focusedMenuDetails = undefined;
    focusedTargetWasSummary = false;
  };
  const currentOpenMenu = (): HTMLDetailsElement | undefined => {
    if (openMenu !== undefined && (!openMenu.isConnected || openMenu.parentElement !== menu || !openMenu.open)) {
      openMenu = undefined;
      openMethod = undefined;
      pointerBridge = undefined;
    }
    return openMenu;
  };
  const synchronizeOpenState = (active: HTMLDetailsElement | undefined): void => {
    const sections = detailsSections();
    const ownedActive = active !== undefined && sections.includes(active) ? active : undefined;
    for (const section of sections) {
      const open = section === ownedActive;
      if (section.open !== open) section.open = open;
      const flyout = flyoutFor(section);
      if (flyout !== undefined) {
        flyout.hidden = !open;
        flyout.inert = !open;
      }
    }
  };
  const positionMenu = (details: HTMLDetailsElement): void => {
    const summary = summaryFor(details);
    const commands = flyoutFor(details);
    if (summary === undefined || commands === undefined) return;

    const summaryRect = summary.getBoundingClientRect();
    const flyoutWidth = Math.max(0, commands.getBoundingClientRect().width);
    const viewportWidth = Math.max(0, window.innerWidth);
    const summaryLeft = Number.isFinite(summaryRect.left) ? summaryRect.left : VIEWPORT_MARGIN;
    const top = Number.isFinite(summaryRect.bottom) ? summaryRect.bottom : 0;
    const maximumLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - flyoutWidth - VIEWPORT_MARGIN);
    const left = Math.min(Math.max(summaryLeft, VIEWPORT_MARGIN), maximumLeft);
    const maximumHeight = Math.max(0, window.innerHeight - top - VIEWPORT_MARGIN);

    commands.style.setProperty("--menu-left", `${left}px`);
    commands.style.setProperty("--menu-top", `${top}px`);
    commands.style.setProperty("--menu-max-height", `${maximumHeight}px`);
  };
  const openingAllowed = (): boolean => canOpen?.() ?? true;
  const close = (restoreFocus = false): void => {
    const trackedOpenMenu = openMenu;
    const sections = detailsSections();
    const current = currentOpenMenu();
    const trackedSection = trackedOpenMenu !== undefined && sections.includes(trackedOpenMenu) ? trackedOpenMenu : undefined;
    const closingSections = sections.filter((details) => details.open || details === trackedSection);
    const focusOwner = current ?? trackedSection ?? closingSections[0];
    openMenu = undefined;
    openMethod = undefined;
    pointerBridge = undefined;
    synchronizeOpenState(undefined);
    if (focusedMenuDetails !== undefined && closingSections.includes(focusedMenuDetails) && !focusedTargetWasSummary) forgetTrackedFocus();
    if (!restoreFocus || focusOwner === undefined || !focusOwner.isConnected) return;
    focusWithoutScroll(summaryFor(focusOwner));
  };
  const openDetails = (details: HTMLDetailsElement, method: OpenMethod): boolean => {
    if (details.parentElement !== menu) return false;
    const current = currentOpenMenu();
    if (!openingAllowed()) {
      close();
      return false;
    }
    if (current === details) {
      if (method !== "hover") openMethod = method;
      pointerBridge = undefined;
      synchronizeOpenState(details);
      positionMenu(details);
      return true;
    }
    pointerBridge = undefined;

    openMenu = details;
    openMethod = method;
    synchronizeOpenState(details);
    onOpen?.();
    if (currentOpenMenu() !== details || !openingAllowed()) {
      close();
      return false;
    }
    positionMenu(details);
    return true;
  };
  const activateSummary = (details: HTMLDetailsElement, method: Exclude<OpenMethod, "hover">): boolean => {
    if (currentOpenMenu() !== details) return openDetails(details, method);
    if (openMethod === "hover" || (method === "keyboard" && openMethod === "pointer")) {
      return openDetails(details, method);
    }
    close();
    return false;
  };
  const adjacentSection = (details: HTMLDetailsElement, offset: -1 | 1): HTMLDetailsElement | undefined => {
    const sections = detailsSections();
    const index = sections.indexOf(details);
    if (index < 0 || sections.length === 0) return undefined;
    return sections[(index + offset + sections.length) % sections.length];
  };
  const moveSection = (details: HTMLDetailsElement, offset: -1 | 1, fromCommand: boolean): void => {
    const next = adjacentSection(details, offset);
    if (next === undefined) return;
    if (currentOpenMenu() === undefined) {
      focusWithoutScroll(summaryFor(next));
      return;
    }
    if (!openDetails(next, "keyboard")) return;
    focusWithoutScroll(fromCommand ? enabledCommands(next)[0] ?? summaryFor(next) : summaryFor(next));
  };
  const moveCommandFocus = (details: HTMLDetailsElement, key: "ArrowDown" | "ArrowUp" | "Home" | "End", target: EventTarget | null): void => {
    const commands = enabledCommands(details);
    if (commands.length === 0) {
      focusWithoutScroll(summaryFor(details));
      return;
    }
    const focused = ownedCommand(target)?.button;
    const index = focused === undefined ? -1 : commands.indexOf(focused);
    let nextIndex: number;
    if (key === "Home") nextIndex = 0;
    else if (key === "End") nextIndex = commands.length - 1;
    else if (key === "ArrowDown") nextIndex = index < 0 ? 0 : (index + 1) % commands.length;
    else nextIndex = index < 0 ? commands.length - 1 : (index - 1 + commands.length) % commands.length;
    focusWithoutScroll(commands[nextIndex]);
  };
  const activateCommand = (details: HTMLDetailsElement, button: HTMLButtonElement): void => {
    if (currentOpenMenu() !== details || !isEnabledCommand(button)) return;
    if (!openingAllowed()) {
      close();
      return;
    }
    const actionId = button.dataset.menuCommand;
    if (actionId === undefined) return;
    close();
    onCommand(actionId);
  };
  const ownKey = (event: KeyboardEvent, preventDefault = true): void => {
    if (preventDefault) event.preventDefault();
    event.stopImmediatePropagation();
  };
  const isSpace = (key: string): boolean => key === " " || key === "Space" || key === "Spacebar";
  const isNativeWindowChord = (event: KeyboardEvent): boolean => event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.shiftKey
    && (event.key === "F4" || isSpace(event.key));

  const onToggle = (event: Event): void => {
    const details = ownedDetails(event.target);
    if (details === undefined) return;
    if (!details.open) {
      const wasOpenMenu = openMenu === details;
      if (wasOpenMenu) {
        openMenu = undefined;
        openMethod = undefined;
        pointerBridge = undefined;
      }
      synchronizeOpenState(currentOpenMenu());
      if (wasOpenMenu && focusedMenuDetails === details && !focusedTargetWasSummary) forgetTrackedFocus();
      return;
    }
    if (currentOpenMenu() === details) {
      synchronizeOpenState(details);
      positionMenu(details);
      return;
    }
    openDetails(details, "pointer");
  };
  const onPointerOver = (event: PointerEvent): void => {
    const owned = ownedSummary(event.target);
    if (owned === undefined) return;
    pointerBridge = undefined;
    openDetails(owned.details, "hover");
  };
  const onPointerOut = (event: PointerEvent): void => {
    const current = currentOpenMenu();
    if (current === undefined || openMethod === "keyboard") return;
    if (isWithinInteractiveRegion(current, event.relatedTarget)) {
      pointerBridge = undefined;
      return;
    }
    const nextSummary = ownedSummary(event.relatedTarget);
    if (nextSummary !== undefined && nextSummary.details !== current) {
      pointerBridge = undefined;
      openDetails(nextSummary.details, "hover");
      return;
    }
    if (!isWithinInteractiveRegion(current, event.target) && pointerBridge !== current) return;
    if (event.relatedTarget instanceof Node
      && menu.contains(event.relatedTarget)
      && isWithinPointerBridge(current, event.clientX, event.clientY)) {
      pointerBridge = current;
      return;
    }
    close();
  };
  const onPointerMove = (event: PointerEvent): void => {
    const current = currentOpenMenu();
    if (pointerBridge === undefined || current !== pointerBridge || openMethod === "keyboard") {
      pointerBridge = undefined;
      return;
    }
    const nextSummary = ownedSummary(event.target);
    if (nextSummary !== undefined && nextSummary.details !== current) {
      pointerBridge = undefined;
      openDetails(nextSummary.details, "hover");
      return;
    }
    if (isWithinInteractiveRegion(current, event.target)) {
      pointerBridge = undefined;
      return;
    }
    if (!isWithinPointerBridge(current, event.clientX, event.clientY)) close();
  };
  const onClick = (event: MouseEvent): void => {
    const summary = ownedSummary(event.target);
    if (summary !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      activateSummary(summary.details, "pointer");
      return;
    }
    const command = ownedCommand(event.target);
    if (command === undefined || command.button.disabled) return;
    activateCommand(command.details, command.button);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (isNativeWindowChord(event)) return;

    const summary = ownedSummary(event.target);
    let current = currentOpenMenu();
    if (current !== undefined && !openingAllowed()) {
      close();
      current = undefined;
    }
    if (summary !== undefined && (event.key === "Enter" || isSpace(event.key))) {
      ownKey(event);
      if (!event.repeat && activateSummary(summary.details, "keyboard")) {
        focusWithoutScroll(enabledCommands(summary.details)[0] ?? summary.summary);
      }
      return;
    }
    if (summary !== undefined && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      ownKey(event);
      if (current !== undefined || openingAllowed()) {
        moveSection(summary.details, event.key === "ArrowLeft" ? -1 : 1, false);
      }
      return;
    }
    if (summary !== undefined && (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End")) {
      ownKey(event);
      if (openDetails(summary.details, "keyboard")) moveCommandFocus(summary.details, event.key, event.target);
      return;
    }
    if (current === undefined) return;
    if (event.key === "Tab") {
      ownKey(event, false);
      close();
      return;
    }
    if (event.key === "Escape") {
      ownKey(event);
      close(true);
      return;
    }

    openMethod = "keyboard";
    pointerBridge = undefined;
    const command = ownedCommand(event.target);
    if (command !== undefined && command.details === current && (event.key === "Enter" || isSpace(event.key))) {
      ownKey(event);
      if (!event.repeat) activateCommand(command.details, command.button);
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      ownKey(event);
      moveSection(current, event.key === "ArrowLeft" ? -1 : 1, command?.details === current);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      ownKey(event);
      moveCommandFocus(current, event.key, event.target);
      return;
    }

    ownKey(event);
  };
  const onPointerDown = (event: PointerEvent): void => {
    if (currentOpenMenu() !== undefined && (!(event.target instanceof Node) || !menu.contains(event.target))) close();
  };
  const onFocusIn = (event: FocusEvent): void => {
    const details = ownedDetails(event.target);
    if (!(event.target instanceof HTMLElement) || details === undefined) {
      forgetTrackedFocus();
      return;
    }
    focusedMenuTarget = event.target;
    focusedMenuDetails = details;
    focusedTargetWasSummary = summaryFor(details) === event.target;
  };
  const onBlur = (): void => close();
  const onResize = (): void => {
    const details = currentOpenMenu();
    if (details !== undefined) positionMenu(details);
  };
  const reconcile = (): void => {
    if (disposed) return;
    const details = currentOpenMenu();
    if (details !== undefined && !openingAllowed()) {
      close();
      return;
    }
    synchronizeOpenState(details);
    if (details === undefined) {
      if (focusedMenuDetails !== undefined && (!focusedMenuDetails.isConnected || focusedMenuDetails.parentElement !== menu)) {
        forgetTrackedFocus();
        if (document.activeElement === document.body) focusWithoutScroll(detailsSections().map(summaryFor).find((summary) => summary !== undefined));
      }
      return;
    }

    positionMenu(details);
    if (focusedMenuTarget === undefined) return;
    if (focusedMenuDetails !== details) {
      if (!focusedTargetWasSummary) forgetTrackedFocus();
      return;
    }
    const targetRemainsUsable = focusedMenuTarget.isConnected
      && details.contains(focusedMenuTarget)
      && (focusedTargetWasSummary
        ? summaryFor(details) === focusedMenuTarget
        : focusedMenuTarget instanceof HTMLButtonElement
          && ownedCommand(focusedMenuTarget)?.details === details
          && isEnabledCommand(focusedMenuTarget));
    if (targetRemainsUsable) return;

    const replacement = focusedTargetWasSummary ? summaryFor(details) : enabledCommands(details)[0] ?? summaryFor(details);
    forgetTrackedFocus();
    focusWithoutScroll(replacement);
  };

  synchronizeOpenState(currentOpenMenu());
  menu.addEventListener("toggle", onToggle, true);
  menu.addEventListener("pointerover", onPointerOver);
  menu.addEventListener("pointerout", onPointerOut);
  menu.addEventListener("click", onClick);
  window.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("focusin", onFocusIn, true);
  window.addEventListener("blur", onBlur);
  window.addEventListener("resize", onResize);
  return {
    close: () => { if (!disposed) close(); },
    reconcile,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      close();
      menu.removeEventListener("toggle", onToggle, true);
      menu.removeEventListener("pointerover", onPointerOver);
      menu.removeEventListener("pointerout", onPointerOut);
      menu.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onResize);
    },
  };
}
