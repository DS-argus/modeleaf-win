export type OverlayId = "commandPalette" | "search" | "help" | "theme" | "indicator" | "update" | "recent";
export type WindowOwnerId = string;
export type FocusTargetId = string;
export interface SuspendedPrompt { readonly kind: "page" | "search"; readonly text: string; readonly selectionStart: number; readonly selectionEnd: number }
export interface ActiveOverlay { readonly id: OverlayId; readonly returnFocusTarget: FocusTargetId; readonly suspendedPrompt?: SuspendedPrompt; readonly prior?: ActiveOverlay }
export interface OverlayOwnerState { readonly windowId: WindowOwnerId; readonly fallbackFocusTarget: FocusTargetId; readonly active?: ActiveOverlay }
export type OverlayIntent =
  | { readonly type: "open"; readonly windowId: WindowOwnerId; readonly overlay: OverlayId; readonly focusedTarget?: FocusTargetId; readonly suspendedPrompt?: SuspendedPrompt }
  | { readonly type: "close"; readonly windowId: WindowOwnerId; readonly overlay: OverlayId }
  | { readonly type: "escape"; readonly windowId: WindowOwnerId };
export type OverlayEffect =
  | { readonly type: "cancelPendingInput" }
  | { readonly type: "show"; readonly overlay: OverlayId }
  | { readonly type: "hide"; readonly overlay: OverlayId }
  | { readonly type: "focus"; readonly target: FocusTargetId }
  | { readonly type: "restorePrompt"; readonly prompt: SuspendedPrompt };
export interface OverlayTransition { readonly state: OverlayOwnerState; readonly effects: readonly OverlayEffect[] }

export function createOverlayOwner(windowId: WindowOwnerId, fallbackFocusTarget: FocusTargetId): OverlayOwnerState {
  if (!validTarget(fallbackFocusTarget)) throw new Error("OVERLAY_FALLBACK_INVALID");
  return Object.freeze({ windowId, fallbackFocusTarget });
}

export function reduceOverlayOwner(
  state: OverlayOwnerState,
  intent: OverlayIntent,
  isTargetValid: (target: FocusTargetId) => boolean = () => true,
): OverlayTransition {
  if (intent.windowId !== state.windowId) return freezeTransition(state, []);
  if (intent.type === "open") {
    const prior = state.active;
    const requested = intent.focusedTarget;
    const returnFocusTarget = prior?.returnFocusTarget
      ?? (requested !== undefined && validTarget(requested) && isTargetValid(requested) ? requested : state.fallbackFocusTarget);
    const suspendedPrompt = intent.suspendedPrompt ?? prior?.suspendedPrompt;
    const active = Object.freeze({ id: intent.overlay, returnFocusTarget, ...(suspendedPrompt === undefined ? {} : { suspendedPrompt }), ...(prior === undefined || prior.id === intent.overlay ? {} : { prior }) });
    return freezeTransition(Object.freeze({ ...state, active }), Object.freeze([
      { type: "cancelPendingInput" as const },
      ...(prior === undefined || prior.id === intent.overlay ? [] : [{ type: "hide" as const, overlay: prior.id }]),
      { type: "show" as const, overlay: intent.overlay },
    ]));
  }
  const active = state.active;
  if (active === undefined || (intent.type === "close" && intent.overlay !== active.id)) return freezeTransition(state, []);
  if (active.prior !== undefined) {
    return freezeTransition(Object.freeze({ ...state, active: active.prior }), Object.freeze([
      { type: "hide", overlay: active.id },
      { type: "show", overlay: active.prior.id },
    ]));
  }
  const focusTarget = validTarget(active.returnFocusTarget) && isTargetValid(active.returnFocusTarget)
    ? active.returnFocusTarget : state.fallbackFocusTarget;
  return freezeTransition(Object.freeze({ windowId: state.windowId, fallbackFocusTarget: state.fallbackFocusTarget }), Object.freeze([
    { type: "hide", overlay: active.id },
    ...(active.suspendedPrompt === undefined ? [] : [{ type: "restorePrompt" as const, prompt: active.suspendedPrompt }]),
    { type: "focus", target: focusTarget },
  ]));
}
function validTarget(target: string): boolean { return target.trim().length > 0 && target.toLocaleLowerCase() !== "body"; }
function freezeTransition(state: OverlayOwnerState, effects: readonly OverlayEffect[]): OverlayTransition {
  return Object.freeze({ state, effects: Object.freeze([...effects]) });
}
