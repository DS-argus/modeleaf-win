// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScriptTarget, transpileModule } from "typescript";

const source = readFileSync("src/main.ts", "utf8");
function compile(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error("Production shell routing section missing");
  return transpileModule(source.slice(from, to), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
}
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("production password modal shell routing", () => {
  it("never sends password text or modified shortcuts to the root keyboard router", () => {
    const registration = compile('window.addEventListener("keydown", (event) => {', 'const DPR_POLL_DELAY_MS');
    const router = { handleKeyDown: vi.fn() };
    let modal = true;
    let listener!: EventListener;
    const register = vi.spyOn(window, "addEventListener").mockImplementation((type, callback) => {
      if (type === "keydown") listener = callback as EventListener;
    });
    new Function("passwordModalOpen", "rootKeyboard", registration)(() => modal, router);
    register.mockRestore();
    const input = document.createElement("input"); input.type = "password"; document.body.append(input); input.focus();
    for (const [key, ctrlKey, shiftKey] of [["n", false, false], ["p", false, false], ["N", false, true], ["P", false, true], ["o", true, false], ["w", true, false], ["Tab", true, false], ["Escape", false, false], ["Enter", false, false]] as const) {
      const event = new KeyboardEvent("keydown", { key, ctrlKey, shiftKey, cancelable: true });
      listener(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(router.handleKeyDown).not.toHaveBeenCalled();
    modal = false;
    // No pending events or actions are replayed on dismissal.
    expect(router.handleKeyDown).not.toHaveBeenCalled();
  });

  it("drops tab operations before queue admission, rather than replaying after dismissal", async () => {
    const functions = compile("function switchTab(id:", "interface PendingOpenAdoption");
    const queued = vi.fn();
    let modal = true;
    const api = new Function("passwordModalOpen", "queueWorkspaceActivation", "queueWorkspaceTransition", "queueRelativeTabActivation", `${functions}; return {switchTab,switchAdjacentTab,closeTab};`)(() => modal, queued, queued, queued) as {
      switchTab(id: number): Promise<void>; switchAdjacentTab(direction: number): Promise<void>; closeTab(id: number): void;
    };
    await api.switchTab(2); await api.switchAdjacentTab(1); api.closeTab(1);
    modal = false;
    await Promise.resolve();
    expect(queued).not.toHaveBeenCalled();
    await api.switchTab(2);
    expect(queued).toHaveBeenCalledOnce();
  });

  it("blocks command and reader dispatch at their production entry points", () => {
    const actionSource = compile("function dispatchActionId(", "function navigateAdjacentReaderPage(");
    const dispatch = vi.fn();
    const run = new Function("passwordModalOpen", "dispatch", `${actionSource}; return dispatchActionId;`)(() => true, dispatch) as (id: string) => void;
    for (const id of ["document.open", "document.close", "document.print", "app.new", "tab.next", "page.next", "view.zoomIn", "history.back", "path.copy"]) run(id);
    expect(dispatch).not.toHaveBeenCalled();
    run("app.quit");
    expect(dispatch).toHaveBeenCalledWith({ type: "application.quit" });
  });

  it("settles password cancellation before draining sessions on native window close", () => {
    const quit = source.slice(source.indexOf("function requestApplicationQuit("), source.indexOf('// Global Any listeners'));
    expect(quit.indexOf("passwordOwner?.cancelPasswordOpening()")).toBeLessThan(quit.indexOf("payload.session.close()"));
    expect(quit.indexOf("payload.session.close()")).toBeLessThan(quit.indexOf('invoke("close_current_window"'));
    expect(source).toContain("finally { if (passwordOwner === payload.session) dismissPasswordPrompt(); }");
    expect(source).toContain("canAdmitOpen: () => !shellDisposing && !passwordModalOpen()");
    expect(quit.indexOf("await passwordOwner?.close()")).toBeLessThan(quit.indexOf("shellOpen.dispose()"));
  });
});
