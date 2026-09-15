// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createShellStatusRenderer } from "../../../src/ui/shell/ShellStatusRenderer";
import { ReaderState } from "../../../src/core/ReaderState";
import { bindSearchPrompt } from "../../../src/ui/SearchPromptController";
import { createRootKeyboardRouter } from "../../../src/platform/RootKeyboardRouter";
import { validateProductConfig } from "../../../src/domain/config/ConfigValidator";
import { performTabActivation } from "../../../src/application/TabActivationCoordinator";

function setup() {
  const source = readFileSync("src/main.ts", "utf8");
  document.body.innerHTML = `<input id="focus">${source.match(/<footer id="status"[^>]*><\/footer>/u)![0]}`;
  const footer = document.querySelector<HTMLElement>("#status")!;
  const reader = new ReaderState();
  reader.mountDocument(3);
  let active = { reader, query: "", prompt: false };
  const renderer = createShellStatusRenderer(footer, () => ({
    ...active.reader.snapshot, query: active.query, searchPromptOpen: active.prompt,
  }));
  const modes = () => Array.from(footer.querySelectorAll<HTMLElement>(".status-badge:not([hidden])"), (node) => node.textContent);
  return { footer, reader, renderer, modes, get active() { return active; }, activate: (value: typeof active) => { active = value; renderer.render(); } };
}
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

