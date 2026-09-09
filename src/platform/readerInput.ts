export type WheelPageDirection = -1 | 0 | 1;

export interface WheelPageTurnContext {
  readonly zoomMode: "fit-width" | "fit-page" | "custom";
  readonly deltaX: number;
  readonly deltaY: number;
  readonly page: number;
  readonly pageCount: number;
  readonly ctrlKey?: boolean;
}

/** Continuous readers use native scrolling, including at document edges. */
export function wheelPageDirection(context: WheelPageTurnContext): WheelPageDirection {
  if (context.zoomMode !== "fit-page" || context.ctrlKey || context.pageCount <= 1
    || !Number.isFinite(context.deltaX) || !Number.isFinite(context.deltaY)
    || context.deltaY === 0 || Math.abs(context.deltaY) <= Math.abs(context.deltaX)) return 0;
  if (context.deltaY < 0 && context.page > 1) return -1;
  if (context.deltaY > 0 && context.page < context.pageCount) return 1;
  return 0;
}
