import { ACTION_IDS, getActionDescriptor, getActionRuntimeAvailability, type ActionId, type ActionRuntimeContext, type InputContext } from "../domain/actions/ActionRegistry";
import type { ProductConfig } from "../domain/config/ConfigValidator";
import { parseKeySequence } from "../domain/input/KeyGrammar";
import { KeySequenceEngine, KeySequenceTrie, type SequenceBinding, type SequenceDispatch, type SequenceResult } from "../domain/input/KeySequenceTrie";

export interface RootKeyboardEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly repeat: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
  readonly nativeOwnedTarget?: boolean;
  readonly altGraph?: boolean;
  readonly priorityOwnedTarget?: boolean;
  preventDefault(): void;
}
export interface RootKeyboardContext {
  readonly windowId: string;
  readonly routeRevision: string;
  readonly generation: number;
  readonly inputContext: InputContext;
  readonly runtime: ActionRuntimeContext;
}
export interface RootKeyboardRouterOptions {
  readonly config: ProductConfig;
  readonly getContext: () => RootKeyboardContext;
  readonly onDispatch: (actionId: ActionId, dispatch: SequenceDispatch) => void;
  readonly onDisabled?: (actionId: ActionId, reason: string) => void;
  readonly onState?: (state: SequenceResult) => void;
  readonly deferAction?: (actionId: ActionId) => boolean;
  readonly onUnboundToken?: (token: string, context: RootKeyboardContext) => boolean;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delay: number) => number;
  readonly clearTimer?: (timer: number) => void;
  /** Gives a transient reader owner first refusal before normal bindings. */
  readonly onPriorityKeyDown?: (event: RootKeyboardEvent, context: RootKeyboardContext) => boolean;
  /** Cancels transient reader ownership whenever root input ownership is revoked. */
  readonly onPriorityCancel?: () => void;
}
export interface RootKeyboardRouter { readonly handleKeyDown: (event: RootKeyboardEvent) => boolean; readonly cancelPending: () => void; readonly syncContext: () => void; readonly dispose: () => void }

