import type { ClaimedOpenRequest } from "../platform/OpenRequestClient";

export type AdoptionStep = "CLAIM" | "ADOPT" | "ACK" | "ROLLBACK" | "REJECT";
export type RejectionBaseReason = "CLAIM_INVALID" | "ADOPTION_FAILED" | "OWNERSHIP_CAPACITY" | "NATIVE_CANCELLED" | "NATIVE_REJECTED" | "REQUEST_EXPIRED" | "ACK_CANCELLED" | "ACK_REJECTED";
export type CleanupDisposition = "NATIVE_COMPLETE" | "TRANSFERRED_TRUSTED_DESCRIPTOR" | "NATIVE_LIFECYCLE_ONLY_NO_DESCRIPTOR";
export type OpenFlowState =
  | { readonly phase: "idle" }
  | { readonly phase: "preparing"; readonly epoch: number; readonly origin: "empty" | "reader" }
  | { readonly phase: "dialog"; readonly epoch: number; readonly origin: "browse" }
  | { readonly phase: "adopting"; readonly epoch: number; readonly origin: "browse" | "recent"; readonly requestId: string; readonly step: AdoptionStep; readonly baseReason?: "CLAIM_INVALID" | "ADOPTION_FAILED" | "OWNERSHIP_CAPACITY"; readonly trustedDescriptor?: ClaimedOpenRequest };
export type InitiatedTerminal =
  | { readonly tag: "ADOPTED"; readonly requestId: string; readonly completion: "ACKNOWLEDGED" }
  | { readonly tag: "ADOPTED_WITH_WARNING"; readonly requestId: string; readonly phase: "ACK"; readonly reason: "NOT_FOUND" | "DELIVERY_EXPIRED" }
  | { readonly tag: "REJECTED"; readonly requestId: string; readonly phase: "CLAIM" | "ADOPT" | "ACK" | "REJECT"; readonly baseReason: RejectionBaseReason; readonly cleanup: CleanupDisposition }
  | { readonly tag: "DISPOSED"; readonly requestId?: string };

export interface OpenFlowCoordinator {
  readonly state: OpenFlowState;
  readonly begin: (origin: "empty" | "reader") => number | undefined;
  readonly showDialog: (epoch: number) => boolean;
  readonly admit: (epoch: number, origin: "browse" | "recent", requestId: string) => boolean;
  readonly advance: (epoch: number, requestId: string, step: AdoptionStep, descriptor?: ClaimedOpenRequest, baseReason?: "CLAIM_INVALID" | "ADOPTION_FAILED" | "OWNERSHIP_CAPACITY") => boolean;
  readonly release: (epoch: number, terminal: InitiatedTerminal) => boolean;
  readonly dispose: () => InitiatedTerminal;
}

export function createOpenFlowCoordinator(onTerminal: (terminal: InitiatedTerminal) => void = () => undefined): OpenFlowCoordinator {
  let epoch = 0;
  let state: OpenFlowState = Object.freeze({ phase: "idle" });
  const api: OpenFlowCoordinator = {
    get state() { return state; },
    begin: (origin) => {
      if (state.phase !== "idle") return undefined;
      epoch += 1;
      state = Object.freeze({ phase: "preparing", epoch, origin });
      return epoch;
    },
    showDialog: (candidate) => {
      if (state.phase !== "preparing" || state.epoch !== candidate) return false;
      state = Object.freeze({ phase: "dialog", epoch: candidate, origin: "browse" });
      return true;
    },
    admit: (candidate, origin, requestId) => {
      if ((state.phase !== "dialog" && state.phase !== "preparing") || state.epoch !== candidate) return false;
      state = Object.freeze({ phase: "adopting", epoch: candidate, origin, requestId, step: "CLAIM" });
      return true;
    },
    advance: (candidate, requestId, step, descriptor, baseReason) => {
      if (state.phase !== "adopting" || state.epoch !== candidate || state.requestId !== requestId) return false;
      state = Object.freeze({ phase: "adopting", epoch: candidate, origin: state.origin, requestId, step, ...(baseReason === undefined ? {} : { baseReason }), ...(descriptor === undefined ? {} : { trustedDescriptor: descriptor }) });
      return true;
    },
    release: (candidate, terminal) => {
      if (state.phase === "idle" || state.epoch !== candidate) return false;
      if ("requestId" in terminal && terminal.requestId !== undefined && state.phase === "adopting" && terminal.requestId !== state.requestId) return false;
      state = Object.freeze({ phase: "idle" });
      onTerminal(Object.freeze(terminal));
      return true;
    },
    dispose: () => {
      const terminal: InitiatedTerminal = state.phase === "adopting" ? Object.freeze({ tag: "DISPOSED", requestId: state.requestId }) : Object.freeze({ tag: "DISPOSED" });
      if (state.phase !== "idle") { state = Object.freeze({ phase: "idle" }); onTerminal(terminal); }
      return terminal;
    },
  };
  return api;
}
