export const MIN_READER_SCALE = 0.25;
export const MAX_READER_SCALE = 4;

/** Shared bounds for reader actions, fitting, wheel input and PDF destinations. */
export function clampReaderScale(scale: number): number {
  return Math.max(MIN_READER_SCALE, Math.min(MAX_READER_SCALE, scale));
}

/** Constant-size composition of relative zoom steps, preserving ordered clamps. */
export interface PendingZoomIntent {
  readonly factor: number;
  readonly lower: number;
  readonly upper: number;
}

export function appendZoomIntent(previous: PendingZoomIntent | undefined, factor: number): PendingZoomIntent {
  if (!Number.isFinite(factor) || factor <= 0) throw new RangeError("Zoom factor must be positive and finite");
  const lower = clampReaderScale((previous?.lower ?? MIN_READER_SCALE) * factor);
  const upper = clampReaderScale((previous?.upper ?? MAX_READER_SCALE) * factor);
  // Intercepts outside this interval are indistinguishable over the allowed
  // input domain. Bounding them keeps arbitrarily long key bursts finite.
  const composedFactor = Math.max(lower / MAX_READER_SCALE,
    Math.min(upper / MIN_READER_SCALE, (previous?.factor ?? 1) * factor));
  return { factor: composedFactor, lower, upper };
}

export function resolveZoomIntent(baseScale: number, intent: PendingZoomIntent): number {
  if (!Number.isFinite(baseScale) || baseScale <= 0) throw new RangeError("Base zoom must be positive and finite");
  return Math.max(intent.lower, Math.min(intent.upper, clampReaderScale(baseScale) * intent.factor));
}
