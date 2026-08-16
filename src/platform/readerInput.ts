export type WheelPageDirection = -1 | 0 | 1;

export interface WheelPageTurnContext {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly page: number;
  readonly pageCount: number;
  readonly ctrlKey?: boolean;
}

const SCROLL_BOUNDARY_EPSILON_CSS_PIXELS = 1;

export function wheelPageDirection(context: WheelPageTurnContext): WheelPageDirection {
  if (context.ctrlKey || context.pageCount <= 1 || context.deltaY === 0
    || Math.abs(context.deltaY) <= Math.abs(context.deltaX)) {
    return 0;
  }

  if (context.deltaY < 0
    && context.page > 1
    && context.scrollTop <= SCROLL_BOUNDARY_EPSILON_CSS_PIXELS) {
    return -1;
  }

  const maximumScrollTop = Math.max(0, context.scrollHeight - context.clientHeight);
  if (context.deltaY > 0
    && context.page < context.pageCount
    && context.scrollTop >= maximumScrollTop - SCROLL_BOUNDARY_EPSILON_CSS_PIXELS) {
    return 1;
  }

  return 0;
}
