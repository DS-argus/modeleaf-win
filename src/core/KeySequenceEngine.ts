import type { Action, ActionDispatch } from "./Action";
import {
  bindingById,
  findExactBinding,
  isPageTargetDigit,
  isRegisteredCtrlChord,
  matchesDirectToken,
} from "./defaultBindings.windows";
import type { KeyToken } from "./KeyToken";
import {
  appendPageTargetDigit,
  validatePageTarget,
  type PageTargetError,
} from "./PageTarget";

export type KeySequenceError = "KEY_SEQUENCE_INVALID" | PageTargetError;

export type SequenceState =
  | { readonly kind: "idle"; readonly epoch: number }
  | {
      readonly kind: "gPending";
      readonly epoch: number;
      readonly deadlineMs: number;
      readonly documentGeneration: number;
    }
  | {
      readonly kind: "pagePrompt";
      readonly epoch: number;
      readonly digits: string;
      readonly documentGeneration: number;
    };

export interface SequenceContext {
  readonly hasDocument: boolean;
  readonly pageCount: number;
  readonly documentGeneration: number;
}

export interface SequenceResult {
  readonly claimed: boolean;
  readonly dispatches: readonly ActionDispatch[];
  readonly error?: KeySequenceError;
  readonly state: SequenceState;
}

const PREFIX_TIMEOUT_MS = 800;

function directAction(binding: ReturnType<typeof bindingById>): Action {
  switch (binding.command) {
    case "document.open":
    case "page.next":
    case "page.previous":
    case "page.first":
    case "page.last":
    case "view.fitWidth":
    case "view.fitPage":
    case "help.toggle":
    case "prompt.cancel":
      return { type: binding.command };
    case "scroll.byCssPixels":
      switch (binding.id) {
        case "scroll.left": return { type: binding.command, axis: "horizontal", delta: -48 };
        case "scroll.right": return { type: binding.command, axis: "horizontal", delta: 48 };
        case "scroll.up": return { type: binding.command, axis: "vertical", delta: -48 };
        case "scroll.down": return { type: binding.command, axis: "vertical", delta: 48 };
        default: break;
      }
      break;
    case "scroll.byViewport":
      if (binding.id === "scroll.viewportDown") return { type: binding.command, factor: 0.8 };
      if (binding.id === "scroll.viewportUp") return { type: binding.command, factor: -0.8 };
      break;
    case "view.zoom":
      if (binding.id === "view.zoomIn") return { type: binding.command, factor: 1.1 };
      if (binding.id === "view.zoomOut") return { type: binding.command, factor: 1 / 1.1 };
      break;
    case "view.rotate":
      if (binding.id === "view.rotateCounterclockwise") {
        return { type: binding.command, quarterTurns: -1 };
      }
      if (binding.id === "view.rotateClockwise") return { type: binding.command, quarterTurns: 1 };
      break;
    default:
      break;
  }
  throw new Error(`Binding ${binding.id} requires sequence data`);
}

export class KeySequenceEngine {
  private current: SequenceState = { kind: "idle", epoch: 0 };

  get state(): SequenceState {
    return this.current;
  }

  reset(): void {
    this.current = { kind: "idle", epoch: this.current.epoch + 1 };
  }

  cancelForNativeOwnership(): void {
    if (this.current.kind !== "idle") {
      this.reset();
    }
  }

  advance(nowMs: number): SequenceResult {
    if (this.current.kind !== "gPending" || nowMs < this.current.deadlineMs) {
      return this.result(false, []);
    }

    this.current = {
      kind: "pagePrompt",
      epoch: this.current.epoch,
      digits: "",
      documentGeneration: this.current.documentGeneration,
    };
    return this.result(false, [{ action: { type: "prompt.open" }, source: "timeout" }]);
  }

  handle(value: KeyToken, nowMs: number, context: SequenceContext): SequenceResult {
    const timedOut = this.advance(nowMs);
    const timeoutDispatches = timedOut.dispatches;

    if (this.current.kind === "pagePrompt") {
      return this.handlePrompt(value, context, timeoutDispatches);
    }

    if (this.current.kind === "gPending") {
      return this.handlePendingPrefix(value, context, timeoutDispatches);
    }

    const pageTarget = bindingById("page.target");
    if (
      context.hasDocument
      && matchesDirectToken(pageTarget, value)
      && !value.repeat
    ) {
      this.current = {
        kind: "gPending",
        epoch: this.current.epoch + 1,
        deadlineMs: nowMs + PREFIX_TIMEOUT_MS,
        documentGeneration: context.documentGeneration,
      };
      return this.result(true, timeoutDispatches);
    }

    const binding = findExactBinding(value, "reader");
    if (!binding || (value.repeat && !binding.repeatable)) {
      return this.result(false, timeoutDispatches);
    }
    if (binding.contexts.includes("reader") && !context.hasDocument) {
      return this.result(false, timeoutDispatches);
    }

    return this.result(true, [
      ...timeoutDispatches,
      { action: directAction(binding), source: "binding" },
    ]);
  }

