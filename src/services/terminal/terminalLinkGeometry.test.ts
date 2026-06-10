import * as assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTerminalLineColumnMap,
  terminalBufferPositionForStringIndex,
  type TerminalLineForColumnMap,
} from './terminalLinkGeometry.ts';

// 把一段文本铺成终端单元格：CJK（含全角标点）占 2 列并补一个宽度 0 的占位单元格，
// 其余字符占 1 列。用于在没有 xterm 运行时的情况下复刻 getCell/getWidth/getChars。
function lineFromText(text: string): TerminalLineForColumnMap {
  const cells: { chars: string; width: number }[] = [];
  for (const ch of text) {
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
