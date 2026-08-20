import { createOpenFlowCoordinator, type InitiatedTerminal } from "../application/OpenFlowCoordinator";
import { openNativePdfDialog, type NativeDialogOutcome, type NativeInvoke } from "./tauri-commands";
import { createOpenRequestClient, type OpenFailureNotice, type OpenRequestAdoption, type OpenRequestInvoke, type OpenRequestListener, type OpenRequestTerminalOutcome } from "./OpenRequestClient";

export interface ShellOpenDialog {
  readonly setPending: (pending: boolean) => void;
  readonly reportFailure: (error?: unknown) => void;
  readonly restoreFocus?: (terminal: InitiatedTerminal) => void;
}
export interface ShellOpenCoordinatorOptions {
  readonly invoke: OpenRequestInvoke;
  readonly listen: OpenRequestListener;
  readonly dialog: ShellOpenDialog;
  readonly adopt: (request: OpenRequestAdoption) => Promise<void> | void;
  readonly onFailure: (tag: OpenFailureNotice["tag"]) => void;
  readonly onTerminal?: (terminal: InitiatedTerminal) => void;
}
export interface ShellOpenCoordinator {
  readonly ready: Promise<void>;
  readonly requestOpen: () => void;
  readonly retryPending: () => void;
  readonly dispose: () => void;
  readonly admitOpen: (notice: NativeDialogOutcome) => boolean;
}
function projectTerminal(requestId: string, terminal: OpenRequestTerminalOutcome): InitiatedTerminal {
  if (terminal.tag === "ACKNOWLEDGED") return { tag: "ADOPTED", requestId, completion: "ACKNOWLEDGED" };
  if (terminal.tag === "ADOPTED_WITH_WARNING") return { tag: "ADOPTED_WITH_WARNING", requestId, phase: "ACK", reason: terminal.reason };
  return { tag: "REJECTED", requestId, phase: terminal.phase, baseReason: terminal.baseReason, cleanup: terminal.cleanup };
}

export function createShellOpenCoordinator(options: ShellOpenCoordinatorOptions): ShellOpenCoordinator {
  let disposed = false;
  const flow = createOpenFlowCoordinator((terminal) => { options.dialog.setPending(false); options.dialog.restoreFocus?.(terminal); });
  const dialogInvoke: NativeInvoke = async <T>(command: string): Promise<T> => await options.invoke(command, {}) as T;
  const release = (epoch: number, terminal: InitiatedTerminal): void => {
    flow.release(epoch, terminal);
  };
  const rejectLateAdmission = (requestId: string): void => {
    void options.invoke("reject_open_request", { requestId }).then(
      () => options.onTerminal?.({ tag: "REJECTED", requestId, phase: "REJECT", baseReason: "REQUEST_EXPIRED", cleanup: "NATIVE_COMPLETE" }),
      () => options.onTerminal?.({ tag: "REJECTED", requestId, phase: "REJECT", baseReason: "REQUEST_EXPIRED", cleanup: "NATIVE_LIFECYCLE_ONLY_NO_DESCRIPTOR" }),
    );
  };
  const client = createOpenRequestClient({
    listen: options.listen,
    invoke: options.invoke,
    adopt: options.adopt,
    onTerminal: (requestId, terminal) => options.onTerminal?.(projectTerminal(requestId, terminal)),
    onFailure: options.onFailure,
  });
  const admit = (epoch: number, origin: "browse" | "recent", outcome: Extract<NativeDialogOutcome, { tag: "ADMITTED" }>): boolean => {
    if (!flow.admit(epoch, origin, outcome.requestId)) return false;
    client.admitNotice(
      { requestId: outcome.requestId },
      (requestId, terminal) => release(epoch, projectTerminal(requestId, terminal)),
      (requestId, progress) => {
        flow.advance(epoch, requestId, progress.step, "descriptor" in progress ? progress.descriptor : undefined, "baseReason" in progress ? progress.baseReason : undefined);
      },
    );
    return true;
  };
  const requestOpen = (): void => {
    if (disposed) return;
    const epoch = flow.begin("empty");
    if (epoch === undefined || !flow.showDialog(epoch)) return;
    options.dialog.setPending(true);
    void openNativePdfDialog(dialogInvoke).then((outcome) => {
      if (disposed) { if (outcome.tag === "ADMITTED") rejectLateAdmission(outcome.requestId); release(epoch, { tag: "DISPOSED" }); return; }
      if (outcome.tag === "CANCELLED") { release(epoch, { tag: "REJECTED", requestId: "", phase: "CLAIM", baseReason: "NATIVE_CANCELLED", cleanup: "NATIVE_LIFECYCLE_ONLY_NO_DESCRIPTOR" }); return; }
      if (outcome.tag !== "ADMITTED") {
        release(epoch, { tag: "REJECTED", requestId: "", phase: "CLAIM", baseReason: "NATIVE_REJECTED", cleanup: "NATIVE_LIFECYCLE_ONLY_NO_DESCRIPTOR" });
        options.dialog.reportFailure(outcome);
        return;
      }
      if (!admit(epoch, "browse", outcome)) {
        release(epoch, { tag: "REJECTED", requestId: outcome.requestId, phase: "CLAIM", baseReason: "CLAIM_INVALID", cleanup: "NATIVE_LIFECYCLE_ONLY_NO_DESCRIPTOR" });
        rejectLateAdmission(outcome.requestId);
        options.dialog.reportFailure(outcome);
      }
    }, (error: unknown) => {
      release(epoch, { tag: "REJECTED", requestId: "", phase: "CLAIM", baseReason: "NATIVE_REJECTED", cleanup: "NATIVE_LIFECYCLE_ONLY_NO_DESCRIPTOR" });
      if (!disposed) options.dialog.reportFailure(error);
    });
  };
  return {
    ready: client.ready,
    requestOpen,
    admitOpen: (outcome) => {
      if (outcome.tag !== "ADMITTED") return false;
      if (disposed) { rejectLateAdmission(outcome.requestId); return false; }
      const epoch = flow.begin("reader");
      if (epoch === undefined) { rejectLateAdmission(outcome.requestId); return false; }
      options.dialog.setPending(true);
      if (admit(epoch, "recent", outcome)) return true;
      release(epoch, { tag: "REJECTED", requestId: outcome.requestId, phase: "CLAIM", baseReason: "CLAIM_INVALID", cleanup: "NATIVE_LIFECYCLE_ONLY_NO_DESCRIPTOR" });
      rejectLateAdmission(outcome.requestId);
      return false;
    },
    retryPending: client.retryPending,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      flow.dispose();
      options.dialog.setPending(false);
      client.dispose();
    },
  };
}
