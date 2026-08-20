export type OverlayId = "commandPalette" | "search" | "help" | "theme" | "indicator" | "update" | "recent";
export type WindowOwnerId = string;
export type FocusTargetId = string;
export interface SuspendedPrompt { readonly kind: "page" | "search"; readonly text: string; readonly selectionStart: number; readonly selectionEnd: number }
export interface ActiveOverlay { readonly id: OverlayId; readonly returnFocusTarget: FocusTargetId; readonly suspendedPrompt?: SuspendedPrompt }
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

/**
 * Sole authority for application overlays.
 *
 * Native Windows dialogs are deliberately absent from this model. Replacing an
 * application overlay never retains a hidden stack: at most one app overlay is
 * owned, visible and keyboard-routable at any instant.
 */
export function reduceOverlayOwner(
  state: OverlayOwnerState,
  intent: OverlayIntent,
  isTargetValid: (target: FocusTargetId) => boolean = () => true,
): OverlayTransition {
  if (intent.windowId !== state.windowId) return freezeTransition(state, []);
  if (intent.type === "open") {
    const prior = state.active;
    if (prior?.id === intent.overlay) return freezeTransition(state, []);
    const requested = intent.focusedTarget;
    const returnFocusTarget = requested !== undefined && validTarget(requested) && isTargetValid(requested)
      ? requested
      : prior?.returnFocusTarget ?? state.fallbackFocusTarget;
    const suspendedPrompt = intent.suspendedPrompt ?? prior?.suspendedPrompt;
    const active = Object.freeze({ id: intent.overlay, returnFocusTarget, ...(suspendedPrompt === undefined ? {} : { suspendedPrompt }) });
    return freezeTransition(Object.freeze({ ...state, active }), Object.freeze([
      { type: "cancelPendingInput" as const },
      ...(prior === undefined ? [] : [{ type: "hide" as const, overlay: prior.id }]),
      { type: "show" as const, overlay: intent.overlay },
    ]));
  }
  const active = state.active;
  if (active === undefined || (intent.type === "close" && intent.overlay !== active.id)) return freezeTransition(state, []);
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
