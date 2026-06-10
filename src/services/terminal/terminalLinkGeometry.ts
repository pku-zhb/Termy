// 终端链接的几何换算：把「字符串下标」对回「终端单元格列号」。
//
// 为什么需要：xterm 的 translateToString 里一个全角字符（CJK、部分 emoji）只算 1 个字符，
// 但它在终端里占 2 个单元格列。链接 provider 拿到的 startIndex/endIndex 是字符串下标，若直接
// 当成列号用（col = index），含中文的路径（如 ".../专家纪要 2505.md"）其点击热区会随前面
// 每个全角字符累计左移，导致「看得见却点不中」。这里按单元格真实宽度重建映射。

export interface TerminalLineCell {
  getWidth(): number;
  getChars(): string;
}

export interface TerminalLineForColumnMap {
  readonly length: number;
  getCell(column: number): TerminalLineCell | undefined;
}

// 返回一个数组：columns[i] = 该行 translateToString 结果中第 i 个字符（UTF-16 码元）所在的
// 0 基列号。构建方式与 translateToString 保持一致——按单元格宽度步进（跳过全角字符的占位
// 单元格），空单元格折算为一个空格字符。
export function buildTerminalLineColumnMap(line: TerminalLineForColumnMap): number[] {
  const columns: number[] = [];
  for (let column = 0; column < line.length; ) {
    const cell = line.getCell(column);
    if (!cell) {
      break;
    }

    const width = cell.getWidth();
    if (width === 0) {
      column += 1;
      continue;
    }

    const chars = cell.getChars();
    const content = chars.length > 0 ? chars : ' ';
    for (let unit = 0; unit < content.length; unit += 1) {
      columns.push(column);
    }

    column += width;
  }

  return columns;
}

// 把「跨可视行拼接后的字符串下标」换算成终端缓冲区坐标 {x, y}（均为 1 基）。
// lineTexts 是各可视行 translateToString(true) 的结果，columnMaps 是对应行的列号映射。
export function terminalBufferPositionForStringIndex(
  stringIndex: number,
  lineTexts: string[],
  columnMaps: number[][],
  startLineIndex: number,
): { x: number; y: number } | null {
  let remainingIndex = stringIndex;
  for (let lineOffset = 0; lineOffset < lineTexts.length; lineOffset += 1) {
    const lineLength = lineTexts[lineOffset].length;
    if (remainingIndex < lineLength) {
      const column = columnMaps[lineOffset]?.[remainingIndex] ?? remainingIndex;
      return {
        x: column + 1,
        y: startLineIndex + lineOffset + 1,
      };
    }
    remainingIndex -= lineLength;
  }

  return null;
}
