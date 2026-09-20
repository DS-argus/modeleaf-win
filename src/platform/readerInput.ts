import { MAX_READER_SCALE, MIN_READER_SCALE } from "../domain/navigation/ZoomPolicy";
export const WHEEL_ZOOM_FACTOR = 1.1;
export const WHEEL_ZOOM_IDLE_MS = 250;
export const WHEEL_ZOOM_MAX_STEPS = Math.ceil(Math.log(MAX_READER_SCALE / MIN_READER_SCALE) / Math.log(WHEEL_ZOOM_FACTOR));

export type WheelZoomDeltaMode = 0 | 1 | 2;

export interface WheelZoomInput {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
  readonly timestamp: number;
}

export interface WheelZoomState {
  readonly residual: number;
  readonly lastTimestamp: number | undefined;
  readonly lastDirection: -1 | 1 | undefined;
  readonly lastDeltaMode: WheelZoomDeltaMode | undefined;
}

export interface WheelZoomResult {
  readonly steps: number;
  readonly state: WheelZoomState;
}

export function createWheelZoomState(): WheelZoomState {
  return { residual: 0, lastTimestamp: undefined, lastDirection: undefined, lastDeltaMode: undefined };
}

export function resetWheelZoomState(): WheelZoomState {
  return createWheelZoomState();
}

export function consumeWheelZoom(input: WheelZoomInput, previous: WheelZoomState): WheelZoomResult {
  if (!isWheelZoomDeltaMode(input.deltaMode)) return { steps: 0, state: previous };
  const unit = normalizedUnit(input);
  if (unit === undefined) return { steps: 0, state: previous };

  const direction: -1 | 1 = unit < 0 ? -1 : 1;
  let residual = previous.residual;
  const elapsed = previous.lastTimestamp === undefined ? undefined : input.timestamp - previous.lastTimestamp;
  if (elapsed !== undefined && (elapsed < 0 || elapsed >= WHEEL_ZOOM_IDLE_MS)) residual = 0;
  if (previous.lastDirection !== undefined && previous.lastDirection !== direction) residual = 0;
  if (previous.lastDeltaMode !== undefined && previous.lastDeltaMode !== input.deltaMode) residual = 0;

  const total = residual + unit;
  if (!Number.isFinite(total)) {
    return { steps: direction * WHEEL_ZOOM_MAX_STEPS, state: nextState(input.timestamp, direction, input.deltaMode, 0) };
  }

  const roundedTotal = roundNearInteger(total);
  const uncappedSteps = Math.trunc(roundedTotal);
  if (Math.abs(uncappedSteps) >= WHEEL_ZOOM_MAX_STEPS) {
    return { steps: Math.sign(uncappedSteps) * WHEEL_ZOOM_MAX_STEPS, state: nextState(input.timestamp, direction, input.deltaMode, 0) };
  }

  const steps = uncappedSteps === 0 ? 0 : uncappedSteps;
  const nextResidual = roundedTotal - uncappedSteps;
  return {
    steps,
    state: nextState(input.timestamp, direction, input.deltaMode, nextResidual === 0 ? 0 : nextResidual),
  };
}

function normalizedUnit(input: WheelZoomInput): number | undefined {
  if (input.ctrlKey !== true || !Number.isFinite(input.timestamp)
    || !Number.isFinite(input.deltaX) || !Number.isFinite(input.deltaY)
    || input.deltaY === 0 || Math.abs(input.deltaY) <= Math.abs(input.deltaX)) return undefined;

  if (input.deltaMode === 0) {
    const unit = -input.deltaY / 100;
    return unit === 0 ? undefined : unit;
  }
  return -Math.sign(input.deltaY) * Math.min(Math.abs(input.deltaY), 1);
}

function isWheelZoomDeltaMode(value: number): value is WheelZoomDeltaMode {
  return value === 0 || value === 1 || value === 2;
}

function roundNearInteger(value: number): number {
  const nearest = Math.round(value);
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(value));
  return Math.abs(value - nearest) <= tolerance ? nearest : value;
}

function nextState(timestamp: number, direction: -1 | 1, deltaMode: WheelZoomDeltaMode, residual: number): WheelZoomState {
  return { residual, lastTimestamp: timestamp, lastDirection: direction, lastDeltaMode: deltaMode };
}
