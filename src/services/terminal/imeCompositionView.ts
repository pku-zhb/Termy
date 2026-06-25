export interface ImeCompositionViewBoundsInput {
  screenWidth: number;
  screenHeight: number;
  cursorLeft: number;
  cursorTop: number;
  cellHeight: number;
  padding?: number;
  maxRows?: number;
}

export interface ImeCompositionViewBounds {
  width: number;
  left: number;
  textIndent: number;
  maxHeight: number;
}

export function computeImeCompositionViewBounds(
  input: ImeCompositionViewBoundsInput,
): ImeCompositionViewBounds {
  const padding = Math.max(0, input.padding ?? 4);
  const maxRows = Math.max(1, input.maxRows ?? 6);
  const cellHeight = Math.max(1, input.cellHeight || 1);
  const cursorLeft = clamp(input.cursorLeft, 0, Math.max(0, input.screenWidth));
  const cursorTop = clamp(input.cursorTop, 0, Math.max(0, input.screenHeight));
  const width = Math.max(1, Math.floor(input.screenWidth - padding));

  const remainingHeight = input.screenHeight - cursorTop - padding;

  return {
    width,
    left: 0,
    textIndent: Math.floor(clamp(cursorLeft, 0, Math.max(0, width - 1))),
    maxHeight: Math.max(cellHeight, Math.floor(Math.min(remainingHeight, cellHeight * maxRows))),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}
