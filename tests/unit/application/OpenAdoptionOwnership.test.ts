// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { adoptWithCommittedPresentation, OpenAdoptionPresentationError, rollbackOpenAdoptionOwnership, withOpenAdoptionOwnership } from "../../../src/application/OpenAdoptionOwnership";
import { readFileSync } from "node:fs";
import { ScriptTarget, transpileModule } from "typescript";
import { TabWorkspace } from "../../../src/core/TabWorkspace";
import { createWorkspaceTransitionQueue } from "../../../src/application/WorkspaceTransitionQueue";
import { publishActivateAndAdoptPdfTab } from "../../../src/pdf/PdfTabSession";
import type { InitiatedTerminal } from "../../../src/application/OpenFlowCoordinator";

describe("OpenAdoptionOwnership", () => {
  it("revokes the captured page prompt before a transition can select another tab", async () => {
    let promptOpen = true;
    const events: string[] = [];
    const result = await withOpenAdoptionOwnership({
      requestPending: () => { events.push("pending"); return true; },
      activeId: () => { events.push("active:7"); return 7; },
      cancelPagePrompt: () => { promptOpen = false; events.push("prompt-cancelled"); },
    }, async (priorActiveId) => {
      expect(promptOpen).toBe(false);
      events.push(`select-after-cancel:${priorActiveId}`);
      return "adopted";
    });

    expect(result).toBe("adopted");
    expect(events).toEqual(["pending", "active:7", "prompt-cancelled", "select-after-cancel:7"]);
  });

  it("does not touch prompt or tab ownership after the request was disposed", async () => {
    const cancel = vi.fn();
    const transition = vi.fn(async () => undefined);
    await expect(withOpenAdoptionOwnership({
      requestPending: () => false,
      activeId: () => 7,
      cancelPagePrompt: cancel,
    }, transition)).rejects.toThrow("OPEN_REQUEST_DISPOSED");
    expect(cancel).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it("closes the rejected adoption and restores the retained pre-adoption tab", () => {
    const ids = new Set([1, 2, 3]);
    let active = 2;
    const events: string[] = [];
    rollbackOpenAdoptionOwnership(2, 1, {
      close: (id) => { ids.delete(id); active = 3; events.push(`close:${id}`); },
      has: (id) => ids.has(id),
      activate: (id) => { active = id; events.push(`activate:${id}`); },
    });
    expect(active).toBe(1);
    expect(events).toEqual(["close:2", "activate:1"]);
  });

  it("does not reactivate a removed same-tab or missing prior owner", () => {
    const activate = vi.fn();
    rollbackOpenAdoptionOwnership(2, 2, { close: vi.fn(), has: () => true, activate });
    rollbackOpenAdoptionOwnership(3, 1, { close: vi.fn(), has: () => false, activate });
    expect(activate).not.toHaveBeenCalled();
  });
  it("returns adoption success only after presentation finishes", async () => {
    const events: string[] = [];
    const result = await adoptWithCommittedPresentation(async () => { events.push("commit"); return "owned"; }, async () => { events.push("present"); });
    expect(result).toBe("owned");
    expect(events).toEqual(["commit", "present"]);
  });
  it("distinguishes presentation failure from an adoption that never committed", async () => {
    const failure = new Error("PDF_PRESENTATION_RESTORE_FAILED");
    const present = vi.fn(async () => { throw failure; });
    await expect(adoptWithCommittedPresentation(async () => { throw failure; }, present)).rejects.toBe(failure);
    expect(present).not.toHaveBeenCalled();
    await expect(adoptWithCommittedPresentation(async () => true, present)).rejects.toMatchObject({
      name: "OpenAdoptionPresentationError", cause: failure,
    });
    expect(present).toHaveBeenCalledOnce();
  });

  it("retains a committed empty-tab candidate until terminal rollback closes it", async () => {
    const main = readFileSync("src/main.ts", "utf8");
    const fragments = main.slice(main.indexOf("const SAFE_ADOPTION_FAILURE_STATUSES"), main.indexOf("let paletteActiveIndex"))
      + main.slice(main.indexOf("const pendingOpenAdoptions"), main.indexOf("function restoreOpenFocus"))
      + main.slice(main.indexOf("function handleOpenTerminal"), main.indexOf("const shellOpen ="));
    const code = transpileModule(fragments, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
    const failure = new Error("PDF_PRESENTATION_RESTORE_FAILED");
    const makePayload = () => {
      const snapshot = { status: "", reader: { hasDocument: false } };
      return {
        host: { hidden: true },
        session: {
          snapshot,
          adopt: vi.fn(async () => { snapshot.reader.hasDocument = true; return true; }),
          activate: vi.fn(async (): Promise<void> => undefined), deactivate: vi.fn(async (): Promise<void> => undefined),
          close: vi.fn(async (): Promise<void> => undefined),
          reader: { setStatus: (status: string) => { snapshot.status = status; } },
        },
      };
    };
    const candidate = makePayload();
    candidate.session.activate.mockImplementation(async () => {
      if (candidate.session.snapshot.reader.hasDocument) {
        candidate.session.snapshot.status = "PDF presentation could not be updated.";
        throw failure;
      }
    });
    let initial = true;
    const dispose = (payload: ReturnType<typeof makePayload>) => { void payload.session.close(); };
    const workspace = new TabWorkspace(() => {
      if (initial) { initial = false; return candidate; }
      return makePayload();
    }, 8, { dispose });
    const originalId = workspace.activeTabId;
    const active = () => workspace.getPayload(workspace.activeTabId)!;
    const render = () => { for (const tab of workspace.snapshot.tabs) tab.payload.host.hidden = tab.id !== workspace.activeTabId || !tab.payload.session.snapshot.reader.hasDocument; };
    const errors = vi.fn();
    const queue = createWorkspaceTransitionQueue(() => { throw new Error("Unexpected overflow"); });
    const dependencies = {
      workspace, active, render, createTab: makePayload, disposeWorkspaceTab: dispose,
      queueWorkspaceOwnership: queue.enqueueOwnership, cancelPagePromptOwnership: vi.fn(),
      withOpenAdoptionOwnership, adoptWithCommittedPresentation, OpenAdoptionPresentationError,
      publishActivateAndAdoptPdfTab, rollbackOpenAdoptionOwnership,
      activateCurrentTab: async () => { await active().session.activate(); render(); },
      shellDisposing: false, reportOpenInvokeFailure: errors,
      protectedOpenSession: undefined, dismissPasswordPrompt: vi.fn(),
      cancelledOpenFocus: undefined,
    };
    const names = Object.keys(dependencies);
    const api = new Function(...names, code + ";return { adoptRequest, handleOpenTerminal, pendingOpenAdoptions };")(...Object.values(dependencies)) as {
      adoptRequest: (request: { requestId: string; ownerGeneration: number }) => Promise<void>;
      handleOpenTerminal: (terminal: InitiatedTerminal) => void;
      pendingOpenAdoptions: Map<string, { failureStatus?: string }>;
    };
    await expect(api.adoptRequest({ requestId: "post-commit", ownerGeneration: 1 })).rejects.toBeInstanceOf(OpenAdoptionPresentationError);
    expect(candidate.session.adopt).toHaveBeenCalledOnce();
    expect(candidate.session.close).not.toHaveBeenCalled();
    expect(api.pendingOpenAdoptions.get("post-commit")?.failureStatus).toBe("PDF presentation could not be updated.");

    api.handleOpenTerminal({ tag: "REJECTED", requestId: "post-commit", phase: "REJECT", baseReason: "ADOPTION_FAILED", cleanup: "NATIVE_COMPLETE" });
    await queue.enqueueOwnership(() => undefined);
    expect(candidate.session.close).toHaveBeenCalledOnce();
    expect(workspace.getPayload(originalId)).toBeUndefined();
    expect(api.pendingOpenAdoptions.has("post-commit")).toBe(false);
    expect(active().session.snapshot.reader.hasDocument).toBe(false);
    expect(active().session.snapshot.status).toBe("PDF presentation could not be updated.");
    expect(errors).not.toHaveBeenCalled();
  });
});
