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

export interface TerminalBufferLineLike extends TerminalLineForColumnMap {
  readonly isWrapped: boolean;
  translateToString(trimRight: boolean): string;
}

export interface TerminalBufferLike {
  getLine(index: number): TerminalBufferLineLike | undefined;
}

export interface TerminalLinkWindow {
  text: string;
  lineTexts: string[];
  columnMaps: number[][];
  startLineIndex: number;
  /** text 中每个「硬换行拼接点」的字符串下标（点击时的空格/截断变体回退用） */
  hardJunctions: number[];
}

// 单方向最多跨多少个硬换行行组，防止在异常输出上无限拼接。
const HARD_WRAP_MAX_EXTENSION_GROUPS = 4;
const HARD_WRAP_INDENT_REGEX = /^[ \t]+/;
const SINGLE_TOKEN_REGEX = /^\S+$/;

// 构建链接识别窗口：以 bufferLineNumber（0 基）所在的软换行行组为起点，
// 再按需跨「硬换行」扩展——TUI（Claude Code 等）把长行折成多条真实行
// （isWrapped=false）时，链接会被劈开。是否拼接只看语义，不看行宽：
// 终端列数不可靠（tmux 嵌套、ink 按词折行都会让断点远离右边缘）。
// - 向上：上一行组以未闭合的 file:// 结尾才并入；中间允许隔若干「单 token」行
//   （被劈开链接的中段），但必须最终找到锚点行，否则全部丢弃；
// - 向下：窗口末尾悬着未闭合的 file:// 候选（looksOpenAtEnd）就继续拼，空行是硬边界。
// 硬换行的延续行剥掉行首缩进（TUI 折行按版式补缩进），列号映射同步切片，
// 拼接点下标记入 hardJunctions——按词折行会吃掉断点处的空格，点击时按变体回退。
export function buildTerminalLinkWindow(
  buffer: TerminalBufferLike,
  bufferLineNumber: number,
  looksOpenAtEnd: (text: string) => boolean,
): TerminalLinkWindow | null {
  if (!buffer.getLine(bufferLineNumber)) {
    return null;
  }

  const softWrapGroupStart = (index: number): number => {
    while (index > 0 && buffer.getLine(index)?.isWrapped) {
      index -= 1;
    }
    return index;
  };
  const softWrapGroupEnd = (index: number): number => {
    while (buffer.getLine(index + 1)?.isWrapped) {
      index += 1;
    }
    return index;
  };
  const groupText = (groupStart: number, groupEnd: number): string => {
    let text = '';
    for (let lineIndex = groupStart; lineIndex <= groupEnd; lineIndex += 1) {
      text += buffer.getLine(lineIndex)?.translateToString(true) ?? '';
    }
    return text;
  };

  let startLineIndex = softWrapGroupStart(bufferLineNumber);
  let endLineIndex = softWrapGroupEnd(bufferLineNumber);

  let usedGroups = 0;
  let pendingGroups = 0;
  let probeIndex = startLineIndex;
  while (usedGroups + pendingGroups < HARD_WRAP_MAX_EXTENSION_GROUPS && probeIndex > 0) {
    const previousEnd = probeIndex - 1;
    if (!buffer.getLine(previousEnd)) {
      break;
    }
    const previousStart = softWrapGroupStart(previousEnd);
    const previousText = groupText(previousStart, previousEnd);
    if (looksOpenAtEnd(previousText)) {
      // 锚点行：链接从这里延续下来，把它（和之前记下的中段行）一并纳入窗口。
      // 窗口宁可偏大：解析按 file:// 分段，多纳入的行不会让相邻链接粘连。
      startLineIndex = previousStart;
      usedGroups += pendingGroups + 1;
      pendingGroups = 0;
    } else if (SINGLE_TOKEN_REGEX.test(previousText.trim())) {
      pendingGroups += 1; // 可能是被劈开链接的中段行，先记着继续向上找锚点
    } else {
      break;
    }
    probeIndex = previousStart;
  }

  const assemble = (): TerminalLinkWindow | null => {
    const lineTexts: string[] = [];
    const columnMaps: number[][] = [];
    const hardJunctions: number[] = [];
    let assembledLength = 0;
    for (let lineIndex = startLineIndex; lineIndex <= endLineIndex; lineIndex += 1) {
      const line = buffer.getLine(lineIndex);
      if (!line) {
        break;
      }
      let text = line.translateToString(true);
      let columnMap = buildTerminalLineColumnMap(line);
      if (lineIndex > startLineIndex && !line.isWrapped) {
        hardJunctions.push(assembledLength);
        const indent = HARD_WRAP_INDENT_REGEX.exec(text)?.[0].length ?? 0;
        if (indent > 0) {
          text = text.slice(indent);
          columnMap = columnMap.slice(indent);
        }
      }
      assembledLength += text.length;
      lineTexts.push(text);
      columnMaps.push(columnMap);
    }
    if (lineTexts.length === 0) {
      return null;
    }
    return { text: lineTexts.join(''), lineTexts, columnMaps, startLineIndex, hardJunctions };
  };

  let window = assemble();
  for (let hop = 0; hop < HARD_WRAP_MAX_EXTENSION_GROUPS && window; hop += 1) {
    if (!looksOpenAtEnd(window.text)) {
      break;
    }
    const nextLine = buffer.getLine(endLineIndex + 1);
    if (!nextLine || nextLine.translateToString(true).trim().length === 0) {
      break;
    }
    endLineIndex = softWrapGroupEnd(endLineIndex + 1);
    window = assemble();
  }

  return window;
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
