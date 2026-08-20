import { describe, expect, it } from "vitest";
import {
  beginPagePromptCommit,
  editPagePrompt,
  openPagePrompt,
  settlePagePromptCommit,
  revokePagePromptOwnership,
} from "../../../src/application/PagePromptTransaction";

type Owner = { readonly tabId: number; readonly generation: number };

const opened = () => openPagePrompt<Owner>({ tabId: 7, generation: 3 }, 1);

describe("PagePromptTransaction", () => {
  it("captures ownership and edits digits and Backspace only for the current non-committing owner", () => {
    const initial = opened();
    const one = editPagePrompt(initial, "1", 2, true)!;
    const twelve = editPagePrompt(one, "2", 3, true)!;
    expect(twelve).toMatchObject({ tabId: 7, generation: 3, digits: "12", revision: 3, committing: false });
    expect(editPagePrompt(twelve, "<BS>", 4, true)).toMatchObject({ digits: "1", revision: 4 });
    expect(editPagePrompt(twelve, "x", 4, true)).toBeUndefined();
    expect(editPagePrompt(twelve, "3", 4, false)).toBeUndefined();
    expect(editPagePrompt({ ...twelve, committing: true }, "3", 4, true)).toBeUndefined();
    expect(editPagePrompt({ ...twelve, digits: "1234567890123456" }, "7", 4, true)).toBeUndefined();
  });

  it("validates empty, unsafe, zero, and out-of-range input without closing the prompt", () => {
    expect(beginPagePromptCommit(opened(), 22, 2)).toMatchObject({ kind: "invalid", message: "Enter a page number.", state: { validationMessage: "Enter a page number." } });
    expect(beginPagePromptCommit({ ...opened(), digits: "9999999999999999" }, 22, 2)).toMatchObject({ kind: "invalid", message: "Page number is too large." });
    expect(beginPagePromptCommit({ ...opened(), digits: "0" }, 22, 2)).toMatchObject({ kind: "invalid", message: "Page numbers start at 1." });
    expect(beginPagePromptCommit({ ...opened(), digits: "23" }, 22, 2)).toMatchObject({ kind: "invalid", message: "Page 23 is outside 1–22.", state: { digits: "23", committing: false } });
  });

  it("starts a valid commit and closes only after a current-owner verified or no-op landing", () => {
    const start = beginPagePromptCommit({ ...opened(), digits: "12" }, 22, 2);
    expect(start).toMatchObject({ kind: "ready", page: 12, revision: 2, state: { committing: true, validationMessage: undefined } });
    if (start.kind !== "ready") throw new Error("expected ready commit");
    expect(settlePagePromptCommit(start.state, start.revision, true, "verifiedLanding", 3)).toEqual({ kind: "closed", state: undefined, restoreFocus: true });
    expect(settlePagePromptCommit(start.state, start.revision, true, "noOp", 3)).toEqual({ kind: "closed", state: undefined, restoreFocus: true });
  });

  it("discards stale or owner-lost settlements and keeps truthful failures editable", () => {
    const start = beginPagePromptCommit({ ...opened(), digits: "12" }, 22, 2);
    if (start.kind !== "ready") throw new Error("expected ready commit");
    expect(settlePagePromptCommit({ ...start.state, revision: 9 }, start.revision, true, "verifiedLanding", 10)).toMatchObject({ kind: "stale", state: { revision: 9 } });
    expect(settlePagePromptCommit(start.state, start.revision, false, "verifiedLanding", 3)).toEqual({ kind: "ownerLost", state: undefined });
    expect(settlePagePromptCommit(start.state, start.revision, true, "compensatedFailure", 3)).toMatchObject({
      kind: "failed",
      message: "Page navigation failed; the previous position was restored.",
      restoreFocus: true,
      state: { digits: "12", revision: 3, committing: false, validationMessage: "Page navigation failed; the previous position was restored." },
    });
    expect(settlePagePromptCommit(start.state, start.revision, true, "exception", 3)).toMatchObject({ kind: "failed", message: "Page navigation failed.", state: { committing: false } });
  });

  it("revokes suspended prompt ownership as well as the live prompt", () => {
    const live = opened();
    const suspended = { ...opened(), digits: "7", revision: 2 };
    expect(revokePagePromptOwnership(undefined, suspended)).toEqual({ transaction: suspended, live: undefined, suspended: undefined });
    expect(revokePagePromptOwnership(live, suspended)).toEqual({ transaction: live, live: undefined, suspended: undefined });
  });
});
