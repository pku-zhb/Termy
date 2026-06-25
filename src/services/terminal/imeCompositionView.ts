export interface ImeCompositionViewBoundsInput {
  screenWidth: number;
  screenHeight: number;
  cursorLeft: number;
  cursorTop: number;
  cellHeight: number;
  contentHeight?: number;
  padding?: number;
  maxRows?: number;
}

export interface ImeCompositionViewLayout {
  width: number;
  left: number;
  top: number;
  textIndent: number;
  maxHeight: number;
  visibleHeight: number;
}

export function computeImeCompositionViewLayout(
  input: ImeCompositionViewBoundsInput,
): ImeCompositionViewLayout {
  const padding = Math.max(0, input.padding ?? 4);
  const maxRows = Math.max(1, input.maxRows ?? 6);
  const cellHeight = Math.max(1, input.cellHeight || 1);
  const cursorLeft = clamp(input.cursorLeft, 0, Math.max(0, input.screenWidth));
  const cursorTop = clamp(input.cursorTop, 0, Math.max(0, input.screenHeight));
  const width = Math.max(1, Math.floor(input.screenWidth - padding));
  const maxHeight = Math.max(
    cellHeight,
    Math.floor(Math.min(Math.max(cellHeight, input.screenHeight - padding), cellHeight * maxRows)),
  );
  const visibleHeight = Math.min(
    maxHeight,
    Math.max(cellHeight, Math.ceil(input.contentHeight || cellHeight)),
  );

  let top = cursorTop;
  if (top + visibleHeight + padding > input.screenHeight) {
    top = Math.max(0, input.screenHeight - visibleHeight - padding);
  }

  return {
    width,
    left: 0,
    top: Math.floor(top),
    textIndent: Math.floor(clamp(cursorLeft, 0, Math.max(0, width - 1))),
    maxHeight,
    visibleHeight,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}