  private handlePendingPrefix(
    value: KeyToken,
    context: SequenceContext,
    initial: readonly ActionDispatch[],
  ): SequenceResult {
    if (this.current.kind !== "gPending") {
      throw new Error("Prefix handler requires pending state");
    }
    const pending = this.current;
    if (
      !context.hasDocument
      || context.documentGeneration !== pending.documentGeneration
      || this.isNativeContinuation(value)
    ) {
      this.reset();
      return this.result(false, []);
    }

    const cancel = bindingById("prompt.cancel");
    if (matchesDirectToken(cancel, value)) {
      this.reset();
      if (value.repeat) {
        return this.result(false, []);
      }
      return this.result(true, [
        ...initial,
        { action: { type: "prompt.cancel" }, source: "sequence" },
      ]);
    }

    const firstPage = bindingById("page.first");
    if (
      firstPage.kind === "sequence"
      && value.key === firstPage.keys[1]
      && !value.ctrl
      && !value.alt
      && !value.meta
      && !value.repeat
    ) {
      this.reset();
      return this.result(true, [
        ...initial,
        { action: { type: "page.first" }, source: "sequence" },
      ]);
    }

    if (isPageTargetDigit(value)) {
      const appended = appendPageTargetDigit("", value.key);
      if (appended === "PAGE_TARGET_TOO_LONG") {
        throw new Error("A single page digit cannot exceed the target limit");
      }
      this.current = {
        kind: "pagePrompt",
        epoch: pending.epoch,
        digits: appended,
        documentGeneration: pending.documentGeneration,
      };
      return this.result(true, [
        ...initial,
        { action: { type: "prompt.open" }, source: "sequence" },
      ]);
    }

    this.reset();
    return this.result(true, initial, "KEY_SEQUENCE_INVALID");
  }

  private handlePrompt(
    value: KeyToken,
    context: SequenceContext,
    initial: readonly ActionDispatch[],
  ): SequenceResult {
    if (this.current.kind !== "pagePrompt") {
      throw new Error("Prompt handler requires page-prompt state");
    }
    const prompt = this.current;
    if (
      !context.hasDocument
      || context.documentGeneration !== prompt.documentGeneration
      || this.isNativeContinuation(value)
    ) {
      this.reset();
      return this.result(false, []);
    }

    const cancel = bindingById("prompt.cancel");
    if (
      initial.length > 0
      && value.repeat
      && matchesDirectToken(cancel, value)
    ) {
      this.reset();
      return this.result(false, []);
    }

    if (isPageTargetDigit(value)) {
      if (this.current.kind !== "pagePrompt") {
        throw new Error("Page prompt state changed unexpectedly");
      }
      const appended = appendPageTargetDigit(this.current.digits, value.key);
      if (appended === "PAGE_TARGET_TOO_LONG") {
        return this.result(true, initial, appended);
      }
      this.current = { ...this.current, digits: appended };
      return this.result(true, initial);
    }

    const binding = findExactBinding(value, "pagePrompt");
    if (!binding || (value.repeat && !binding.repeatable)) {
      return this.result(false, initial);
    }

    switch (binding.command) {
      case "prompt.backspace":
        if (this.current.kind !== "pagePrompt") {
          throw new Error("Page prompt state changed unexpectedly");
        }
        this.current = { ...this.current, digits: this.current.digits.slice(0, -1) };
        return this.result(true, initial);
      case "prompt.cancel":
        this.reset();
        return this.result(true, [
          ...initial,
          { action: { type: "prompt.cancel" }, source: "prompt" },
        ]);
      case "page.goTo": {
        if (this.current.kind !== "pagePrompt") {
          throw new Error("Page prompt state changed unexpectedly");
        }
        const target = validatePageTarget(this.current.digits, context.pageCount);
        if (!target.ok) {
          return this.result(true, initial, target.error);
        }
        this.reset();
        return this.result(true, [
          ...initial,
          { action: { type: "page.goTo", page: target.page }, source: "prompt" },
        ]);
      }
      default:
        return this.result(false, initial);
    }
  }

  private isNativeContinuation(value: KeyToken): boolean {
    return value.alt
      || value.meta
      || (value.ctrl && !isRegisteredCtrlChord(value));
  }

  private result(
    claimed: boolean,
    dispatches: readonly ActionDispatch[],
    error?: KeySequenceError,
  ): SequenceResult {
    return error === undefined
      ? { claimed, dispatches, state: this.current }
      : { claimed, dispatches, error, state: this.current };
  }
}
