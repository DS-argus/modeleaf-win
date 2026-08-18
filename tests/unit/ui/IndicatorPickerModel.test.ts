import { describe, expect, it } from "vitest";
import {
  commitIndicatorPicker,
  indicatorPickerDialogKeyAction,
  indicatorPickerKeyAction,
  INDICATOR_PICKER_ROWS,
  openIndicatorPicker,
  previewIndicatorPickerRow,
  revertIndicatorPicker,
  revertIndicatorPickerToDurable,
} from "../../../src/ui/IndicatorPickerModel";
import { DEFAULT_INDICATOR_SETTINGS, INDICATOR_STYLES, type IndicatorSettings } from "../../../src/domain/links/IndicatorSettings";

const baseline: IndicatorSettings = DEFAULT_INDICATOR_SETTINGS;

describe("IndicatorPickerModel rows", () => {
  it("exposes exactly the five frozen styles in contract order", () => {
    expect(INDICATOR_PICKER_ROWS.map((row) => row.style)).toEqual([...INDICATOR_STYLES]);
    expect(INDICATOR_PICKER_ROWS).toHaveLength(5);
  });

  it("gives every style a human display name", () => {
    for (const row of INDICATOR_PICKER_ROWS) {
      expect(row.displayName.length).toBeGreaterThan(0);
      expect(row.displayName).not.toBe(row.style);
    }
  });
});

describe("IndicatorPickerModel transaction", () => {
  it("opens on the durable baseline style", () => {
    const model = openIndicatorPicker(baseline);
    expect(model.status).toBe("open");
    expect(model.transaction.baseline).toEqual(baseline);
    expect(model.transaction.preview).toEqual(baseline);
    expect(model.activeIndex).toBe(INDICATOR_PICKER_ROWS.findIndex((row) => row.style === baseline.style));
  });

  it("rejects an invalid durable baseline instead of repairing it", () => {
    // A corrupt state file must not become the new baseline through the picker.
    expect(() => openIndicatorPicker({ ...baseline, size: -5 })).toThrow(/Invalid indicator baseline/u);
  });

  it("previews without emitting a persistence intent", () => {
    const opened = openIndicatorPicker(baseline);
    const { model, effect } = previewIndicatorPickerRow(opened, 2);
    expect(effect.kind).toBe("preview");
    expect(effect.settings.style).toBe(INDICATOR_PICKER_ROWS[2]?.style);
    // The baseline is untouched, so revert still restores the original.
    expect(model.transaction.baseline).toEqual(baseline);
  });

  it("preserves non-style settings across a preview", () => {
    const custom: IndicatorSettings = { ...baseline, size: 40, durationMilliseconds: 900, color: "cyan" };
    const { effect } = previewIndicatorPickerRow(openIndicatorPicker(custom), 1);
    expect(effect.settings).toMatchObject({ size: 40, durationMilliseconds: 900, color: "cyan" });
  });

  it("rejects an out-of-range preview index", () => {
    const opened = openIndicatorPicker(baseline);
    expect(() => previewIndicatorPickerRow(opened, 99)).toThrow(/out of bounds/u);
    expect(() => previewIndicatorPickerRow(opened, -1)).toThrow(/out of bounds/u);
  });

  it("emits exactly one commit intent carrying the previewed settings", () => {
    const { model: previewed } = previewIndicatorPickerRow(openIndicatorPicker(baseline), 3);
    const { model, intent } = commitIndicatorPicker(previewed);
    expect(model.status).toBe("closed");
    expect(intent).toMatchObject({ kind: "commit" });
    expect(intent.settings.style).toBe(INDICATOR_PICKER_ROWS[3]?.style);
  });

  it("reverts to the style captured on open", () => {
    const { model: previewed } = previewIndicatorPickerRow(openIndicatorPicker(baseline), 4);
    const { model, effect } = revertIndicatorPicker(previewed);
    expect(model.status).toBe("closed");
    expect(effect).toMatchObject({ kind: "revert" });
    expect(effect.settings).toEqual(baseline);
  });

  it("reverts to authoritative durable state after a failed commit", () => {
    const durable: IndicatorSettings = { ...baseline, style: "beacon", size: 32 };
    const { model: previewed } = previewIndicatorPickerRow(openIndicatorPicker(baseline), 1);
    const { effect } = revertIndicatorPickerToDurable(previewed, durable);
    // The durable value wins over both preview and the opening baseline.
    expect(effect.settings).toEqual(durable);
  });

  it("refuses to revert onto invalid durable state", () => {
    const { model: previewed } = previewIndicatorPickerRow(openIndicatorPicker(baseline), 1);
    expect(() => revertIndicatorPickerToDurable(previewed, { ...baseline, durationMilliseconds: -1 }))
      .toThrow(/Invalid durable indicator settings/u);
  });
});

describe("IndicatorPickerModel keyboard", () => {
  it("maps arrows, Enter, and Escape to picker actions", () => {
    expect(indicatorPickerKeyAction("ArrowDown")).toBe("next");
    expect(indicatorPickerKeyAction("ArrowRight")).toBe("next");
    expect(indicatorPickerKeyAction("ArrowUp")).toBe("previous");
    expect(indicatorPickerKeyAction("Enter")).toBe("commit");
    expect(indicatorPickerKeyAction("Escape")).toBe("revert");
    expect(indicatorPickerKeyAction("q")).toBeUndefined();
  });

  it("ignores IME composition so a candidate window cannot commit", () => {
    const event = { isComposing: true, key: "Enter", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, preventDefault: () => undefined, stopPropagation: () => undefined } as unknown as KeyboardEvent;
    expect(indicatorPickerDialogKeyAction(event)).toBeUndefined();
  });

  it("supports Ctrl+J and Ctrl+K movement and consumes the event", () => {
    let prevented = false;
    const event = { isComposing: false, key: "j", ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, preventDefault: () => { prevented = true; }, stopPropagation: () => undefined } as unknown as KeyboardEvent;
    expect(indicatorPickerDialogKeyAction(event)).toBe("next");
    expect(prevented).toBe(true);
  });

  it("ignores unrelated Ctrl chords so accelerators still reach the shell", () => {
    const event = { isComposing: false, key: "o", ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, preventDefault: () => undefined, stopPropagation: () => undefined } as unknown as KeyboardEvent;
    expect(indicatorPickerDialogKeyAction(event)).toBeUndefined();
  });
});