export function createRootKeyboardRouter(options: RootKeyboardRouterOptions): RootKeyboardRouter {
  const trie = new KeySequenceTrie(bindings(options.config));
  const engine = new KeySequenceEngine(trie, options.config.input.prefixTimeoutMilliseconds);
  const now = options.now ?? (() => performance.now());
  const setTimer = options.setTimer ?? ((callback, delay) => window.setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((timer) => window.clearTimeout(timer));
  let timer: number | undefined;
  let owner = ownerKey(options.getContext());

  const clear = (): void => { if (timer !== undefined) clearTimer(timer); timer = undefined; };
  const cancelPending = (): void => { clear(); engine.reset(); options.onPriorityCancel?.(); options.onState?.(engine.state()); };
  const syncContext = (): void => {
    const next = ownerKey(options.getContext());
    if (next !== owner) { owner = next; cancelPending(); }
  };
  const emit = (result: SequenceResult): void => {
    options.onState?.(result);
    if (result.kind !== "dispatch") return;
    const availability = getActionRuntimeAvailability(result.dispatch.actionId, options.getContext().runtime);
    if (availability.enabled) options.onDispatch(result.dispatch.actionId, result.dispatch);
    else options.onDisabled?.(result.dispatch.actionId, availability.reason);
  };
  const schedule = (): void => {
    clear();
    const pending = engine.state();
    if (pending.kind !== "pending") return;
    const expectedOwner = owner;
    const expectedEpoch = pending.epoch;
    timer = setTimer(() => {
      timer = undefined;
      const context = options.getContext();
      if (ownerKey(context) !== expectedOwner) { syncContext(); return; }
      emit(engine.expire(context.inputContext, now(), expectedEpoch));
      schedule();
    }, Math.max(0, pending.deadline - now()));
  };
  const handleKeyDown = (event: RootKeyboardEvent): boolean => {
    syncContext();
    const context = options.getContext();
    const token = keyboardToken(event);
    if (options.onPriorityKeyDown !== undefined
      && token !== undefined && !event.priorityOwnedTarget) {
      const prioritized = options.onPriorityKeyDown(event, context);
      if (prioritized) {
        clear();
        engine.reset();
        event.preventDefault();
        options.onState?.({ kind: "idle" });
        return true;
      }
    }
    if (isPhysicalHistoryAccelerator(event)) {
      cancelPending();
      event.preventDefault();
      if (!isHistoryDispatchEligible(event)) return true;
      const token = event.key === "ArrowLeft" ? "<A-Left>" : "<A-Right>";
      const historyAction = directHistoryAction(options.config, token, context.inputContext);
      if (historyAction === undefined) return true;
      const availability = getActionRuntimeAvailability(historyAction, context.runtime);
      if (!event.repeat && availability.enabled) options.onDispatch(historyAction, { actionId: historyAction });
      else if (!availability.enabled) options.onDisabled?.(historyAction, availability.reason);
      return true;
    }
    if (token === undefined) { cancelPending(); return false; }
    const timestamp = now();
    const pending = engine.state();
    if (pending.kind === "pending" && timestamp >= pending.deadline) {
      clear();
      emit(engine.expire(context.inputContext, timestamp, pending.epoch));
      syncContext();
    }
    const routedContext = options.getContext();
    const result = engine.advance(token, routedContext.inputContext, timestamp, event.repeat);
    const deferred = result.kind === "dispatch" && options.deferAction?.(result.dispatch.actionId) === true;
    const unboundHandled = result.kind === "invalid" && result.reason === "no-binding" && options.onUnboundToken?.(token, routedContext) === true;
    const claimed = !deferred && (unboundHandled || result.kind === "pending" || result.kind === "dispatch" || (result.kind === "invalid" && (result.reason === "repeat-suppressed" || result.reason === "invalid-sequence")));
    if (claimed) event.preventDefault();
    if (deferred || unboundHandled) options.onState?.({ kind: "idle" });
    else emit(result);
    schedule();
    return claimed;
  };
  const dispose = (): void => { clear(); options.onPriorityCancel?.(); };
  return Object.freeze({ handleKeyDown, cancelPending, syncContext, dispose });
}

function bindings(config: ProductConfig): readonly SequenceBinding[] {
  const rows: SequenceBinding[] = [];
  for (const id of ACTION_IDS) {
    const availability = getActionDescriptor(id)!.availability;
    const contexts = availability.kind === "global" ? (["navigation", "pagePrompt", "searchPrompt", "searchResults"] as const) : availability.contexts;
    for (const sequence of config.keymap[id] ?? []) rows.push(Object.freeze({ actionId: id, sequence, contexts }));
  }
  return Object.freeze(rows);
}
function ownerKey(context: RootKeyboardContext): string { return `${context.windowId}\u0000${context.routeRevision}\u0000${context.generation}\u0000${context.inputContext}`; }
function keyboardToken(event: RootKeyboardEvent): string | undefined {
  const lower = event.key.toLocaleLowerCase();
  if (event.nativeOwnedTarget || event.isComposing || event.keyCode === 229 || event.altGraph || event.metaKey
    || lower === "dead" || lower === "process" || lower === "unidentified" || lower === "altgraph") return undefined;
  const key = normalizeBrowserKey(event.key);
  if (key === undefined) return undefined;
  const modifiers = [event.ctrlKey ? "C" : undefined, event.altKey ? "A" : undefined, event.shiftKey && (event.ctrlKey || event.altKey || key.startsWith("<")) ? "S" : undefined].filter((value): value is string => value !== undefined);
  const source = modifiers.length === 0 ? key : `<${[...modifiers, chordBase(key)].join("-")}>`;
  const parsed = parseKeySequence(source);
  return parsed.ok && parsed.tokens.length === 1 ? parsed.canonical : undefined;
}
function isPhysicalHistoryAccelerator(event: RootKeyboardEvent): boolean {
  return event.altKey && !event.ctrlKey && !event.metaKey && !event.altGraph
    && (event.key === "ArrowLeft" || event.key === "ArrowRight");
}
function isHistoryDispatchEligible(event: RootKeyboardEvent): boolean {
  return !event.shiftKey && !event.nativeOwnedTarget && !event.isComposing && event.keyCode !== 229;
}
function directHistoryAction(config: ProductConfig, token: string, context: InputContext): ActionId | undefined {
  if (context !== "navigation") return undefined;
  for (const actionId of ["history.back", "history.forward"] as const) {
    for (const sequence of config.keymap[actionId] ?? []) {
      const parsed = parseKeySequence(sequence);
      if (parsed.ok && parsed.tokens.length === 1 && parsed.canonical === token) return actionId;
    }
  }
  return undefined;
}
function normalizeBrowserKey(key: string): string | undefined {
  const named: Readonly<Record<string, string>> = Object.freeze({
    Escape: "<Esc>", Enter: "<Enter>", Backspace: "<BS>", Delete: "<Del>", Tab: "<Tab>",
    ArrowLeft: "<Left>", ArrowRight: "<Right>", ArrowUp: "<Up>", ArrowDown: "<Down>", Home: "<Home>", End: "<End>",
    PageUp: "<PageUp>", PageDown: "<PageDown>", " ": "<Space>",
  });
  if (named[key] !== undefined) return named[key];
  if (/^F(?:[1-9]|1[0-2])$/u.test(key)) return `<${key}>`;
  return [...key].length === 1 ? key : undefined;
}
function chordBase(key: string): string {
  if (key.startsWith("<") && key.endsWith(">")) return key.slice(1, -1);
  return key.toLocaleLowerCase();
}
