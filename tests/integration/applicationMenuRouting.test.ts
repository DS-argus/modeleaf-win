// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindApplicationMenuOwner } from "../../src/ui/shell/ApplicationMenuOwner";
import { buildWindowsMenuModel } from "../../src/application/commands/WindowsMenuModel";
import { createRootKeyboardRouter } from "../../src/platform/RootKeyboardRouter";
import { validateProductConfig } from "../../src/domain/config/ConfigValidator";
import type { ActionRuntimeContext } from "../../src/domain/actions/ActionRegistry";

const source = readFileSync(`${process.cwd()}/src/main.ts`, "utf8");
const renderSource = source.slice(source.indexOf("function renderWindowsMenu("), source.indexOf("function renderHelpRows("));
const config = validateProductConfig({});
if (!config.ok) throw new Error("Invalid test config");
const productConfig = config.value;
const empty: ActionRuntimeContext = { hasDocument: false, canOpenDocument: true, canCreateSession: true, canCreateWindow: true, tabCount: 1, modalOpen: false, updateAvailable: false, configExists: false, searchActive: false, canHistoryBack: false, canHistoryForward: false };
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach((cleanup) => cleanup()); document.body.replaceChildren(); });
function setup(runtime = empty) {
  const menu = document.createElement("nav");
  const reader = document.createElement("button");
  document.body.append(menu, reader);
  reader.focus();
  let modal = false;
  const readerDispatch = vi.fn();
  const command = vi.fn((id: string) => {
    expect(menu.querySelector("details[open]")).toBeNull();
    modal = ["document.open", "help.show", "theme.picker"].includes(id);
  });
  let cancelPending = () => {};
  const owner = bindApplicationMenuOwner({ menu, onCommand: command, canOpen: () => !modal, onOpen: () => cancelPending() });
  const router = createRootKeyboardRouter({ config: productConfig, getContext: () => ({ windowId: "test", routeRevision: "test", generation: 1, inputContext: "navigation", runtime }), onDispatch: readerDispatch });
  cancelPending = router.cancelPending;
  const route = (event: KeyboardEvent) => router.handleKeyDown(event);
  window.addEventListener("keydown", route, true);
  cleanups.push(() => { owner.dispose(); router.dispose(); window.removeEventListener("keydown", route, true); });
  const render = new Function("windowsMenu", "applicationMenuOwner", `${ts.transpile(renderSource, { target: ts.ScriptTarget.ES2022 })}; return renderWindowsMenu;`)(menu, owner) as (model: ReturnType<typeof buildWindowsMenuModel>) => void;
  const publish = (context = runtime) => render(buildWindowsMenuModel(context, productConfig));
  publish();
  return { menu, reader, owner, command, readerDispatch, publish };
}
function key(target: Element, key: string) { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); }
function hover(target: Element) { target.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })); }

