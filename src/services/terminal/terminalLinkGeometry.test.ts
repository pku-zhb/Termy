import * as assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTerminalLineColumnMap,
  buildTerminalLinkWindow,
  terminalBufferPositionForStringIndex,
  type TerminalBufferLike,
  type TerminalBufferLineLike,
  type TerminalLineForColumnMap,
} from './terminalLinkGeometry.ts';
import {
  buildTerminalFileUriJunctionCandidates,
  parseTerminalFileUriLinks,
  terminalFileUriLooksOpenAtEnd,
} from './terminalFileLinks.ts';

// 把一段文本铺成终端单元格：CJK（含全角标点）占 2 列并补一个宽度 0 的占位单元格，
// 其余字符占 1 列。用于在没有 xterm 运行时的情况下复刻 getCell/getWidth/getChars。
function lineFromText(text: string): TerminalLineForColumnMap {
  const cells: { chars: string; width: number }[] = [];
  for (const ch of text) {
    // eslint-disable-next-line no-irregular-whitespace -- 字符类以全角空格 U+3000 开区间，属有意为之
    const width = /[　-〿㐀-鿿＀-￯]/.test(ch) ? 2 : 1;
    cells.push({ chars: ch, width });
    if (width === 2) {
      cells.push({ chars: '', width: 0 });
    }
  }

  return {
    length: cells.length,
    getCell: (column) => {
      const cell = cells[column];
      if (!cell) {
        return undefined;
      }
      return {
        getWidth: () => cell.width,
        getChars: () => cell.chars,
      };
    },
  };
}

test('column map keeps ASCII string index equal to column', () => {
  const text = 'file:///Users/a/note.md';
  const map = buildTerminalLineColumnMap(lineFromText(text));
  assert.equal(map.length, text.length);
  for (let i = 0; i < text.length; i += 1) {
    assert.equal(map[i], i);
  }
});

test('column map shifts columns right for every preceding full-width char', () => {
  // "文件:" 占 5 列（2+2+1），随后的 file:// 应从第 5 列（0 基）开始。
  const text = '文件:file:///a/专家纪要.md';
  const map = buildTerminalLineColumnMap(lineFromText(text));
  const linkStart = text.indexOf('file://');
  assert.equal(map[linkStart], 5);

  // 末尾的 .md 里的 'd'：前面共有 6 个全角字符（文件 + 专家纪要），列号应比字符下标多 6。
  const lastIndex = text.length - 1;
  assert.equal(map[lastIndex], lastIndex + 6);
});

test('buffer position for a CJK line lands on the visible link cell (1-based)', () => {
  const prefix = '文件:';
  const text = `${prefix}file:///a/专家纪要.md`;
  const lineTexts = [text];
  const columnMaps = [buildTerminalLineColumnMap(lineFromText(text))];

  const linkStart = text.indexOf('file://');
  const start = terminalBufferPositionForStringIndex(linkStart, lineTexts, columnMaps, 0);
  // 旧实现会算成 x = linkStart + 1 = 4（落在「件」上）；正确应是第 6 列。
  assert.deepEqual(start, { x: 6, y: 1 });

  const end = terminalBufferPositionForStringIndex(text.length - 1, lineTexts, columnMaps, 0);
  assert.deepEqual(end, { x: text.length + 6, y: 1 });
});

test('buffer position spans wrapped rows and offsets y by start line', () => {
  const rows = ['file:///a/专', '家纪要.md'];
  const columnMaps = rows.map((row) => buildTerminalLineColumnMap(lineFromText(row)));
  const joined = rows.join('');

  // 第二可视行的首字符「家」：行内偏移 0 → 列 0 → x = 1，y = startLineIndex(5) + 1 + 1。
  const secondRowStart = terminalBufferPositionForStringIndex(rows[0].length, rows, columnMaps, 5);
  assert.deepEqual(secondRowStart, { x: 1, y: 7 });

  // 越界返回 null。
  assert.equal(terminalBufferPositionForStringIndex(joined.length, rows, columnMaps, 5), null);
});

// —— 跨硬换行的链接窗口 ——

function bufferLineFromText(text: string, isWrapped = false): TerminalBufferLineLike {
  const base = lineFromText(text);
  return {
    length: base.length,
    getCell: (column) => base.getCell(column),
    isWrapped,
    translateToString: () => text,
  };
}

function bufferFromLines(lines: TerminalBufferLineLike[]): TerminalBufferLike {
  return { getLine: (index) => lines[index] };
}

