import { describe, expect, it, vi } from "vitest";
import type { PdfPrintProgress } from "../../src/pdf/PdfPrintService";
import { PrintProgressOwner, type PrintProgressSession } from "../../src/ui/PrintProgressOwner";

const progress = (phase: PdfPrintProgress["phase"]): PdfPrintProgress => ({
  phase, preparedPages: 2, totalPages: 12, fraction: 1 / 6,
});

function session(value: PdfPrintProgress | undefined = undefined): PrintProgressSession & { value: PdfPrintProgress | undefined } {
  return {
    value,
    get printProgress() { return this.value; },
    cancelPrint: vi.fn(),
  };
}

describe("PrintProgressOwner", () => {
  it("keeps the printing tab's progress and cancel authority while another tab is active", () => {
    const printing = session(progress("preparing"));
    const other = session();
    const owner = new PrintProgressOwner<PrintProgressSession>();

    owner.begin(printing);
    owner.report(printing, printing.printProgress);

    expect(owner.progress).toEqual(progress("preparing"));
    owner.cancel();
    expect(printing.cancelPrint).toHaveBeenCalledOnce();
    expect(other.cancelPrint).not.toHaveBeenCalled();

    owner.report(printing, undefined);
    expect(owner.progress).toBeUndefined();
    owner.cancel();
    expect(printing.cancelPrint).toHaveBeenCalledOnce();
  });

  it("moves ownership only when a newly reporting native print begins", () => {
    const first = session(progress("submitted"));
    const second = session(progress("opening-dialog"));
    const owner = new PrintProgressOwner<PrintProgressSession>();

    owner.begin(first);
    owner.report(first, first.printProgress);
    owner.begin(second);
    expect(owner.progress?.phase).toBe("submitted");

    owner.report(second, second.printProgress);
    expect(owner.owns(second)).toBe(true);
    expect(owner.progress?.phase).toBe("opening-dialog");
  });
});
