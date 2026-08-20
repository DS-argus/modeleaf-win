import { describe, expect, it } from "vitest";
import { TocController, type TocClock } from "../../../src/ui/reader/TocController";
import type { OutlineRow } from "../../../src/domain/outlines/OutlineModel";

/**
 * Deterministic clock. `feature-spec.md` §8 forbids real sleeps in timer tests,
 * so every deadline assertion advances this clock explicitly.
 */
class FakeClock implements TocClock {
  private currentTime = 0;
  private nextHandle = 1;
  private readonly timers = new Map<number, { readonly dueAt: number; readonly callback: () => void }>();

  public now(): number { return this.currentTime; }

  public schedule(callback: () => void, delayMs: number): number {
    const handle = this.nextHandle++;
    this.timers.set(handle, { dueAt: this.currentTime + delayMs, callback });
    return handle;
  }

  public cancel(handle: number): void { this.timers.delete(handle); }

  /** Advances time and fires every timer whose deadline has arrived. */
  public advance(ms: number): void {
    this.currentTime += ms;
    for (const [handle, timer] of [...this.timers]) {
      if (timer.dueAt <= this.currentTime) {
        this.timers.delete(handle);
        timer.callback();
      }
    }
  }

  public get pendingTimers(): number { return this.timers.size; }
}

const row = (id: string, selector: string | undefined, enabled: boolean, y = 700): OutlineRow => Object.freeze({
  id,
  title: `Row ${id}`,
  depth: 0,
  enabled,
  ...(selector === undefined ? {} : { selector }),
  ...(enabled ? { destination: { pageIndex: 0, x: 0, y } } : {}),
});

/** Twelve enabled rows, so selectors "1" and "12" are genuinely ambiguous. */
function manyRows(): readonly OutlineRow[] {
  return Array.from({ length: 12 }, (_, index) => row(String(index + 1), String(index + 1), true, 700 - index * 10));
}

function setup(rows: readonly OutlineRow[] = manyRows()) {
  const clock = new FakeClock();
  const activations: string[] = [];
  const controller = new TocController({
    clock,
    onActivate: ({ row: activated }) => activations.push(activated.id),
  });
  controller.setOutline(rows);
  controller.setContainerSize({ width: 1000, height: 800 });
  return { clock, controller, activations };
}
describe("TOC container updates", () => {
  it("does not notify for an unchanged size", () => {
    let changes = 0;
    const controller = new TocController({ clock: new FakeClock(), onActivate: () => undefined, onChange: () => { changes += 1; } });
    controller.setContainerSize({ width: 1000, height: 800 });
    const afterFirst = changes;
    controller.setContainerSize({ width: 1000, height: 800 });
    expect(changes).toBe(afterFirst);
  });
});

describe("TOC selector timing", () => {
  it("does not commit an ambiguous selector at 399ms", () => {
    const { clock, controller, activations } = setup();
    controller.open();
    controller.appendDigit("1");
    clock.advance(399);
    expect(activations).toEqual([]);
    expect(controller.pendingSelector).toBe("1");
  });

  it("commits the ambiguous selector exactly at 400ms", () => {
    const { clock, controller, activations } = setup();
    controller.open();
    controller.appendDigit("1");
    clock.advance(400);
    expect(activations).toEqual(["1"]);
    expect(controller.pendingSelector).toBe("");
  });

  it("renews the deadline when a second digit arrives", () => {
    const { clock, controller, activations } = setup();
    controller.open();
    controller.appendDigit("1");
    clock.advance(399);
    controller.appendDigit("2");
    // "12" is unambiguous among 12 rows, so it commits immediately.
    expect(activations).toEqual(["12"]);
  });

  it("renews the deadline on backspace instead of committing early", () => {
    const rows = [
      row("1", "1", true), row("11", "11", true), row("12", "12", true), row("13", "13", true),
    ];
    const { clock, controller, activations } = setup(rows);
    controller.open();
    controller.appendDigit("1");
    clock.advance(300);
    controller.appendDigit("1");
    // "11" is a prefix of nothing longer here, so it commits at once.
    expect(activations).toEqual(["11"]);

    activations.length = 0;
    controller.appendDigit("1");
    clock.advance(399);
    controller.backspace();
    // Backspace emptied the buffer, so nothing may commit afterwards.
    clock.advance(400);
    expect(activations).toEqual([]);
  });

  it("commits an unambiguous selector immediately without arming a timer", () => {
    const rows = [row("5", "5", true), row("6", "6", true)];
    const { clock, controller, activations } = setup(rows);
    controller.open();
    controller.appendDigit("5");
    expect(activations).toEqual(["5"]);
    expect(clock.pendingTimers).toBe(0);
  });

  it("ignores digits while the TOC is closed", () => {
    const { clock, controller, activations } = setup();
    expect(controller.appendDigit("1")).toBe(false);
    clock.advance(400);
    expect(activations).toEqual([]);
  });
});

