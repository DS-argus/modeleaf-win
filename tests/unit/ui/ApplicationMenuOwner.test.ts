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
      const label = document.createElement("span");
      label.className = "windows-menu-label";
      label.textContent = commandId;
      const shortcut = document.createElement("span");
      shortcut.className = "windows-menu-shortcut";
      shortcut.textContent = "Ctrl+X";
      button.append(label, shortcut);
      commands.append(button);
      return button;
    });
    details.append(summary, commands);
    menu.append(details);
    return { details, summary, commands, buttons };
  };

  return { menu, outside, command, onOpen, binding, add };
}

function pointer(
  target: EventTarget,
  type: "pointerover" | "pointerout" | "pointerdown" | "pointermove",
  relatedTarget: EventTarget | null = null,
  init: Omit<MouseEventInit, "bubbles" | "cancelable" | "relatedTarget"> = {},
): MouseEvent {
  const event = new MouseEvent(type, { ...init, bubbles: true, cancelable: true, relatedTarget });
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

function expectOpenState(sections: readonly MenuSection[], active?: MenuSection): void {
  for (const section of sections) {
    const open = section === active;
    expect(section.details.open).toBe(open);
    expect(section.commands.hidden).toBe(!open);
    expect(section.commands.inert).toBe(!open);
  }
}

describe("ApplicationMenuOwner", () => {
  it("synchronizes explicit hidden and inert state for initial, newly reconciled, and repeatedly visited sections", () => {
    const { binding, add } = setup();
    const sections = [add("File"), add("View")];

    binding.reconcile();
    expectOpenState(sections);

    const added = add("Help");
    sections.push(added);
    binding.reconcile();
    expectOpenState(sections);

    for (let pass = 0; pass < 3; pass++) {
      for (const section of sections) {
        pointer(section.summary, "pointerover");
        expectOpenState(sections, section);
        binding.reconcile();
        expectOpenState(sections, section);
      }
      binding.close();
      expectOpenState(sections);
    }
  });

  it("opens and switches delegated summary-child hovers without stealing focus", () => {
    const { outside, onOpen, binding, add } = setup();
    const first = add("File");
    const second = add("View");
    const firstTitle = document.createElement("span");
    const secondTitle = document.createElement("span");
    first.summary.append(firstTitle);
    second.summary.append(secondTitle);
    binding.reconcile();
    outside.focus();

    pointer(firstTitle, "pointerover");
    expectOpenState([first, second], first);
    expect(document.activeElement).toBe(outside);

    pointer(secondTitle, "pointerover");
    expectOpenState([first, second], second);
    expect(document.activeElement).toBe(outside);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("keeps a pointer flyout open across direct title/flyout transitions and closes outside", () => {
    const { outside, binding, add } = setup();
    const section = add("File");
    const titleChild = document.createElement("span");
    section.summary.append(titleChild);
    const commandChild = section.buttons[0]!.querySelector(".windows-menu-label")!;
    binding.reconcile();

    pointer(titleChild, "pointerover");
    pointer(titleChild, "pointerout", commandChild);
    expectOpenState([section], section);
    pointer(commandChild, "pointerout", titleChild);
    expectOpenState([section], section);

    pointer(commandChild, "pointerout", outside);
    expectOpenState([section]);
    pointer(titleChild, "pointerover");
    pointer(titleChild, "pointerout", outside);
    expectOpenState([section]);
    pointer(titleChild, "pointerover");
    pointer(titleChild, "pointerout", null);
    expectOpenState([section]);

    pointer(titleChild, "pointerover");
    titleChild.click();
    pointer(titleChild, "pointerout", outside);
    expectOpenState([section]);
  });

  it("bridges a wrapped-nav gap until pointer movement reaches the flyout, title, another summary, or outside", () => {
    const { menu, binding, add } = setup();
    const first = add("File");
    const second = add("View");
    const gap = document.createElement("span");
    menu.append(gap);
    const firstTitle = document.createElement("span");
    const secondTitle = document.createElement("span");
    first.summary.append(firstTitle);
    second.summary.append(secondTitle);
    const commandChild = first.buttons[0]!.querySelector(".windows-menu-label")!;
    vi.spyOn(first.summary, "getBoundingClientRect").mockReturnValue(box(10, 10, 50, 20));
    vi.spyOn(first.commands, "getBoundingClientRect").mockReturnValue(box(10, 40, 150, 100));
    binding.reconcile();

    pointer(firstTitle, "pointerover");
    pointer(firstTitle, "pointerout", gap, { clientX: 20, clientY: 30 });
    pointer(gap, "pointermove", null, { clientX: 20, clientY: 35 });
    pointer(gap, "pointermove", null, { clientX: 20, clientY: 41 });
    expectOpenState([first, second], first);
    pointer(commandChild, "pointermove", null, { clientX: 20, clientY: 42 });
    expectOpenState([first, second], first);

    pointer(commandChild, "pointerout", gap, { clientX: 20, clientY: 40 });
    pointer(gap, "pointermove", null, { clientX: 20, clientY: 35 });
    pointer(firstTitle, "pointermove", null, { clientX: 20, clientY: 29 });
    expectOpenState([first, second], first);

    pointer(firstTitle, "pointerout", gap, { clientX: 20, clientY: 30 });
    pointer(gap, "pointermove", null, { clientX: 100, clientY: 35 });
    expectOpenState([first, second]);

    pointer(firstTitle, "pointerover");
    pointer(firstTitle, "pointerout", secondTitle, { clientX: 60, clientY: 20 });
    expectOpenState([first, second], second);
  });

  it("latches the first click after hover and closes on each repeat click across repeated cycles", () => {
    const { binding, add } = setup();
    const section = add("File");
    const titleChild = document.createElement("span");
    section.summary.append(titleChild);
    binding.reconcile();

    for (let pass = 0; pass < 3; pass++) {
      pointer(titleChild, "pointerover");
      pointer(titleChild, "pointerdown");
      titleChild.click();
      expectOpenState([section], section);
      titleChild.click();
      expectOpenState([section]);
    }
  });

  it("opens summary Enter and Space on the first enabled command and scrolls it into view", () => {
    const { binding, add } = setup();
    const section = add("File", ["disabled.first", "file.open"]);
    const titleChild = document.createElement("span");
    section.summary.append(titleChild);
    section.buttons[0]!.disabled = true;
    section.buttons[1]!.scrollIntoView = vi.fn();
    binding.reconcile();
    section.summary.focus();

    expect(key(titleChild, "Enter").defaultPrevented).toBe(true);
    expectOpenState([section], section);
    expect(document.activeElement).toBe(section.buttons[1]);
    expect(section.buttons[1]!.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });

    binding.close();
    section.summary.focus();
    expect(key(section.summary, " ").defaultPrevented).toBe(true);
    expectOpenState([section], section);
    expect(document.activeElement).toBe(section.buttons[1]);

    binding.close();
    section.buttons[1]!.disabled = true;
    section.summary.focus();
    key(section.summary, "Enter");
    expectOpenState([section], section);
    expect(document.activeElement).toBe(section.summary);
  });

  it("uses an inactive keyboard summary instead of the hover section and retains keyboard ownership outside the pointer", () => {
    const { outside, binding, add } = setup();
    const first = add("File");
    const second = add("View");
    const firstTitle = document.createElement("span");
    const secondTitle = document.createElement("span");
    first.summary.append(firstTitle);
    second.summary.append(secondTitle);
    binding.reconcile();

    second.summary.focus();
    pointer(firstTitle, "pointerover");
    expectOpenState([first, second], first);
    expect(document.activeElement).toBe(second.summary);
    key(secondTitle, "ArrowDown");
    expectOpenState([first, second], second);
    expect(document.activeElement).toBe(second.buttons[0]);
    pointer(secondTitle, "pointerout", outside);
    expectOpenState([first, second], second);

    binding.close();
    first.summary.focus();
    pointer(secondTitle, "pointerover");
    key(firstTitle, "Enter");
    expectOpenState([first, second], first);
    expect(document.activeElement).toBe(first.buttons[0]);

    binding.close();
    outside.focus();
    pointer(firstTitle, "pointerover");
    expect(key(outside, "j").defaultPrevented).toBe(true);
    pointer(firstTitle, "pointerout", outside);
    expectOpenState([first, second], first);

    binding.close();
    first.summary.click();
    first.summary.focus();
    key(firstTitle, "Enter");
    expect(document.activeElement).toBe(first.buttons[0]);
    pointer(firstTitle, "pointerout", outside);
    expectOpenState([first, second], first);
  });

  it("dispatches delegated enabled pointer and keyboard commands once and never dispatches disabled commands", () => {
    const { command, binding, add } = setup();
    const section = add("File", ["document.open", "document.print"]);
    const openLabel = section.buttons[0]!.querySelector(".windows-menu-label")!;
    const printShortcut = section.buttons[1]!.querySelector(".windows-menu-shortcut")!;
    binding.reconcile();

    section.summary.click();
    openLabel.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenLastCalledWith("document.open");
    expectOpenState([section]);

    section.summary.click();
    key(printShortcut, "Enter");
    expect(command).toHaveBeenCalledTimes(2);
    expect(command).toHaveBeenLastCalledWith("document.print");
    expectOpenState([section]);

    section.summary.click();
    section.buttons[0]!.disabled = true;
    openLabel.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    key(openLabel, "Enter");
    key(openLabel, " ");
    expect(command).toHaveBeenCalledTimes(2);
    expectOpenState([section], section);
    expect(document.activeElement).not.toBe(section.buttons[0]);

    key(printShortcut, " ", { repeat: true });
    expect(command).toHaveBeenCalledTimes(2);
    key(printShortcut, " ");
    expect(command).toHaveBeenCalledTimes(3);
    expect(command).toHaveBeenLastCalledWith("document.print");
  });

  it("navigates enabled items with Up, Down, Home, and End and wraps sections with Left and Right", () => {
    const { binding, add } = setup();
    const first = add("File", ["disabled.first", "file.one", "file.two"]);
    const second = add("View", ["view.one", "disabled.second"]);
    first.buttons[0]!.scrollIntoView = vi.fn();
    first.buttons[2]!.scrollIntoView = vi.fn();
    first.buttons[0]!.disabled = true;
    second.buttons[1]!.disabled = true;
    binding.reconcile();
    first.summary.focus();

    key(first.summary, "ArrowDown");
    expectOpenState([first, second], first);
    expect(document.activeElement).toBe(first.buttons[1]);
    key(first.buttons[1]!.firstElementChild!, "ArrowDown");
    expect(document.activeElement).toBe(first.buttons[2]);
    key(first.buttons[2]!, "ArrowDown");
    expect(document.activeElement).toBe(first.buttons[1]);
    key(first.buttons[1]!, "ArrowUp");
    expect(document.activeElement).toBe(first.buttons[2]);
    key(first.buttons[2]!, "Home");
    expect(document.activeElement).toBe(first.buttons[1]);
    key(first.buttons[1]!, "End");
    expect(document.activeElement).toBe(first.buttons[2]);
    expect(first.buttons[0]!.scrollIntoView).not.toHaveBeenCalled();
    expect(first.buttons[2]!.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });

    key(first.buttons[2]!.firstElementChild!, "ArrowRight");
    expectOpenState([first, second], second);
    expect(document.activeElement).toBe(second.buttons[0]);
    key(second.buttons[0]!.lastElementChild!, "ArrowLeft");
    expectOpenState([first, second], first);
    expect(document.activeElement).toBe(first.buttons[1]);
  });

  it("moves between closed summaries without opening their inert flyouts", () => {
    const { binding, add } = setup();
    const first = add("File");
    const second = add("View");
    binding.reconcile();
    first.summary.focus();

    key(first.summary, "ArrowRight");
    expect(document.activeElement).toBe(second.summary);
    expectOpenState([first, second]);
    key(second.summary, "ArrowLeft");
    expect(document.activeElement).toBe(first.summary);
    expectOpenState([first, second]);
  });

  it("blocks opening while unavailable and closes an existing section when reconciliation makes it unavailable", () => {
    let allowed = false;
    const canOpen = vi.fn(() => allowed);
    const onOpen = vi.fn<() => void>();
    const { binding, add } = setup({ canOpen, onOpen });
    const section = add("File");
    binding.reconcile();

    pointer(section.summary, "pointerover");
    section.summary.click();
    expect(key(section.summary, "Enter").defaultPrevented).toBe(true);
    expectOpenState([section]);
    expect(onOpen).not.toHaveBeenCalled();

    allowed = true;
    key(section.summary, " ");
    expectOpenState([section], section);
    expect(document.activeElement).toBe(section.buttons[0]);
    expect(onOpen).toHaveBeenCalledOnce();
    allowed = false;
    binding.reconcile();
    expectOpenState([section]);
  });

  it("owns reader keys while open, clears pending input on open, and restores the connected summary on Escape", () => {
    let pendingPrefix = true;
    const onOpen = vi.fn(() => { pendingPrefix = false; });
    const { binding, add } = setup({ onOpen });
    const section = add("File");
    const pageRouter = vi.fn();
    window.addEventListener("keydown", pageRouter, true);
    binding.reconcile();

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
    expectOpenState([section]);
    expect(document.activeElement).toBe(section.summary);

    const unrelatedEscape = key(document, "Escape");
    expect(unrelatedEscape.defaultPrevented).toBe(false);
    expect(pageRouter).toHaveBeenCalledOnce();
    window.removeEventListener("keydown", pageRouter, true);
  });

  it("closes for Tab without cancelling native traversal and passes native Alt+F4 and Alt+Space", () => {
    const { binding, add } = setup();
    const section = add("File");
    const pageRouter = vi.fn();
    window.addEventListener("keydown", pageRouter, true);
    binding.reconcile();

    section.summary.click();
    section.buttons[0]!.focus();
    const tab = key(section.buttons[0]!, "Tab");
    expect(tab.defaultPrevented).toBe(false);
    expectOpenState([section]);
    expect(pageRouter).not.toHaveBeenCalled();

    section.summary.click();
    const altF4 = key(document, "F4", { altKey: true });
    const altSpace = key(document, " ", { altKey: true });
    expect(altF4.defaultPrevented).toBe(false);
    expect(altSpace.defaultPrevented).toBe(false);
    expect(pageRouter).toHaveBeenCalledTimes(2);
    expectOpenState([section], section);
    window.removeEventListener("keydown", pageRouter, true);
  });

  it("keeps pointers inside the menu open and closes on outside pointer, blur, and the public close API", () => {
    const { menu, outside, binding, add } = setup();
    const section = add("File");
    binding.reconcile();

    section.summary.click();
    pointer(section.commands, "pointerdown");
    pointer(menu, "pointerdown");
    expectOpenState([section], section);
    pointer(outside, "pointerdown");
    expectOpenState([section]);

    section.summary.click();
    window.dispatchEvent(new Event("blur"));
    expectOpenState([section]);
    section.summary.click();
    binding.close();
    expectOpenState([section]);
  });

  it("repairs disabled or removed menu focus and flyout state without stealing ordinary publication focus", () => {
    const { outside, binding, add } = setup();
    const section = add("File", ["file.one", "file.two"]);
    binding.reconcile();
    section.summary.click();
    section.buttons[0]!.focus();

    section.commands.hidden = true;
    section.commands.inert = true;
    binding.reconcile();
    expectOpenState([section], section);
    expect(document.activeElement).toBe(section.buttons[0]);

    section.buttons[0]!.disabled = true;
    binding.reconcile();
    expect(document.activeElement).toBe(section.buttons[1]);

    section.buttons[1]!.remove();
    binding.reconcile();
    expect(document.activeElement).toBe(section.summary);

    outside.focus();
    section.buttons[0]!.disabled = false;
    const added = add("View");
    binding.reconcile();
    expect(document.activeElement).toBe(outside);
    expectOpenState([section, added], section);
  });

  it("repairs removed-section focus to a connected summary without opening it", () => {
    const { binding, add } = setup();
    const original = add("File", ["file.one"]);
    binding.reconcile();
    original.summary.click();
    original.buttons[0]!.focus();
    original.details.remove();
    const replacement = add("File", ["file.one"]);

    binding.reconcile();
    expectOpenState([replacement]);
    expect(document.activeElement).toBe(replacement.summary);
  });

  it("measures and clamps fixed flyout geometry on open, reconciliation, and resize", () => {
    vi.stubGlobal("innerWidth", 1000);
    vi.stubGlobal("innerHeight", 700);
    const { binding, add } = setup();
    const section = add("Help");
    const summaryRect = vi.spyOn(section.summary, "getBoundingClientRect").mockReturnValue(box(900, 20, 50, 22));
    const commandsRect = vi.spyOn(section.commands, "getBoundingClientRect").mockReturnValue(box(0, 0, 200, 300));
    binding.reconcile();

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
    expect(section.commands.style.getPropertyValue("--menu-top")).toBe("80px");
    expect(section.commands.style.getPropertyValue("--menu-max-height")).toBe("614px");
  });

  it("disposes idempotently, hides owned flyouts, and removes delegated and capture handlers", () => {
    const { command, onOpen, binding, add } = setup();
    const section = add("File");
    const pageRouter = vi.fn();
    window.addEventListener("keydown", pageRouter, true);
    binding.reconcile();
    section.summary.click();

    binding.dispose();
    binding.dispose();
    expectOpenState([section]);
    pointer(section.summary, "pointerover");
    expectOpenState([section]);
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
