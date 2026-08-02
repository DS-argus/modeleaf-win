import type { ActionDispatch } from "../core/Action";
import {
  KeySequenceEngine,
  type SequenceContext,
  type SequenceResult,
} from "../core/KeySequenceEngine";
import { token } from "../core/KeyToken";

export interface KeyboardAdapterOptions {
  readonly engine: KeySequenceEngine;
  readonly getContext: () => SequenceContext;
  readonly onDispatch: (dispatch: ActionDispatch) => void;
  readonly onResult?: (result: SequenceResult) => void;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => number;
  readonly clearTimer?: (timer: number) => void;
}

export interface KeyboardAdapter {
  readonly handleKeyDown: (event: KeyboardEvent) => void;
  readonly cancelPending: () => void;
  readonly syncContext: () => void;
  readonly dispose: () => void;
}

export function isNativeOwnedTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  return element !== null && element.closest(
    "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']",
  ) !== null;
}

export function isNativeKeyboardCompositionOrModifierEvent(event: KeyboardEvent): boolean {
  return event.isComposing
    || event.key === "Dead"
    || event.key === "Process"
    || event.key === "Unidentified"
    || event.keyCode === 229
    || event.getModifierState("AltGraph")
    || event.altKey
    || event.metaKey
    || (event.ctrlKey && event.altKey);
}

export function isNativeOwnedKeyboardEvent(event: KeyboardEvent): boolean {
  return isNativeKeyboardCompositionOrModifierEvent(event)
    || isNativeOwnedTarget(event.target);
}

export type PromptKeyAction = "close" | "search" | "searchReverse";

export function getPromptKeyAction(event: KeyboardEvent): PromptKeyAction | undefined {
  if (isNativeKeyboardCompositionOrModifierEvent(event)
    || event.ctrlKey
    || event.metaKey
    || (event.key === "Escape" && event.shiftKey)) {
    return undefined;
  }

  if (event.key === "Escape") {
    return "close";
  }

  if (event.key === "Enter") {
    return event.shiftKey ? "searchReverse" : "search";
  }

  return undefined;
}

export function createKeyboardAdapter(options: KeyboardAdapterOptions): KeyboardAdapter {
  const now = options.now ?? (() => performance.now());
  const setTimer = options.setTimer ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((timer) => window.clearTimeout(timer));
  let pendingTimer: number | undefined;
  let previousDocumentGeneration = options.getContext().documentGeneration;

  const emit = (result: SequenceResult): void => {
    for (const dispatch of result.dispatches) {
      options.onDispatch(dispatch);
    }
    options.onResult?.(result);
  };

  const clearPendingTimer = (): void => {
    if (pendingTimer !== undefined) {
      clearTimer(pendingTimer);
      pendingTimer = undefined;
    }
  };

  const schedulePrefixTimeout = (): void => {
    clearPendingTimer();
    if (options.engine.state.kind !== "gPending") {
      return;
    }
    const expectedEpoch = options.engine.state.epoch;
    const delay = Math.max(0, options.engine.state.deadlineMs - now());
    pendingTimer = setTimer(() => {
      const context = options.getContext();
      if (context.documentGeneration !== previousDocumentGeneration) {
        previousDocumentGeneration = context.documentGeneration;
        cancelPending();
        return;
      }
      pendingTimer = undefined;
      if (options.engine.state.epoch !== expectedEpoch) {
        return;
      }
      emit(options.engine.advance(now()));
    }, delay);
  };

  const cancelPending = (): void => {
    clearPendingTimer();
    options.engine.cancelForNativeOwnership();
  };
  const syncContext = (): void => {
    const documentGeneration = options.getContext().documentGeneration;
    if (documentGeneration !== previousDocumentGeneration) {
      previousDocumentGeneration = documentGeneration;
      cancelPending();
    }
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    syncContext();
    if (isNativeOwnedKeyboardEvent(event)) {
      cancelPending();
      return;
    }

    const result = options.engine.handle(token(event.key, {
      ctrl: event.ctrlKey,
      alt: event.altKey,
      meta: event.metaKey,
      repeat: event.repeat,
    }), now(), options.getContext());

    if (result.claimed) {
      event.preventDefault();
    }
    emit(result);
    schedulePrefixTimeout();
  };

  return {
    handleKeyDown,
    cancelPending,
    syncContext,
    dispose: clearPendingTimer,
  };
}