describe("TOC pending-input cancellation", () => {
  it("cancels pending input when the TOC closes", () => {
    const { clock, controller, activations } = setup();
    controller.open();
    controller.appendDigit("1");
    controller.close();
    clock.advance(400);
    expect(activations).toEqual([]);
  });

  it("cancels pending input on an explicit lifecycle cancel", () => {
    // Tab switch, document close, prompt/help open, config reload, focus loss.
    const { clock, controller, activations } = setup();
    controller.open();
    controller.appendDigit("1");
    controller.cancelPending();
    expect(controller.pendingSelector).toBe("");
    clock.advance(400);
    expect(activations).toEqual([]);
  });

  it("cancels pending input when a new outline is adopted", () => {
    const { clock, controller, activations } = setup();
    controller.open();
    controller.appendDigit("1");
    controller.setOutline([row("a", "1", true)]);
    clock.advance(400);
    // The buffered digit referred to the previous document's rows.
    expect(activations).toEqual([]);
  });

  it("leaves no live timer after disposal", () => {
    const { clock, controller, activations } = setup();
    controller.open();
    controller.appendDigit("1");
    controller.dispose();
    clock.advance(400);
    expect(clock.pendingTimers).toBe(0);
    expect(activations).toEqual([]);
  });
});

describe("TOC activation", () => {
  it("rejects a disabled row and never navigates", () => {
    const { controller, activations } = setup([row("x", undefined, false)]);
    controller.open();
    const result = controller.activateRow(controller.view().rows[0]!.row);
    expect(result).toEqual({ kind: "rejected", reason: "disabled" });
    expect(activations).toEqual([]);
  });

  it("activates an enabled row on direct press", () => {
    const rows = manyRows();
    const { controller, activations } = setup(rows);
    controller.open();
    expect(controller.activateRow(rows[2]!)).toMatchObject({ kind: "navigate" });
    expect(activations).toEqual(["3"]);
  });
});

describe("TOC open and scroll behavior", () => {
  it("opens centered on the current row", () => {
    const { controller } = setup();
    // 12 rows, 1000x800 container: the widget shows a bounded window.
    controller.syncViewport({ pageIndex: 0, x: 0, y: 620 }, 1);
    controller.open();
    const view = controller.view();
    expect(view.open).toBe(true);
    expect(view.currentRowId).toBeDefined();
  });

  it("does not rewind a user scroll on an ordinary rerender", () => {
    const { controller } = setup();
    controller.open();
    controller.scrollRows(1);
    const scrolled = controller.view().rows[0]?.rowIndex;
    // Same viewport revision means no verified user movement occurred.
    controller.syncViewport({ pageIndex: 0, x: 0, y: 700 }, 0);
    expect(controller.view().rows[0]?.rowIndex).toBe(scrolled);
  });

  it("reveals the current row after a verified viewport movement", () => {
    const { controller } = setup();
    controller.open();
    controller.scrollRows(1);
    controller.scrollRows(1);
    // A new revision is a verified movement, so the current row is revealed.
    controller.syncViewport({ pageIndex: 0, x: 0, y: 700 }, 7);
    const view = controller.view();
    const currentVisible = view.rows.some((entry) => entry.isCurrent);
    expect(currentVisible).toBe(true);
  });

  it("reports an empty outline distinctly from a closed TOC", () => {
    const { controller } = setup([]);
    expect(controller.view()).toMatchObject({ open: false, empty: true, totalRows: 0 });
    controller.open();
    expect(controller.view()).toMatchObject({ open: true, empty: true });
  });

  it("toggles open and closed", () => {
    const { controller } = setup();
    controller.toggle();
    expect(controller.isOpen).toBe(true);
    controller.toggle();
    expect(controller.isOpen).toBe(false);
  });

  it("ignores scroll requests while closed", () => {
    const { controller } = setup();
    controller.scrollRows(1);
    expect(controller.view().rows).toEqual([]);
  });
});