describe("application menu production-render/router integration", () => {
  it.each(["resolved", "rejected"])("blocks only the actual native picker, not pending adoption (%s)", async (outcome) => {
    const menu = document.createElement("nav");
    menu.innerHTML = '<details><summary>Document</summary><div class="windows-menu-commands"><button data-menu-command="document.close">Close PDF</button></div></details>';
    document.body.append(menu);
    let settle!: () => void;
    const invoke = vi.fn(() => new Promise((resolve, reject) => { settle = () => outcome === "resolved" ? resolve({ tag: "CANCELLED" }) : reject(new Error("picker failed")); }));
    const binding = source.slice(source.indexOf("const applicationMenuOwner ="), source.indexOf("function claimOverlay("));
    const coordinator = source.slice(source.indexOf("const shellOpen = createShellOpenCoordinator("), source.indexOf('emptyReaderOpen.addEventListener("click"'));
    const fragment = `let nativeOpenPending = false; let nativePickerOpen = false; const overlayOwner = {}; ${binding} ${coordinator}; return { applicationMenuOwner, shellOpen };`;
    const dependencies = {
      windowsMenu: menu, bindApplicationMenuOwner, invoke,
      createShellOpenCoordinator: (options: unknown) => options,
      dispatchActionId: vi.fn(), cancelPendingShellInput: vi.fn(), listen: vi.fn(), render: vi.fn(),
      reportOpenInvokeFailure: vi.fn(), restoreOpenFocus: vi.fn(), adoptRequest: vi.fn(), handleOpenTerminal: vi.fn(),
    };
    const api = new Function(...Object.keys(dependencies), ts.transpile(fragment, { target: ts.ScriptTarget.ES2022 }))(...Object.values(dependencies)) as {
      applicationMenuOwner: ReturnType<typeof bindApplicationMenuOwner>;
      shellOpen: { invoke(command: string, args: object): Promise<unknown>; dialog: { setPending(pending: boolean): void } };
    };
    cleanups.push(() => api.applicationMenuOwner.dispose());
    const summary = menu.querySelector("summary")!;
    api.shellOpen.dialog.setPending(true);
    hover(summary);
    expect(summary.closest("details")!.open).toBe(true);
    const pending = api.shellOpen.invoke("open_pdf_dialog", {});
    const completion = outcome === "resolved" ? expect(pending).resolves.toEqual({ tag: "CANCELLED" }) : expect(pending).rejects.toThrow("picker failed");
    hover(summary);
    expect(summary.closest("details")!.open).toBe(false);
    settle();
    await completion;
    hover(summary);
    expect(summary.closest("details")!.open).toBe(true);
  });
  it("renders separate stable command and shortcut columns with accessible names", () => {
    const { menu, publish } = setup();
    const button = menu.querySelector<HTMLButtonElement>('[data-menu-command="document.open"]')!;
    const label = button.querySelector(".windows-menu-label")!;
    const shortcut = button.querySelector<HTMLElement>(".windows-menu-shortcut")!;
    expect(label.textContent).toBe("Open PDF…");
    expect(shortcut.textContent).toBe("Ctrl+Shift+O");
    expect(button.getAttribute("aria-label")).toBe("Open PDF…, Ctrl+Shift+O");
    expect(shortcut.hidden).toBe(false);
    publish();
    expect(button.querySelector(".windows-menu-label")).toBe(label);
    expect(button.querySelector(".windows-menu-shortcut")).toBe(shortcut);
    const noShortcut = menu.querySelector<HTMLElement>('[data-menu-command="view.zoomReset"] .windows-menu-shortcut')!;
    expect(noShortcut.hidden).toBe(true);
  });
  it("keeps every closed section hidden and inert through repeated publication", () => {
    const { menu, publish, owner } = setup();
    for (let pass = 0; pass < 5; pass++) {
      for (const summary of menu.querySelectorAll("summary")) {
        hover(summary);
        publish();
        expect(menu.querySelectorAll("details[open]")).toHaveLength(1);
        for (const commands of menu.querySelectorAll<HTMLElement>(".windows-menu-commands")) {
          const open = commands.closest("details")!.open;
          expect(commands.hidden).toBe(!open);
          expect(commands.inert).toBe(!open);
        }
      }
      owner.close();
      expect([...menu.querySelectorAll<HTMLElement>(".windows-menu-commands")].every((commands) => commands.hidden && commands.inert)).toBe(true);
    }
  });
  it("preserves open section, button identity and focus across status publication", () => {
    const { menu, publish } = setup();
    const summary = menu.querySelector('details[data-menu-section="document"] summary')!;
    hover(summary);
    const button = menu.querySelector<HTMLButtonElement>('button[data-menu-command="document.open"]')!;
    const summaryText = summary.firstChild;
    const buttonText = button.firstChild;
    button.focus();
    publish(); publish();
    expect(menu.querySelector('details[data-menu-section="document"] summary')).toBe(summary);
    expect(summary.firstChild).toBe(summaryText);
    expect(button.firstChild).toBe(buttonText);
    expect(menu.querySelector('button[data-menu-command="document.open"]')).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(summary.closest("details")!.open).toBe(true);
  });
  it("cancels pending g on hover and isolates Arrow/j/k from the reader", () => {
    const { menu, reader, readerDispatch, owner } = setup({ ...empty, hasDocument: true });
    key(reader, "g");
    hover(menu.querySelector("summary")!);
    for (const token of ["ArrowDown", "ArrowUp", "j", "k", "g"]) key(document.activeElement!, token);
    expect(readerDispatch).not.toHaveBeenCalled();
    owner.close(); reader.focus(); key(reader, "g");
    expect(readerDispatch).not.toHaveBeenCalled();
  });
  it.each(["document.open", "help.show", "theme.picker"])("closes before %s and blocks background hover during its overlay", (id) => {
    const { menu, command } = setup();
    const button = menu.querySelector<HTMLButtonElement>(`button[data-menu-command="${id}"]`)!;
    expect(button).not.toBeNull();
    hover(button.closest("details")!.querySelector("summary")!);
    button.click();
    expect(command).toHaveBeenCalledExactlyOnceWith(id);
    hover(menu.querySelector("summary")!);
    expect(menu.querySelector("details[open]")).toBeNull();
  });
  it("projects empty/last-close/failure availability without disabling the nav", () => {
    const { menu, publish, command } = setup();
    const print = menu.querySelector<HTMLButtonElement>('[data-menu-command="document.print"]')!;
    for (const state of [empty, { ...empty, hasDocument: true }, empty, { ...empty, canOpenDocument: true }]) {
      publish(state);
      expect(menu.inert).not.toBe(true);
      expect(menu.querySelector<HTMLButtonElement>('[data-menu-command="document.open"]')!.disabled).toBe(false);
      expect(print.disabled).toBe(!state.hasDocument);
    }
    hover(print.closest("details")!.querySelector("summary")!);
    print.click();
    expect(command).not.toHaveBeenCalled();
  });
});
