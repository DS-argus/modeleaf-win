export const MIN_READER_SCALE = 0.25;
export const MAX_READER_SCALE = 4;

/** Shared bounds for reader actions, fitting, wheel input and PDF destinations. */
export function clampReaderScale(scale: number): number {
  return Math.max(MIN_READER_SCALE, Math.min(MAX_READER_SCALE, scale));
}
