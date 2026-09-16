// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { ScriptTarget, transpileModule } from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

const main = readFileSync("src/main.ts", "utf8");
const start = main.indexOf("function bindReaderWheelInput(");
const end = main.indexOf("function createTab()", start);
if (start < 0 || end <= start) throw new Error("Production reader wheel binding is missing");
const code = transpileModule(main.slice(start, end), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
interface Input { ctrlKey: boolean; deltaX: number; deltaY: number; deltaMode: number; timeStamp: number; clientX: number; clientY: number }
interface Session {
  handleWheelInput(input: Input): Promise<boolean>;
  resetWheelZoom(): void;
  cancelWheelZoom(): void;
}
const bind = new Function(`${code}; return bindReaderWheelInput;`)() as (
  host: HTMLElement, session: Session, isActive: () => boolean,
  onSettled: () => void, onFailure: (error: unknown) => void,
) => () => void;
const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); document.body.replaceChildren(); });
function fixture() {
  const host = document.createElement("section");
  document.body.append(host);
  let active = true;
  const session = { handleWheelInput: vi.fn(async (_input: Input) => true), resetWheelZoom: vi.fn(), cancelWheelZoom: vi.fn() };
  const settled = vi.fn();
  const failure = vi.fn();
  const dispose = bind(host, session, () => active, settled, failure);
  disposers.push(dispose);
  return { host, session, settled, failure, dispose, deactivate: () => { active = false; } };
}
function wheel(host: HTMLElement, init: WheelEventInit = {}) {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100, ...init });
  host.dispatchEvent(event);
  return event;
}

describe("production reader wheel binding", () => {
  it("blocks browser defaults synchronously and forwards exact CSS coordinates and delta mode", async () => {
    const f = fixture();
    const event = wheel(f.host, { deltaX: 2, deltaY: -3, deltaMode: 1, clientX: 137, clientY: 219 });
    expect(event.defaultPrevented).toBe(true);
    expect(f.session.handleWheelInput).toHaveBeenCalledWith({ ctrlKey: true, deltaX: 2, deltaY: -3, deltaMode: 1, clientX: 137, clientY: 219, timeStamp: event.timeStamp });
    await Promise.resolve();
    expect(f.settled).toHaveBeenCalledOnce();
  });
  it.each([{ deltaY: 0 }, { deltaX: 100, deltaY: 1 }, { deltaX: 2, deltaY: 2 }])("still suppresses native zoom for no-op Ctrl input %j", (init) => {
    const f = fixture();
    expect(wheel(f.host, init).defaultPrevented).toBe(true);
    expect(f.session.handleWheelInput).toHaveBeenCalledOnce();
  });
  it("leaves plain wheel to continuous native scroll and cancels stale zoom work", () => {
    const f = fixture();
    expect(wheel(f.host, { ctrlKey: false }).defaultPrevented).toBe(false);
    expect(f.session.handleWheelInput).not.toHaveBeenCalled();
    expect(f.session.cancelWheelZoom).toHaveBeenCalledOnce();
  });
  it("does not route an inactive host into another tab", () => {
    const f = fixture(); f.deactivate();
    expect(wheel(f.host).defaultPrevented).toBe(true);
    expect(f.session.handleWheelInput).not.toHaveBeenCalled();
  });
  it("resets only fractions on Control release or pointer leave, but cancels on new pointer intent or blur", () => {
    const f = fixture();
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift" }));
    expect(f.session.resetWheelZoom).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
    f.host.dispatchEvent(new Event("pointerleave"));
    expect(f.session.resetWheelZoom).toHaveBeenCalledTimes(2);
    expect(f.session.cancelWheelZoom).not.toHaveBeenCalled();
    f.host.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("blur"));
    expect(f.session.cancelWheelZoom).toHaveBeenCalledTimes(2);
  });
  it("reports a current session failure without converting it into success", async () => {
    const f = fixture();
    const error = new Error("render failed");
    f.session.handleWheelInput.mockRejectedValue(error);
    wheel(f.host);
    await Promise.resolve();
    expect(f.failure).toHaveBeenCalledWith(error);
    expect(f.settled).not.toHaveBeenCalled();
  });
  it.each(["dispose", "deactivate"] as const)("does not publish late completions after %s", async (action) => {
    const f = fixture();
    let resolve!: (value: boolean) => void;
    f.session.handleWheelInput.mockImplementation(() => new Promise<boolean>((done) => { resolve = done; }));
    wheel(f.host);
    f[action]();
    resolve(true);
    await Promise.resolve();
    expect(f.settled).not.toHaveBeenCalled();
    expect(f.failure).not.toHaveBeenCalled();
  });
  it("removes host and window listeners at disposal", () => {
    const f = fixture();
    f.dispose();
    f.session.cancelWheelZoom.mockClear();
    expect(wheel(f.host).defaultPrevented).toBe(false);
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
    window.dispatchEvent(new Event("blur"));
    f.host.dispatchEvent(new Event("pointerleave"));
    expect(f.session.handleWheelInput).not.toHaveBeenCalled();
    expect(f.session.resetWheelZoom).not.toHaveBeenCalled();
    expect(f.session.cancelWheelZoom).not.toHaveBeenCalled();
  });
});
