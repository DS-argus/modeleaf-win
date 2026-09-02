/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { validateProductConfig } from "../../src/domain/config/ConfigValidator";
import type { ActionRuntimeContext } from "../../src/domain/actions/ActionRegistry";
import { createRootKeyboardRouter, type RootKeyboardEvent } from "../../src/platform/RootKeyboardRouter";
import { buildCommandPaletteEntries, type CommandPaletteCommandEntry } from "../../src/ui/CommandPaletteModel";
import { buildHelpRows } from "../../src/ui/HelpModel";
import { beginPagePromptCommit, editPagePrompt, openPagePrompt, type PagePromptState } from "../../src/application/PagePromptTransaction";
const configResult = validateProductConfig({});
if (!configResult.ok) throw new Error("built-in config invalid");
const runtime: ActionRuntimeContext = { hasDocument: true, canCreateSession: true, canOpenDocument: true, canCreateWindow: true, tabCount: 2, modalOpen: false, updateAvailable: false, configExists: false, searchActive: false, canHistoryBack: false, canHistoryForward: false, linkCount: 1 };
function key(keyValue: string, init: Partial<RootKeyboardEvent> = {}) { let prevented = false; return { event: { key: keyValue, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false, preventDefault: () => { prevented = true; }, ...init } satisfies RootKeyboardEvent, prevented: () => prevented }; }
describe("shortcut workflow", () => {
  it("routes reader actions through the W03 root registry", () => {
    const actions: string[] = [];
    const router = createRootKeyboardRouter({ config: configResult.value, getContext: () => ({ windowId: "window-a", routeRevision: "route-a", generation: 1, inputContext: "navigation", runtime }), onDispatch: (id) => actions.push(id) });
    for (const event of [key("n"), key("p"), key("N", { shiftKey: true }), key("P", { shiftKey: true }), key("G", { shiftKey: true }), key("g"), key("g")]) router.handleKeyDown(event.event);
    expect(actions).toEqual(["page.next", "page.previous", "tab.next", "tab.previous", "page.last", "page.first"]);
    router.dispose();
  });
  it("routes g replay, digits, Backspace, range validation, Enter, and Escape through one owned prompt", () => {
    let clock = 0;
    let revision = 0;
    let inputContext: "navigation" | "pagePrompt" = "navigation";
    let promptState: PagePromptState<{ readonly tabId: number }> | undefined;
    const router = createRootKeyboardRouter({
      config: configResult.value,
      getContext: () => ({ windowId: "window-a", routeRevision: "route-a", generation: 1, inputContext, runtime }),
      onDispatch: (id, dispatch) => {
        if (id === "page.prompt") promptState = openPagePrompt({ tabId: 1 }, ++revision);
        if (dispatch.transitionedContext !== undefined) inputContext = dispatch.transitionedContext as typeof inputContext;
        if (dispatch.replay !== undefined && promptState !== undefined) promptState = editPagePrompt(promptState, dispatch.replay.token, ++revision, true) ?? promptState;
        if (id === "prompt.commit" && promptState !== undefined) promptState = beginPagePromptCommit(promptState, 22, ++revision).state;
        if (id === "prompt.cancel") { promptState = undefined; inputContext = "navigation"; }
      },
      onUnboundToken: (token) => {
        if (promptState === undefined) return false;
        const edited = editPagePrompt(promptState, token, revision + 1, true);
        if (edited === undefined) return false;
        revision += 1;
        promptState = edited;
        return true;
      },
      now: () => clock,
      setTimer: () => 1,
      clearTimer: () => undefined,
    });

    router.handleKeyDown(key("g").event);
    clock = 399;
    router.handleKeyDown(key("9").event);
    router.handleKeyDown(key("9").event);
    expect(promptState).toMatchObject({ tabId: 1, digits: "99", committing: false });
    router.handleKeyDown(key("Enter").event);
    expect(promptState).toMatchObject({ digits: "99", committing: false, validationMessage: "Page 99 is outside 1–22." });
    router.handleKeyDown(key("Backspace").event);
    expect(promptState).toMatchObject({ digits: "9", validationMessage: undefined });
    router.handleKeyDown(key("Enter").event);
    expect(promptState).toMatchObject({ digits: "9", committing: true });
    router.handleKeyDown(key("Escape").event);
    expect(promptState).toBeUndefined();
    expect(inputContext).toBe("navigation");
    router.dispose();
  });
  it("settles g at 400ms and permits only repeatable page-step repeats", () => {
    let clock = 0;
    let timer: (() => void) | undefined;
    const actions: string[] = [];
    const router = createRootKeyboardRouter({
      config: configResult.value,
      getContext: () => ({ windowId: "window-a", routeRevision: "route-a", generation: 1, inputContext: "navigation", runtime }),
      onDispatch: (id) => actions.push(id),
      now: () => clock,
      setTimer: (callback) => { timer = callback; return 1; },
      clearTimer: () => { timer = undefined; },
    });
    router.handleKeyDown(key("g").event);
    clock = 400;
    timer?.();
    expect(actions).toEqual(["page.prompt"]);
    router.cancelPending();
    for (const event of [key("n", { repeat: true }), key("p", { repeat: true }), key("G", { shiftKey: true, repeat: true }), key("N", { shiftKey: true, repeat: true }), key("P", { shiftKey: true, repeat: true }), key("g", { repeat: true })]) router.handleKeyDown(event.event);
    expect(actions).toEqual(["page.prompt", "page.next", "page.previous"]);
    router.dispose();
  });
  it("uses the same registry metadata for visible help and palette", () => {
    const help = buildHelpRows(runtime);
    const palette = buildCommandPaletteEntries(runtime).filter((entry): entry is CommandPaletteCommandEntry => entry.kind === "command");
    const helpById = new Map(help.map((entry) => [entry.id, entry]));
    expect(palette).toHaveLength(12);
    for (const entry of palette.filter(({ id }) => !/^tab\.select\.[1-9]$/u.test(id))) expect(entry).toMatchObject({ label: helpById.get(entry.id)?.label, shortcut: helpById.get(entry.id)?.shortcut });
    const visiblePaletteTabRows = palette.filter(({ id }) => /^tab\.select\.[1-9]$/u.test(id));
    expect(visiblePaletteTabRows.length).toBeGreaterThan(0);
    for (const entry of visiblePaletteTabRows) expect(entry).toMatchObject({ label: expect.stringMatching(/^Select Tab [1-9]$/u), shortcut: expect.stringMatching(/^Ctrl\+[1-9]$/u) });
    expect(helpById.get("tab.select.1")).toMatchObject({ label: "Select Tab 1–9", shortcut: "Ctrl+1 … Ctrl+9" });
    expect(help.map(({ shortcut }) => shortcut)).toEqual(expect.arrayContaining(["Ctrl+O", "Alt+F4", ":, Ctrl+Shift+P", "Shift+N", "g g", "Shift+G"]));
  });
  it("projects exact no-document current-window and theme behavior", () => {
    const empty = { ...runtime, hasDocument: false, modalOpen: true, linkCount: 0 };
    const select = (rows: readonly { id: string; shortcut: string; label: string; enabled: boolean }[]) => rows.filter(({ id }) => id === "app.quit" || id === "theme.picker").map(({ id, shortcut, label, enabled }) => ({ id, shortcut, label, enabled }));
    expect(select(buildHelpRows(empty))).toEqual([{ id: "app.quit", shortcut: "Alt+F4", label: "Close Window", enabled: true }, { id: "theme.picker", shortcut: "Shift+T", label: "Theme picker", enabled: false }]);
  });
});
