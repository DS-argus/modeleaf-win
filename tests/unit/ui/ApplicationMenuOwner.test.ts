// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindApplicationMenuOwner, type ApplicationMenuOwnerBinding } from "../../../src/ui/shell/ApplicationMenuOwner";

interface SetupOptions {
  readonly canOpen?: () => boolean;
  readonly onOpen?: () => void;
}

interface MenuSection {
  readonly details: HTMLDetailsElement;
  readonly summary: HTMLElement;
  readonly commands: HTMLElement;
  readonly buttons: HTMLButtonElement[];
}

const bindings = new Set<ApplicationMenuOwnerBinding>();

afterEach(() => {
  for (const binding of bindings) binding.dispose();
  bindings.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(options: SetupOptions = {}) {
  const menu = document.createElement("nav");
  const outside = document.createElement("button");
  outside.textContent = "Outside";
  document.body.append(menu, outside);
  const command = vi.fn<(id: string) => void>();
  const onOpen = options.onOpen ?? vi.fn<() => void>();
  const binding = bindApplicationMenuOwner({ menu, onCommand: command, onOpen, ...(options.canOpen === undefined ? {} : { canOpen: options.canOpen }) });
  bindings.add(binding);

  const add = (id: string, commandIds: readonly string[] = [`${id}.command`]): MenuSection => {
    const details = document.createElement("details");
    details.dataset.menuSection = id;
    const summary = document.createElement("summary");
    summary.textContent = id;
    const commands = document.createElement("div");
    commands.className = "windows-menu-commands";
    commands.setAttribute("role", "menu");
    const buttons = commandIds.map((commandId) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.menuCommand = commandId;
      button.textContent = commandId;
      commands.append(button);
      return button;
    });
    details.append(summary, commands);
    menu.append(details);
    return { details, summary, commands, buttons };
  };

  return { menu, outside, command, onOpen, binding, add };
}

function pointer(target: EventTarget, type: "pointerover" | "pointerdown"): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function key(target: EventTarget, value: string, init: Omit<KeyboardEventInit, "key"> = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { ...init, key: value, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function box(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("ApplicationMenuOwner", () => {
  it("opens and switches direct sections on delegated summary hover without stealing focus or closing through gaps and flyouts", () => {
    const { menu, outside, onOpen, add } = setup();
    const first = add("File");
    const gap = document.createElement("span");
    menu.append(gap);
    const second = add("View");
    const summaryChild = document.createElement("span");
    second.summary.append(summaryChild);
    outside.focus();

    pointer(first.summary, "pointerover");
    expect(first.details.open).toBe(true);
    expect(second.details.open).toBe(false);
    expect(document.activeElement).toBe(outside);

    pointer(first.commands, "pointerover");
    pointer(gap, "pointerover");
    expect(first.details.open).toBe(true);

    pointer(summaryChild, "pointerover");
    expect(first.details.open).toBe(false);
    expect(second.details.open).toBe(true);
    expect(document.activeElement).toBe(outside);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("latches a hover-open section on the first pointer activation and closes on repeat click or key activation", () => {
    const { add } = setup();
    const section = add("File");

    pointer(section.summary, "pointerover");
    pointer(section.summary, "pointerdown");
    expect(section.details.open).toBe(true);
    section.summary.click();
    expect(section.details.open).toBe(true);
    section.summary.click();
    expect(section.details.open).toBe(false);

    expect(key(section.summary, "Enter").defaultPrevented).toBe(true);
    expect(section.details.open).toBe(true);
    expect(key(section.summary, " ").defaultPrevented).toBe(true);
    expect(section.details.open).toBe(false);
    key(section.summary, " ");
    expect(section.details.open).toBe(true);
    key(section.summary, "Enter");
    expect(section.details.open).toBe(false);
  });

  it("dispatches enabled pointer and keyboard commands once and never dispatches disabled commands", () => {
    const { command, add } = setup();
    const section = add("File", ["document.open", "document.print"]);

    section.summary.click();
    section.buttons[0]!.click();
    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenLastCalledWith("document.open");
    expect(section.details.open).toBe(false);

    section.summary.click();
    key(section.buttons[1]!, "Enter");
    expect(command).toHaveBeenCalledTimes(2);
    expect(command).toHaveBeenLastCalledWith("document.print");
    expect(section.details.open).toBe(false);

    section.summary.click();
    section.buttons[0]!.disabled = true;
    section.buttons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    key(section.buttons[0]!, "Enter");
    key(section.buttons[0]!, " ");
    expect(command).toHaveBeenCalledTimes(2);
    expect(section.details.open).toBe(true);

    key(section.buttons[1]!, " ", { repeat: true });
    expect(command).toHaveBeenCalledTimes(2);
    key(section.buttons[1]!, " ");
    expect(command).toHaveBeenCalledTimes(3);
    expect(command).toHaveBeenLastCalledWith("document.print");
  });

  it("navigates enabled items with Up, Down, Home, and End and wraps sections with Left and Right", () => {
    const { add } = setup();
    const first = add("File", ["disabled.first", "file.one", "file.two"]);
    const second = add("View", ["view.one", "disabled.second"]);
    first.buttons[2]!.scrollIntoView = vi.fn();
    first.buttons[0]!.disabled = true;
    second.buttons[1]!.disabled = true;
    first.summary.focus();

    key(first.summary, "ArrowDown");
    expect(first.details.open).toBe(true);
    expect(document.activeElement).toBe(first.buttons[1]);
    key(first.buttons[1]!, "ArrowDown");
    expect(document.activeElement).toBe(first.buttons[2]);
    key(first.buttons[2]!, "ArrowDown");
    expect(document.activeElement).toBe(first.buttons[1]);
    key(first.buttons[1]!, "ArrowUp");
    expect(document.activeElement).toBe(first.buttons[2]);
    key(first.buttons[2]!, "Home");
    expect(document.activeElement).toBe(first.buttons[1]);
    key(first.buttons[1]!, "End");
    expect(document.activeElement).toBe(first.buttons[2]);
    expect(first.buttons[2]!.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });

    key(first.buttons[2]!, "ArrowRight");
    expect(first.details.open).toBe(false);
    expect(second.details.open).toBe(true);
    expect(document.activeElement).toBe(second.buttons[0]);
    key(second.buttons[0]!, "ArrowLeft");
    expect(first.details.open).toBe(true);
    expect(second.details.open).toBe(false);
    expect(document.activeElement).toBe(first.buttons[1]);
  });

  it("moves between closed summaries without opening them", () => {
    const { add } = setup();
    const first = add("File");
    const second = add("View");
    first.summary.focus();

    key(first.summary, "ArrowRight");
    expect(document.activeElement).toBe(second.summary);
    expect(first.details.open).toBe(false);
    expect(second.details.open).toBe(false);
    key(second.summary, "ArrowLeft");
    expect(document.activeElement).toBe(first.summary);
  });

  it("blocks opening while unavailable and closes an existing section when reconciliation makes it unavailable", () => {
    let allowed = false;
    const canOpen = vi.fn(() => allowed);
    const onOpen = vi.fn<() => void>();
    const { binding, add } = setup({ canOpen, onOpen });
    const section = add("File");

    pointer(section.summary, "pointerover");
    section.summary.click();
    expect(key(section.summary, "Enter").defaultPrevented).toBe(true);
    expect(section.details.open).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();

    allowed = true;
    key(section.summary, " ");
    expect(section.details.open).toBe(true);
    expect(onOpen).toHaveBeenCalledOnce();
    allowed = false;
    binding.reconcile();
    expect(section.details.open).toBe(false);
  });

  it("owns reader keys while open, clears pending input on open, and restores the connected summary on Escape", () => {
    let pendingPrefix = true;
    const onOpen = vi.fn(() => { pendingPrefix = false; });
    const { add } = setup({ onOpen });
    const section = add("File");
    const pageRouter = vi.fn();
    window.addEventListener("keydown", pageRouter, true);

    pointer(section.summary, "pointerover");
    expect(pendingPrefix).toBe(false);
    for (const value of ["j", "k", "g"]) {
      const event = key(document, value);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(pageRouter).not.toHaveBeenCalled();

    const escape = key(document, "Escape");
    expect(escape.defaultPrevented).toBe(true);
    expect(pageRouter).not.toHaveBeenCalled();
    expect(section.details.open).toBe(false);
    expect(document.activeElement).toBe(section.summary);

    const unrelatedEscape = key(document, "Escape");
    expect(unrelatedEscape.defaultPrevented).toBe(false);
    expect(pageRouter).toHaveBeenCalledOnce();
    window.removeEventListener("keydown", pageRouter, true);
  });

  it("closes for Tab without cancelling native traversal and passes native Alt+F4 and Alt+Space", () => {
    const { add } = setup();
    const section = add("File");
    const pageRouter = vi.fn();
    window.addEventListener("keydown", pageRouter, true);

    section.summary.click();
    section.buttons[0]!.focus();
    const tab = key(section.buttons[0]!, "Tab");
    expect(tab.defaultPrevented).toBe(false);
    expect(section.details.open).toBe(false);
    expect(pageRouter).not.toHaveBeenCalled();

    section.summary.click();
    const altF4 = key(document, "F4", { altKey: true });
    const altSpace = key(document, " ", { altKey: true });
    expect(altF4.defaultPrevented).toBe(false);
    expect(altSpace.defaultPrevented).toBe(false);
    expect(pageRouter).toHaveBeenCalledTimes(2);
    expect(section.details.open).toBe(true);
    window.removeEventListener("keydown", pageRouter, true);
  });

  it("keeps pointers inside the menu open and closes on outside pointer, blur, and the public close API", () => {
    const { menu, outside, binding, add } = setup();
    const section = add("File");

    section.summary.click();
    pointer(section.commands, "pointerdown");
    pointer(menu, "pointerdown");
    expect(section.details.open).toBe(true);
    pointer(outside, "pointerdown");
    expect(section.details.open).toBe(false);

    section.summary.click();
    window.dispatchEvent(new Event("blur"));
    expect(section.details.open).toBe(false);
    section.summary.click();
    binding.close();
    expect(section.details.open).toBe(false);
  });

  it("repairs disabled or removed menu focus during reconciliation without stealing ordinary publication focus", () => {
    const { outside, binding, add } = setup();
    const section = add("File", ["file.one", "file.two"]);
    section.summary.click();
    section.buttons[0]!.focus();

    section.buttons[0]!.disabled = true;
    binding.reconcile();
    expect(document.activeElement).toBe(section.buttons[1]);

    section.buttons[1]!.remove();
    binding.reconcile();
    expect(document.activeElement).toBe(section.summary);

    outside.focus();
    section.buttons[0]!.disabled = false;
    binding.reconcile();
    expect(document.activeElement).toBe(outside);
    expect(section.details.open).toBe(true);
  });

  it("repairs removed-section focus to a connected summary without opening it", () => {
    const { binding, add } = setup();
    const original = add("File", ["file.one"]);
    original.summary.click();
    original.buttons[0]!.focus();
    original.details.remove();
    const replacement = add("File", ["file.one"]);

    binding.reconcile();
    expect(replacement.details.open).toBe(false);
    expect(document.activeElement).toBe(replacement.summary);
  });

  it("measures and clamps fixed flyout geometry on open, reconciliation, and resize", () => {
    vi.stubGlobal("innerWidth", 1000);
    vi.stubGlobal("innerHeight", 700);
    const { binding, add } = setup();
    const section = add("Help");
    const summaryRect = vi.spyOn(section.summary, "getBoundingClientRect").mockReturnValue(box(900, 20, 50, 22));
    const commandsRect = vi.spyOn(section.commands, "getBoundingClientRect").mockReturnValue(box(0, 0, 200, 300));

    section.summary.click();
    expect(section.commands.style.getPropertyValue("--menu-left")).toBe("794px");
    expect(section.commands.style.getPropertyValue("--menu-top")).toBe("42px");
    expect(section.commands.style.getPropertyValue("--menu-max-height")).toBe("652px");

    summaryRect.mockReturnValue(box(-20, 40, 50, 20));
    commandsRect.mockReturnValue(box(0, 0, 100, 300));
    binding.reconcile();
    expect(section.commands.style.getPropertyValue("--menu-left")).toBe("6px");
    expect(section.commands.style.getPropertyValue("--menu-top")).toBe("60px");
    expect(section.commands.style.getPropertyValue("--menu-max-height")).toBe("634px");

    summaryRect.mockReturnValue(box(300, 50, 50, 30));
    commandsRect.mockReturnValue(box(0, 0, 150, 300));
    window.dispatchEvent(new Event("resize"));
    expect(section.commands.style.getPropertyValue("--menu-left")).toBe("300px");
    expect(section.commands.style.getPropertyValue("--menu-top")).toBe("80px");
    expect(section.commands.style.getPropertyValue("--menu-max-height")).toBe("614px");

    vi.spyOn(section.details.parentElement!, "getBoundingClientRect").mockReturnValue(box(0, 0, 480, 120));
    binding.reconcile();
    expect(section.commands.style.getPropertyValue("--menu-top")).toBe("120px");
    expect(section.commands.style.getPropertyValue("--menu-max-height")).toBe("574px");
  });

  it("disposes idempotently, closes owned state, and removes delegated and capture handlers", () => {
    const { command, onOpen, binding, add } = setup();
    const section = add("File");
    const pageRouter = vi.fn();
    window.addEventListener("keydown", pageRouter, true);
    section.summary.click();

    binding.dispose();
    binding.dispose();
    expect(section.details.open).toBe(false);
    pointer(section.summary, "pointerover");
    expect(section.details.open).toBe(false);
    expect(onOpen).toHaveBeenCalledOnce();

    section.buttons[0]!.click();
    expect(command).not.toHaveBeenCalled();
    const event = key(document, "j");
    expect(event.defaultPrevented).toBe(false);
    expect(pageRouter).toHaveBeenCalledOnce();
    binding.reconcile();
    binding.close();
    window.removeEventListener("keydown", pageRouter, true);
  });
});