test('link window joins hard-wrapped rows and strips continuation indent', () => {
  // Claude Code 等 TUI 折长链接：每行是真实行（isWrapped=false），续行带版式缩进。
  const row0 = 'file:///Users/a/00 Temp/存储超级周期_长协扩';
  const row1 = '  产能_全综述.md';
  const buffer = bufferFromLines([bufferLineFromText(row0), bufferLineFromText(row1)]);
  const joined = `${row0}${row1.trimStart()}`;

  // 从首行或续行进入，都应得到同一个拼接窗口
  for (const lineNumber of [0, 1]) {
    const window = buildTerminalLinkWindow(buffer, lineNumber, terminalFileUriLooksOpenAtEnd);
    assert.ok(window);
    assert.equal(window.text, joined);
    assert.equal(window.startLineIndex, 0);
    assert.deepEqual(window.hardJunctions, [row0.length]);
  }

  // 拼接后整条链接应被完整识别
  const links = parseTerminalFileUriLinks(joined);
  assert.equal(links.length, 1);
  assert.equal(links[0].uri, joined);

  // 续行首字符「产」的点击热区应落在剥掉缩进后的真实列（0 基列 2 → x=3）
  const window = buildTerminalLinkWindow(buffer, 0, terminalFileUriLooksOpenAtEnd);
  assert.ok(window);
  const position = terminalBufferPositionForStringIndex(
    row0.length,
    window.lineTexts,
    window.columnMaps,
    window.startLineIndex,
  );
  assert.deepEqual(position, { x: 3, y: 2 });
});

test('link window keeps joining across digit-dot splits', () => {
  // "置身钉内_14.34.50.pdf" 在 ".34" 后被劈开：纯数字段不是扩展名，应继续拼。
  const row0 = 'file:///Users/a/00 Temp/置身钉内_14.34';
  const row1 = '.50.pdf';
  const buffer = bufferFromLines([bufferLineFromText(row0), bufferLineFromText(row1)]);

  const window = buildTerminalLinkWindow(buffer, 0, terminalFileUriLooksOpenAtEnd);
  assert.ok(window);
  assert.equal(window.text, `${row0}${row1}`);
  assert.equal(parseTerminalFileUriLinks(window.text)[0]?.uri, `${row0}${row1}`);
});

test('link window joins when the file:// prefix itself is split', () => {
  const row0 = 'open file:/';
  const row1 = '//Users/a/Note.md';
  const buffer = bufferFromLines([bufferLineFromText(row0), bufferLineFromText(row1)]);

  const window = buildTerminalLinkWindow(buffer, 0, terminalFileUriLooksOpenAtEnd);
  assert.ok(window);
  assert.equal(window.text, `${row0}${row1}`);
  assert.equal(parseTerminalFileUriLinks(window.text)[0]?.uri, 'file:///Users/a/Note.md');
});

test('link window bridges single-token middle rows when probing backwards', () => {
  // 三行劈分：悬停在最后一行时，要隔着「单 token 中段行」向上找到锚点行。
  const rows = [
    'file:///Users/a/%E5%AD%98%E5%82%A8%E8%B6%85',
    '%E7%BA%A7%E5%91%A8%E6%9C%9F_%E9%95%BF',
    '%E5%8D%8F.md',
  ];
  const buffer = bufferFromLines(rows.map((row) => bufferLineFromText(row)));

  const window = buildTerminalLinkWindow(buffer, 2, terminalFileUriLooksOpenAtEnd);
  assert.ok(window);
  assert.equal(window.text, rows.join(''));
  assert.equal(window.startLineIndex, 0);
  assert.deepEqual(window.hardJunctions, [rows[0].length, rows[0].length + rows[1].length]);
});

test('link window stops at blank lines', () => {
  const buffer = bufferFromLines([
    bufferLineFromText('file:///Users/a/No'),
    bufferLineFromText(''),
    bufferLineFromText('te.md'),
  ]);
  const window = buildTerminalLinkWindow(buffer, 0, terminalFileUriLooksOpenAtEnd);
  assert.equal(window?.text, 'file:///Users/a/No');
});

