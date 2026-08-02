/** @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { KeySequenceEngine } from "../../../src/core/KeySequenceEngine";
import {
  createKeyboardAdapter,
  getPromptKeyAction,
  isNativeKeyboardCompositionOrModifierEvent,
  isNativeOwnedKeyboardEvent,
  isNativeOwnedTarget,
} from "../../../src/platform/keyboardAdapter";

function keydown(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
}

describe("keyboardAdapter", () => {
  it("claims registered commands and leaves unregistered Ctrl chords native", () => {
    const target = document.createElement("button");
    document.body.append(target);
    const dispatched: string[] = [];
    const adapter = createKeyboardAdapter({
      engine: new KeySequenceEngine(),
      getContext: () => ({ hasDocument: false, pageCount: 0, documentGeneration: 0 }),
      onDispatch: ({ action }) => dispatched.push(action.type),
    });
    target.addEventListener("keydown", adapter.handleKeyDown);

    const open = keydown("O", { ctrlKey: true });
    target.dispatchEvent(open);
    expect(open.defaultPrevented).toBe(true);
    expect(dispatched).toEqual(["document.open"]);

    const native = keydown("s", { ctrlKey: true });
    target.dispatchEvent(native);
    expect(native.defaultPrevented).toBe(false);
    expect(isNativeOwnedKeyboardEvent(keydown("n"))).toBe(false);
    adapter.dispose();
    target.remove();
  });

  it("propagates Shift so Ctrl+Shift+P is case-independent and Ctrl+P remains native", () => {
    const target = document.createElement("button");
    document.body.append(target);
    const dispatched: string[] = [];
    const adapter = createKeyboardAdapter({
      engine: new KeySequenceEngine(),
      getContext: () => ({ hasDocument: false, pageCount: 0, documentGeneration: 0 }),
      onDispatch: ({ action }) => dispatched.push(action.type),
    });
    target.addEventListener("keydown", adapter.handleKeyDown);

    for (const key of ["P", "p"]) {
      const palette = keydown(key, { ctrlKey: true, shiftKey: true });
      target.dispatchEvent(palette);
      expect(palette.defaultPrevented).toBe(true);
    }
    const plainCtrlP = keydown("p", { ctrlKey: true });
    target.dispatchEvent(plainCtrlP);
    expect(plainCtrlP.defaultPrevented).toBe(false);
    expect(dispatched).toEqual(["palette.toggle", "palette.toggle"]);

    adapter.dispose();
    target.remove();
  });
  it("leaves editable, composition, Alt, Meta, and AltGraph input native", () => {
    const input = document.createElement("input");
    document.body.append(input);
    const adapter = createKeyboardAdapter({
      engine: new KeySequenceEngine(),
      getContext: () => ({ hasDocument: true, pageCount: 10, documentGeneration: 1 }),
      onDispatch: vi.fn(),
    });
    input.addEventListener("keydown", adapter.handleKeyDown);

    for (const event of [
      keydown("n"),
      keydown("n", { isComposing: true }),
      keydown("n", { altKey: true }),
      keydown("n", { metaKey: true }),
    ]) {
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }

    const altGraph = keydown("@", { ctrlKey: true, altKey: true });
    Object.defineProperty(altGraph, "getModifierState", {
      value: (modifier: string) => modifier === "AltGraph",
    });
    expect(isNativeOwnedKeyboardEvent(altGraph)).toBe(true);
    adapter.dispose();
    input.remove();
  });
  it("identifies target-independent composition and modifier ownership", () => {
    const ime = keydown("a");
    Object.defineProperty(ime, "keyCode", { value: 229 });

    const altGraph = keydown("@", { ctrlKey: true, altKey: true });
    Object.defineProperty(altGraph, "getModifierState", {
      value: (modifier: string) => modifier === "AltGraph",
    });

    for (const event of [
      keydown("a", { isComposing: true }),
      keydown("Dead"),
      keydown("Process"),
      keydown("Unidentified"),
      ime,
      altGraph,
      keydown("a", { altKey: true }),
      keydown("a", { metaKey: true }),
      keydown("a", { ctrlKey: true, altKey: true }),
    ]) {
      expect(isNativeKeyboardCompositionOrModifierEvent(event)).toBe(true);
    }

    expect(isNativeKeyboardCompositionOrModifierEvent(keydown("a"))).toBe(false);
  });

  it("claims only unmodified prompt Enter and Escape", () => {
    expect(getPromptKeyAction(keydown("Enter"))).toBe("search");
    expect(getPromptKeyAction(keydown("Enter", { shiftKey: true }))).toBe("searchReverse");
    expect(getPromptKeyAction(keydown("Escape"))).toBe("close");

    for (const event of [
      keydown("Enter", { ctrlKey: true }),
      keydown("Enter", { altKey: true }),
      keydown("Enter", { metaKey: true }),
      keydown("Enter", { isComposing: true }),
      keydown("Escape", { shiftKey: true }),
      keydown("Escape", { ctrlKey: true }),
      keydown("Escape", { altKey: true }),
      keydown("Escape", { metaKey: true }),
      keydown("Escape", { isComposing: true }),
    ]) {
      expect(getPromptKeyAction(event)).toBeUndefined();
    }
  });

  it("uses an epoch-bound timer for the g prefix", () => {
    const target = document.createElement("button");
    document.body.append(target);
    let now = 0;
    let callback: (() => void) | undefined;
    const dispatches: string[] = [];
    const engine = new KeySequenceEngine();
    const adapter = createKeyboardAdapter({
      engine,
      now: () => now,
      setTimer: (next) => {
        callback = next;
        return 1;
      },
      clearTimer: vi.fn(),
      getContext: () => ({ hasDocument: true, pageCount: 10, documentGeneration: 1 }),
      onDispatch: ({ action }) => dispatches.push(action.type),
    });
    target.addEventListener("keydown", adapter.handleKeyDown);

    target.dispatchEvent(keydown("g"));
    expect(engine.state.kind).toBe("gPending");
    now = 800;
    callback?.();
    expect(engine.state).toMatchObject({ kind: "pagePrompt", digits: "" });
    expect(dispatches).toEqual(["prompt.open"]);

    target.dispatchEvent(keydown("Escape"));
    callback?.();
    expect(engine.state.kind).toBe("idle");
    expect(dispatches).toEqual(["prompt.open", "prompt.cancel"]);
    adapter.dispose();
    target.remove();
  });

  it("cancels a pending prefix when focus enters native-owned input", () => {
    const input = document.createElement("input");
    document.body.append(input);
    const engine = new KeySequenceEngine();
    engine.handle(
      { key: "g", ctrl: false, shift: false, alt: false, meta: false, repeat: false },
      0,
      { hasDocument: true, pageCount: 10, documentGeneration: 1 },
    );
    const adapter = createKeyboardAdapter({
      engine,
      getContext: () => ({ hasDocument: true, pageCount: 10, documentGeneration: 1 }),
      onDispatch: vi.fn(),
    });
    input.addEventListener("keydown", adapter.handleKeyDown);
    input.dispatchEvent(keydown("x"));
    expect(engine.state.kind).toBe("idle");
    adapter.dispose();
    input.remove();
  });
  it("cancels a pending prefix without claiming an unregistered Ctrl chord", () => {
    const target = document.createElement("button");
    document.body.append(target);
    const engine = new KeySequenceEngine();
    const adapter = createKeyboardAdapter({
      engine,
      getContext: () => ({ hasDocument: true, pageCount: 10, documentGeneration: 1 }),
      onDispatch: vi.fn(),
    });
    target.addEventListener("keydown", adapter.handleKeyDown);

    target.dispatchEvent(keydown("g"));
    const save = keydown("s", { ctrlKey: true });
    target.dispatchEvent(save);
    expect(save.defaultPrevented).toBe(false);
    expect(engine.state.kind).toBe("idle");

    adapter.dispose();
    target.remove();
  });
  it("recognizes editable focus targets", () => {
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const plain = document.createElement("button");
    document.body.append(editable, plain);
    expect(isNativeOwnedTarget(editable)).toBe(true);
    expect(isNativeOwnedTarget(plain)).toBe(false);
    editable.remove();
    plain.remove();
  });

  it("cancels pending state on same-size document replacement", () => {
    const target = document.createElement("button");
    document.body.append(target);
    let documentGeneration = 1;
    let callback: (() => void) | undefined;
    const dispatches: string[] = [];
    const engine = new KeySequenceEngine();
    const adapter = createKeyboardAdapter({
      engine,
      getContext: () => ({ hasDocument: true, pageCount: 10, documentGeneration }),
      setTimer: (next) => {
        callback = next;
        return 1;
      },
      clearTimer: vi.fn(),
      onDispatch: ({ action }) => dispatches.push(action.type),
    });
    target.addEventListener("keydown", adapter.handleKeyDown);

    target.dispatchEvent(keydown("g"));
    documentGeneration = 2;
    adapter.syncContext();
    callback?.();
    expect(engine.state.kind).toBe("idle");
    expect(dispatches).toEqual([]);

    adapter.dispose();
    target.remove();
  });
  it("guards the prefix timer across document replacement", () => {
    const target = document.createElement("button");
    document.body.append(target);
    let documentGeneration = 1;
    let callback: (() => void) | undefined;
    const dispatches: string[] = [];
    const engine = new KeySequenceEngine();
    const adapter = createKeyboardAdapter({
      engine,
      getContext: () => ({ hasDocument: true, pageCount: 10, documentGeneration }),
      setTimer: (next) => {
        callback = next;
        return 1;
      },
      clearTimer: vi.fn(),
      onDispatch: ({ action }) => dispatches.push(action.type),
    });
    target.addEventListener("keydown", adapter.handleKeyDown);

    target.dispatchEvent(keydown("g"));
    documentGeneration = 2;
    callback?.();
    expect(engine.state.kind).toBe("idle");
    expect(dispatches).toEqual([]);
    adapter.dispose();
    target.remove();
  });
});
