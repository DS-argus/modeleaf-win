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