test('link window leaves complete links and prose rows alone', () => {
  // 链接已完整（.md 结尾）→ 不吞下一行
  const complete = bufferFromLines([
    bufferLineFromText('file:///Users/a/Note.md'),
    bufferLineFromText('next prose line'),
  ]);
  assert.equal(
    buildTerminalLinkWindow(complete, 0, terminalFileUriLooksOpenAtEnd)?.text,
    'file:///Users/a/Note.md',
  );

  // 上一行是带空格的普通文字（非中段行、链接已闭合）→ 不向上拼
  const prose = bufferFromLines([
    bufferLineFromText('  3. file:///Users/a/Note.md'),
    bufferLineFromText('  4. file:///Users/a/Other.md'),
  ]);
  const window = buildTerminalLinkWindow(prose, 1, terminalFileUriLooksOpenAtEnd);
  assert.equal(window?.text, '  4. file:///Users/a/Other.md');
  assert.equal(window?.startLineIndex, 1);
});

test('link window records junctions so word-wrap-eaten spaces can be recovered', () => {
  // ink 按词折行：断点处的空格被吃掉（"00 Temp" → "00"+"Temp"）。
  const row0 = 'file:///Users/a/Nutstore Files/Nutstore/00';
  const row1 = '  Temp/AVGO 26Q1 CB.md';
  const buffer = bufferFromLines([bufferLineFromText(row0), bufferLineFromText(row1)]);

  const window = buildTerminalLinkWindow(buffer, 0, terminalFileUriLooksOpenAtEnd);
  assert.ok(window);
  const link = parseTerminalFileUriLinks(window.text)[0];
  assert.ok(link);

  const junctions = window.hardJunctions
    .filter((junction) => junction > link.startIndex && junction < link.endIndex)
    .map((junction) => junction - link.startIndex);
  const candidates = buildTerminalFileUriJunctionCandidates(link.uri, junctions);
  assert.ok(candidates.includes('file:///Users/a/Nutstore Files/Nutstore/00 Temp/AVGO 26Q1 CB.md'));
});

test('link window still joins soft-wrapped rows without stripping indent', () => {
  // 软换行（isWrapped=true）行首空格是内容的一部分，不能剥，也不算硬拼接点。
  const buffer = bufferFromLines([
    bufferLineFromText('file:///Users/a/fo'),
    bufferLineFromText('  o.md', true),
  ]);
  const window = buildTerminalLinkWindow(buffer, 1, terminalFileUriLooksOpenAtEnd);
  assert.ok(window);
  assert.equal(window.text, 'file:///Users/a/fo  o.md');
  assert.deepEqual(window.hardJunctions, []);
});

test('consecutive wrapped links stay separate (screenshot regression)', () => {
  // 实测回归：两条链接各折成两行、上下相邻。悬停在第二条链接的首行时，
  // 窗口会向上桥接到第一条链接，但解析必须把两条链接分开，
  // 且只有覆盖悬停行的那条（第二条）会被返回。
  const rows = [
    'file:///Users/a/Nutstore Files/Nutstore/00',
    'Temp/存储超级周期_长协扩产产能_全综述_20260610.md#L12',
    'file:///Users/a/Nutstore Files/Nutstore/00',
    'Temp/置身钉内_14.34.50.pdf',
  ];
  const buffer = bufferFromLines(rows.map((row) => bufferLineFromText(row)));

  const hoveredLine = 2; // 第二条链接的首行（截图中的红色光标位置）
  const window = buildTerminalLinkWindow(buffer, hoveredLine, terminalFileUriLooksOpenAtEnd);
  assert.ok(window);

  const links = parseTerminalFileUriLinks(window.text);
  assert.equal(links.length, 2);
  assert.equal(links[0].uri, `${rows[0]}${rows[1]}`);
  assert.equal(links[1].uri, `${rows[2]}${rows[3]}`);

  // 第二条链接的起点应落在悬停行（y = hoveredLine + 1，1 基）
  const start = terminalBufferPositionForStringIndex(
    links[1].startIndex,
    window.lineTexts,
    window.columnMaps,
    window.startLineIndex,
  );
  assert.equal(start?.y, hoveredLine + 1);
});

test('mid-line link references join across wraps like line-start ones', () => {
  // agent 常见写法：链接出现在行中而非行首，折行后同样要能拼回完整链接。
  const rows = [
    '已经写到 file:///Users/a/00 Temp/存储超级周期_长协扩',
    '产产能_全综述_20260610.md 里了',
  ];
  const buffer = bufferFromLines(rows.map((row) => bufferLineFromText(row)));

  for (const lineNumber of [0, 1]) {
    const window = buildTerminalLinkWindow(buffer, lineNumber, terminalFileUriLooksOpenAtEnd);
    assert.ok(window);
    assert.equal(
      parseTerminalFileUriLinks(window.text)[0]?.uri,
      'file:///Users/a/00 Temp/存储超级周期_长协扩产产能_全综述_20260610.md',
    );
  }
});
