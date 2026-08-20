import { describe, expect, it, vi } from "vitest";
import { rollbackOpenAdoptionOwnership, withOpenAdoptionOwnership } from "../../../src/application/OpenAdoptionOwnership";

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
});