describe("shared shell status renderer", () => {
  it.each([["view.fitPage", "FIT PAGE"], ["view.fitWidth", "FIT WIDTH"]] as const)("preserves %s and search through render → pending → asynchronous status → idle", async (action, label) => {
    vi.useFakeTimers();
    const subject = setup();
    subject.reader.apply({ type: action });
    subject.active.query = "needle";
    subject.renderer.render();
    const nodes = Array.from(subject.footer.children);
    const config = validateProductConfig({});
    if (!config.ok) throw new Error("CONFIG_INVALID");
    const router = createRootKeyboardRouter({
      config: config.value,
      getContext: () => ({ windowId: "one", routeRevision: "a", generation: 1, inputContext: "navigation", runtime: { hasDocument: true, canOpenDocument: true, canCreateSession: true, canCreateWindow: true, tabCount: 1, modalOpen: false, updateAvailable: false, configExists: false, searchActive: false, canHistoryBack: false, canHistoryForward: false } }),
      onDispatch: vi.fn(), onDisabled: vi.fn(),
      onState: (state) => subject.renderer.setPendingSequence(state.kind === "pending" ? state.sequence : ""),
    });
    const focus = document.querySelector<HTMLInputElement>("input")!;
    focus.focus();
    router.handleKeyDown({ key: "g", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false, preventDefault: vi.fn() });
    subject.renderer.render();
    expect(subject.footer.textContent).toContain("Pending: g");
    await Promise.resolve().then(() => { subject.reader.setStatus("PDF registry cleanup failed: current diagnostic"); subject.renderer.render(); });
    expect(subject.modes()).toEqual([label, "SEARCH"]);
    expect(subject.footer.textContent).toContain("PDF registry cleanup failed: current diagnostic");
    expect(subject.footer.textContent).toContain("Pending: g");
    await vi.advanceTimersByTimeAsync(399);
    expect(subject.footer.textContent).toContain("Pending: g");
    await vi.advanceTimersByTimeAsync(1);
    expect(subject.footer.textContent).not.toContain("Pending:");
    expect(subject.footer.textContent).toContain("PDF registry cleanup failed: current diagnostic");
    expect(subject.modes()).toEqual([label, "SEARCH"]);
    expect(Array.from(subject.footer.children)).toEqual(nodes);
    expect(subject.footer.querySelectorAll("[aria-live], [role], button, [tabindex]")).toHaveLength(0);
    expect(subject.footer.getAttribute("aria-live")).toBe("polite");
    expect(subject.footer.getAttribute("aria-atomic")).toBe("true");
    expect(subject.footer.getAttribute("data-testid")).toBe("reader-status");
    expect(document.activeElement).toBe(focus);
    const observer = new MutationObserver(vi.fn());
    observer.observe(subject.footer, { childList: true, attributes: true, subtree: true });
    subject.renderer.render();
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
    router.dispose();
  });

  it("uses the active tab even when an inactive tab publishes late status, and restores retained query", () => {
    const subject = setup();
    const a = subject.active;
    a.reader.apply({ type: "view.fitPage" }); a.query = "a";
    const b = { reader: new ReaderState(), query: "", prompt: false };
    b.reader.mountDocument(1); b.reader.setStatus("B error");
    subject.activate(b);
    a.reader.setStatus("Late search result from A", "search");
    subject.renderer.render();
    expect(subject.modes()).toEqual(["FIT WIDTH"]);
    expect(subject.footer.textContent).toContain("B error");
    expect(subject.footer.textContent).not.toContain("Late");
    subject.activate(a);
    expect(subject.modes()).toEqual(["FIT PAGE", "SEARCH"]);
    a.reader.closeDocument(); subject.renderer.render();
    expect(subject.modes()).toEqual([]);
  });

  it("follows fit, custom, actual size, rotation and rollback rather than status text or scale", () => {
    const subject = setup();
    subject.reader.apply({ type: "view.fitPage" });
    const fit = subject.reader.snapshot;
    subject.reader.apply({ type: "view.rotate", quarterTurns: 1 }); subject.renderer.render();
    expect(subject.modes()).toEqual(["FIT PAGE"]);
    for (const action of [{ type: "view.fitWidth" }, { type: "view.zoom", factor: 1.1 }, { type: "view.actualSize" }] as const) {
      subject.reader.apply(action); subject.renderer.render();
      expect(subject.modes()).toEqual(action.type === "view.fitWidth" ? ["FIT WIDTH"] : []);
      expect(subject.footer.querySelector(".status-message")?.textContent).not.toMatch(/Fit page|Fit width/u);
      subject.reader.restoreView(fit); subject.renderer.render();
      expect(subject.modes()).toEqual(["FIT PAGE"]);
    }
  });

  it("keeps prompt-only and applied-query modes through native prompt Enter, empty, IME and Escape", () => {
    const subject = setup();
    const dialog = document.createElement("dialog");
    const form = document.createElement("form"); const input = document.createElement("input");
    dialog.append(form); form.append(input); document.body.append(dialog);
    const startSearch = vi.fn((query: string) => {
      if (!query.trim()) return { kind: "ignore" as const };
      subject.active.query = query; return { kind: "search" as const };
    });
    const unbind = bindSearchPrompt({ dialog, form, input }, () => ({ startSearch }), () => { subject.active.prompt = false; }, subject.renderer.render);
    const key = (key: string, isComposing = false) => input.dispatchEvent(new KeyboardEvent("keydown", { key, isComposing, bubbles: true, cancelable: true }));
    subject.active.prompt = true; subject.renderer.render();
    expect(subject.modes()).toEqual(["FIT WIDTH", "SEARCH"]);
    key("Enter"); expect(subject.modes()).toEqual(["FIT WIDTH", "SEARCH"]);
    input.value = "needle"; key("Enter", true);
    expect(startSearch).toHaveBeenCalledTimes(1);
    key("Escape"); expect(subject.modes()).toEqual(["FIT WIDTH"]);
    subject.active.prompt = true; key("Enter");
    expect(subject.active.prompt).toBe(false); expect(subject.modes()).toEqual(["FIT WIDTH", "SEARCH"]);
    subject.active.prompt = true; key("Escape"); expect(subject.modes()).toEqual(["FIT WIDTH", "SEARCH"]);
    subject.active.query = ""; subject.renderer.render(); expect(subject.modes()).toEqual(["FIT WIDTH"]);
    unbind();
  });

  it("drops input entered during asynchronous deactivation before publishing the successor", async () => {
    const subject = setup();
    const config = validateProductConfig({});
    if (!config.ok) throw new Error("CONFIG_INVALID");
    let route = "a";
    const router = createRootKeyboardRouter({
      config: config.value,
      getContext: () => ({ windowId: "one", routeRevision: route, generation: 1, inputContext: "navigation", runtime: { hasDocument: true, canOpenDocument: true, canCreateSession: true, canCreateWindow: true, tabCount: 2, modalOpen: false, updateAvailable: false, configExists: false, searchActive: false, canHistoryBack: false, canHistoryForward: false } }),
      onDispatch: vi.fn(),
      onState: (state) => subject.renderer.setPendingSequence(state.kind === "pending" ? state.sequence : ""),
    });
    let finishDeactivation!: () => void;
    const deactivation = new Promise<void>((resolve) => { finishDeactivation = resolve; });
    const switching = performTabActivation("b", {
      activeId: () => route, payload: (id) => id, isActive: () => true,
      cancelPending: router.cancelPending, deactivate: () => deactivation,
      activateWorkspace: (id) => { route = id; return true; },
      activateCurrent: async () => undefined, reportFailure: vi.fn(),
      publish: () => { router.syncContext(); subject.renderer.render(); },
    });
    router.handleKeyDown({ key: "g", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false, preventDefault: vi.fn() });
    expect(subject.footer.textContent).toContain("Pending: g");
    finishDeactivation(); await switching;
    expect(route).toBe("b");
    expect(subject.footer.textContent).not.toContain("Pending:");
    router.dispose();
  });
  it("connects both production writers without a competing footer text writer", () => {
    const source = readFileSync("src/main.ts", "utf8");
    expect(source).toContain("const shellStatus = createShellStatusRenderer(status,");
    expect(source).toContain("shellStatus.render();");
    expect(source).toMatch(/function render\(\): void \{\r?\n  syncPendingShellInput\(\);/u);
    expect(source).toContain("syncPendingShellInput = rootKeyboard.syncContext;");
    expect(source).toContain('shellStatus.setPendingSequence(state.kind === "pending" ? state.sequence : "")');
    expect(source).toContain("query: session.query");
    expect(source).not.toContain("status.textContent =");
    const cancel = source.slice(source.indexOf("function cancelPagePromptOwnership"), source.indexOf("async function activateCurrentTab"));
    expect(cancel.indexOf("cancelPendingShellInput();")).toBeGreaterThan(0);
    expect(cancel.indexOf("cancelPendingShellInput();")).toBeLessThan(cancel.indexOf("if (transaction === undefined) return;"));
  });
});
