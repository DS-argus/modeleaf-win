import { describe, expect, it, vi } from "vitest";
import { createShellOpenCoordinator } from "../../../src/platform/ShellOpenCoordinator";

/**
 * Regression guard for the defect that made the app unusable after one open.
 *
 * `pending` gates `modalOpen`, which disables every action with the reason
 * "Close the current dialog". Any path that leaves `pending` latched bricks the
 * shell: Ctrl+O stops responding and the picker's Browse entry does nothing.
 *
 * These tests drive the coordinator directly, because the failure only appears
 * across a *sequence* of opens, which a single-shot test cannot observe.
 */
const REQUEST_ID = "a".repeat(64);

function harness(invokeImpl: (command: string) => Promise<unknown>) {
  const pendingStates: boolean[] = [];
  const coordinator = createShellOpenCoordinator({
    listen: () => () => undefined,
    invoke: (command) => invokeImpl(command),
    dialog: {
      setPending: (pending) => pendingStates.push(pending),
      reportFailure: () => undefined,
    },
    adopt: () => undefined,
    onFailure: () => undefined,
  });
  return { coordinator, pendingStates, isPending: () => pendingStates.at(-1) === true };
}

const settle = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

describe("shell open cannot latch", () => {
  it("releases pending when the user cancels the native dialog", async () => {
    const { coordinator, isPending } = harness(async (command) =>
      command === "open_pdf_dialog" ? null : undefined);

    coordinator.requestOpen();
    await settle();
    expect(isPending(), "cancel must not leave the shell in a dialog-open state").toBe(false);
  });

  it("allows a second open after a cancel", async () => {
    let dialogCalls = 0;
    const { coordinator } = harness(async (command) => {
      if (command === "open_pdf_dialog") { dialogCalls += 1; return null; }
      return undefined;
    });

    coordinator.requestOpen();
    await settle();
    coordinator.requestOpen();
    await settle();
    // The reported defect: the second Ctrl+O did nothing at all.
    expect(dialogCalls).toBe(2);
  });

  it("releases pending after a successful selection", async () => {
    const { coordinator, isPending } = harness(async (command) => {
      if (command === "open_pdf_dialog") return { requestId: REQUEST_ID };
      if (command === "claim_open_request") {
        return { sessionId: "s".repeat(64), documentGeneration: 1, ownerGeneration: 1, length: 10, displayName: "a.pdf" };
      }
      return undefined;
    });

    coordinator.requestOpen();
    await settle();
    // The dialog is gone once a file is chosen; adoption continues in the
    // background and must not hold the shell hostage.
    expect(isPending()).toBe(false);
  });

  it("releases pending when adoption fails and keeps retrying", async () => {
    // This is the exact latch: claim fails with a retryable error, so the
    // terminal callback never fired and pending stayed true forever.
    const { coordinator, isPending } = harness(async (command) => {
      if (command === "open_pdf_dialog") return { requestId: REQUEST_ID };
      if (command === "claim_open_request") throw new Error("TRANSIENT_BACKEND_ERROR");
      return undefined;
    });

    coordinator.requestOpen();
    await settle();
    expect(isPending(), "a retryable adoption failure must not latch the shell").toBe(false);
  });

  it("allows repeated opens after an adoption failure", async () => {
    let dialogCalls = 0;
    const { coordinator } = harness(async (command) => {
      if (command === "open_pdf_dialog") { dialogCalls += 1; return { requestId: REQUEST_ID }; }
      if (command === "claim_open_request") throw new Error("TRANSIENT_BACKEND_ERROR");
      return undefined;
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      coordinator.requestOpen();
      await settle();
    }
    expect(dialogCalls).toBe(3);
  });

  it("releases pending when the dialog invoke itself rejects", async () => {
    const { coordinator, isPending } = harness(async (command) => {
      if (command === "open_pdf_dialog") throw new Error("DIALOG_FAILED");
      return undefined;
    });

    coordinator.requestOpen();
    await settle();
    expect(isPending()).toBe(false);
  });

  it("releases pending when the dialog returns a malformed notice", async () => {
    const { coordinator, isPending } = harness(async (command) =>
      command === "open_pdf_dialog" ? { requestId: "not-a-valid-id" } : undefined);

    coordinator.requestOpen();
    await settle();
    expect(isPending()).toBe(false);
  });

  it("suppresses a concurrent request while the dialog is genuinely on screen", async () => {
    // Releasing pending eagerly must not reintroduce double dialogs.
    let dialogCalls = 0;
    let resolveDialog: ((value: unknown) => void) | undefined;
    const { coordinator } = harness(async (command) => {
      if (command === "open_pdf_dialog") {
        dialogCalls += 1;
        return new Promise((resolve) => { resolveDialog = resolve; });
      }
      return undefined;
    });

    coordinator.requestOpen();
    await settle();
    coordinator.requestOpen();
    await settle();
    expect(dialogCalls, "a second dialog must not open while one is on screen").toBe(1);

    resolveDialog?.(null);
    await settle();
    coordinator.requestOpen();
    await settle();
    expect(dialogCalls, "a new dialog is allowed once the first closes").toBe(2);
  });

  it("releases pending on dispose so teardown cannot strand the flag", async () => {
    let resolveDialog: ((value: unknown) => void) | undefined;
    const { coordinator, isPending } = harness(async (command) => {
      if (command === "open_pdf_dialog") return new Promise((resolve) => { resolveDialog = resolve; });
      return undefined;
    });

    coordinator.requestOpen();
    await settle();
    coordinator.dispose();
    resolveDialog?.(null);
    await settle();
    expect(isPending()).toBe(false);
  });
});
