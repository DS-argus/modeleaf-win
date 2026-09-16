import { describe, expect, it } from "vitest";
import {
  consumeWheelZoom,
  createWheelZoomState,
  resetWheelZoomState,
  WHEEL_ZOOM_FACTOR,
  WHEEL_ZOOM_IDLE_MS,
  WHEEL_ZOOM_MAX_STEPS,
  type WheelZoomInput,
  type WheelZoomState,
} from "../../../src/platform/readerInput";

function input(overrides: Partial<WheelZoomInput> = {}): WheelZoomInput {
  return { deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: true, timestamp: 0, ...overrides };
}

function consume(state: WheelZoomState, overrides: Partial<WheelZoomInput>): { steps: number; state: WheelZoomState } {
  return consumeWheelZoom(input(overrides), state);
}

describe("consumeWheelZoom", () => {
  it("exposes the zoom factor and explicit initial/reset state", () => {
    expect(WHEEL_ZOOM_FACTOR).toBe(1.1);
    expect(WHEEL_ZOOM_MAX_STEPS).toBe(46);
    const initial = createWheelZoomState();
    expect(initial).toEqual({ residual: 0, lastTimestamp: undefined, lastDirection: undefined, lastDeltaMode: undefined });

    const changed = consume(initial, { deltaY: -25 }).state;
    expect(resetWheelZoomState()).toEqual(initial);
    expect(changed).not.toEqual(initial);
  });

  it("normalizes pixel, line, and page wheel units", () => {
    const initial = createWheelZoomState();
    expect(consume(initial, { deltaY: -100 }).steps).toBe(1);
    expect(consume(initial, { deltaY: 100 }).steps).toBe(-1);
    expect(consume(initial, { deltaY: -3, deltaMode: 1 }).steps).toBe(1);
    expect(consume(initial, { deltaY: 6, deltaMode: 1 }).steps).toBe(-1);
    expect(consume(initial, { deltaY: -2, deltaMode: 2 }).steps).toBe(1);
    expect(consume(initial, { deltaY: 2, deltaMode: 2 }).steps).toBe(-1);
  });

  it("accumulates fractional pixel input and truncates toward zero", () => {
    let state = createWheelZoomState();
    for (const timestamp of [0, 1, 2]) {
      const result = consume(state, { deltaY: 25, timestamp });
      expect(result.steps).toBe(0);
      state = result.state;
    }
    const final = consume(state, { deltaY: 25, timestamp: 3 });
    expect(final.steps).toBe(-1);
    expect(final.state.residual).toBe(0);

    const partial = consume(createWheelZoomState(), { deltaY: 75 });
    expect(partial.steps).toBe(0);
    expect(partial.state.residual).toBeCloseTo(-0.75);
  });

  it("clears fractional residual on direction reversal", () => {
    const first = consume(createWheelZoomState(), { deltaY: 25, timestamp: 0 });
    expect(first.state.residual).toBeCloseTo(-0.25);
    const reversed = consume(first.state, { deltaY: -25, timestamp: 1 });
    expect(reversed.steps).toBe(0);
    expect(reversed.state.residual).toBeCloseTo(0.25);
  });

  it("clears residual at the idle boundary and preserves it before the boundary", () => {
    const first = consume(createWheelZoomState(), { deltaY: 25, timestamp: 0 });
    const beforeIdle = consume(first.state, { deltaY: 100, timestamp: WHEEL_ZOOM_IDLE_MS - 1 });
    expect(beforeIdle.steps).toBe(-1);
    expect(beforeIdle.state.residual).toBeCloseTo(-0.25);

    const afterIdle = consume(first.state, { deltaY: 100, timestamp: WHEEL_ZOOM_IDLE_MS });
    expect(afterIdle.steps).toBe(-1);
    expect(afterIdle.state.residual).toBe(0);
  });

  it("clears residual when the delta mode changes", () => {
    const first = consume(createWheelZoomState(), { deltaY: -25, deltaMode: 0, timestamp: 0 });
    const changedMode = consume(first.state, { deltaY: -0.25, deltaMode: 1, timestamp: 1 });
    expect(changedMode.steps).toBe(0);
    expect(changedMode.state.residual).toBeCloseTo(0.25);
    expect(changedMode.state.lastDeltaMode).toBe(1);
  });

  it("leaves prior state untouched for non-Ctrl, horizontal, zero, nonfinite, and unsupported input", () => {
    const initial = consume(createWheelZoomState(), { deltaY: -25, timestamp: 17 }).state;
    const invalid: readonly Partial<WheelZoomInput>[] = [
      { ctrlKey: false },
      { deltaX: 200 },
      { deltaX: 100, deltaY: -100 },
      { deltaY: 0 },
      { deltaY: Number.NaN },
      { deltaY: Number.POSITIVE_INFINITY },
      { deltaX: Number.NaN },
      { deltaMode: 3 },
      { deltaMode: -1 },
      { timestamp: Number.NaN },
    ];
    for (const overrides of invalid) {
      const result = consume(initial, overrides);
      expect(result.steps).toBe(0);
      expect(result.state).toBe(initial);
    }
  });

  it("rounds ten fractional pixel events to one step in both directions", () => {
    let positiveState = createWheelZoomState();
    let positiveSteps = 0;
    for (let index = 0; index < 10; index += 1) {
      const result = consume(positiveState, { deltaY: -10, timestamp: index });
      positiveSteps += result.steps;
      positiveState = result.state;
    }
    expect(positiveSteps).toBe(1);
    expect(positiveState.residual).toBe(0);

    let negativeState = createWheelZoomState();
    let negativeSteps = 0;
    for (let index = 0; index < 10; index += 1) {
      const result = consume(negativeState, { deltaY: 10, timestamp: index });
      negativeSteps += result.steps;
      negativeState = result.state;
    }
    expect(negativeSteps).toBe(-1);
    expect(negativeState.residual).toBe(0);
  });

  it("clears residual when the monotonic timestamp moves backwards", () => {
    const first = consume(createWheelZoomState(), { deltaY: -75, timestamp: 100 });
    const discontinuity = consume(first.state, { deltaY: -25, timestamp: 99 });
    expect(discontinuity.steps).toBe(0);
    expect(discontinuity.state.residual).toBeCloseTo(0.25);
    expect(discontinuity.state.lastTimestamp).toBe(99);
  });
  it("bounds extreme finite pixel deltas without an unbounded step sequence", () => {
    const positive = consume(createWheelZoomState(), { deltaY: -Number.MAX_VALUE });
    expect(positive.steps).toBe(WHEEL_ZOOM_MAX_STEPS);
    expect(positive.state.residual).toBe(0);

    const negative = consume(positive.state, { deltaY: Number.MAX_VALUE, timestamp: 1 });
    expect(negative.steps).toBe(-WHEEL_ZOOM_MAX_STEPS);
    expect(negative.state.residual).toBe(0);
  });
});
