import * as assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTerminalFileUriJunctionCandidates,
  normalizeTerminalFileUriLinkTarget,
  parseTerminalFileUriReference,
  parseTerminalFileUriLinks,
  terminalFileUriLooksOpenAtEnd,
} from './terminalFileLinks.ts';

test('parseTerminalFileUriLinks detects encoded Claude Code file URLs', () => {
  const text = 'Open file:///Users/example/Documents/Notes/%E7%A4%BA%E4%BE%8B%E7%AC%94%E8%AE%B0.md now';

  assert.deepEqual(parseTerminalFileUriLinks(text), [
    {
      uri: 'file:///Users/example/Documents/Notes/%E7%A4%BA%E4%BE%8B%E7%AC%94%E8%AE%B0.md',
      startIndex: 5,
      endIndex: text.indexOf(' now'),
    },
  ]);
});

test('parseTerminalFileUriLinks trims common wrapper and sentence punctuation', () => {
  const text = '(file:///Users/test/Note%20One.md), then <file:///Users/test/Other.md>.';

  assert.deepEqual(parseTerminalFileUriLinks(text), [
    {
      uri: 'file:///Users/test/Note%20One.md',
      startIndex: 1,
      endIndex: 33,
    },
    {
      uri: 'file:///Users/test/Other.md',
      startIndex: 42,
      endIndex: 69,
    },
  ]);
});

test('parseTerminalFileUriLinks detects raw file URLs with spaces', () => {
  const uri = 'file:///Users/example/Documents/Notes/Folder With Spaces/link-test.md';
  const text = `open ${uri} now`;

  assert.deepEqual(parseTerminalFileUriLinks(text), [
    {
      uri,
      startIndex: 5,
      endIndex: 5 + uri.length,
    },
  ]);
});

test('parseTerminalFileUriLinks keeps multiple raw-space file URLs separate', () => {
  const firstUri = 'file:///Users/example/Documents/Notes/Folder With Spaces/first note.md';
  const secondUri = 'file:///Users/example/Documents/Notes/Folder With Spaces/second note.md';
  const text = `${firstUri}, then ${secondUri}.`;
  const secondStartIndex = firstUri.length + ', then '.length;

  assert.deepEqual(parseTerminalFileUriLinks(text), [
    {
      uri: firstUri,
      startIndex: 0,
      endIndex: firstUri.length,
    },
    {
      uri: secondUri,
      startIndex: secondStartIndex,
      endIndex: secondStartIndex + secondUri.length,
    },
  ]);
});

test('normalizeTerminalFileUriLinkTarget trims trailing prose from broad matches', () => {
  assert.equal(
    normalizeTerminalFileUriLinkTarget('file:///Users/example/Documents/My Note.md now'),
    'file:///Users/example/Documents/My Note.md',
  );
});

test('normalizeTerminalFileUriLinkTarget keeps dotted directory segments before a space', () => {
  // 回归：目录名带点号又紧跟空格（v1.2 data / 2024.01 archive）时不应在中途截断。
  assert.equal(
    normalizeTerminalFileUriLinkTarget('file:///Users/x/v1.2 data/My File.md'),
    'file:///Users/x/v1.2 data/My File.md',
  );
  assert.equal(
    normalizeTerminalFileUriLinkTarget('file:///Users/x/2024.01 archive/Note.md'),
    'file:///Users/x/2024.01 archive/Note.md',
  );
});

test('normalizeTerminalFileUriLinkTarget still trims prose after a dotted directory path', () => {
  // 即便路径含点号目录段，链接后面的正文（含 .ext）仍应被裁掉。
  assert.equal(
    normalizeTerminalFileUriLinkTarget('file:///Users/x/v1.2 data/Note.md see config.json'),
    'file:///Users/x/v1.2 data/Note.md',
  );
});

test('parseTerminalFileUriLinks detects raw file URLs with dotted directory segments', () => {
  const uri = 'file:///Users/example/v1.2 data/link-test.md';
  const text = `open ${uri} now`;

  assert.deepEqual(parseTerminalFileUriLinks(text), [
    {
      uri,
      startIndex: 5,
      endIndex: 5 + uri.length,
    },
  ]);
});

test('parseTerminalFileUriLinks includes line suffixes in clickable ranges', () => {
  const uri = 'file:///Users/example/Documents/Notes/Example.md#L42';
  const text = `open ${uri} now`;

  assert.deepEqual(parseTerminalFileUriLinks(text), [
    {
      uri,
      startIndex: 5,
      endIndex: 5 + uri.length,
    },
  ]);
});

test('parseTerminalFileUriReference extracts hash line references', () => {
  assert.deepEqual(
    parseTerminalFileUriReference('file:///Users/example/Documents/Notes/Example.md#L42'),
    {
      uri: 'file:///Users/example/Documents/Notes/Example.md',
      line: 42,
    },
  );
  assert.deepEqual(
    parseTerminalFileUriReference('file:///Users/example/Documents/Notes/Example.md#line=7'),
    {
      uri: 'file:///Users/example/Documents/Notes/Example.md',
      line: 7,
    },
  );
});

test('parseTerminalFileUriReference extracts query line references', () => {
  assert.deepEqual(
    parseTerminalFileUriReference('file:///Users/example/Documents/Notes/Example.md?line=9'),
    {
      uri: 'file:///Users/example/Documents/Notes/Example.md',
      line: 9,
    },
  );
});

test('parseTerminalFileUriReference extracts colon line suffixes', () => {
  assert.deepEqual(
    parseTerminalFileUriReference('file:///Users/example/Documents/Notes/Example.md:12'),
    {
      uri: 'file:///Users/example/Documents/Notes/Example.md',
      line: 12,
    },
  );
});

test('parseTerminalFileUriLinks ignores non-file URLs', () => {
  assert.deepEqual(
    parseTerminalFileUriLinks('https://example.com file-ish:///tmp/Nope.md'),
    [],
  );
});

test('terminalFileUriLooksOpenAtEnd treats extensionless tails as unfinished', () => {
  // 被硬换行劈开、还没露出扩展名的几种真实形态
  assert.equal(terminalFileUriLooksOpenAtEnd('see file:///Users/a/Nutstore Fi'), true);
  assert.equal(terminalFileUriLooksOpenAtEnd('file:///Users/a/00 Temp/存储超级周期_长协扩'), true);
  assert.equal(terminalFileUriLooksOpenAtEnd('file:///Users/a/%E5%AD%98%E5%82'), true);
});

test('terminalFileUriLooksOpenAtEnd treats digit-only dot tails as split filenames', () => {
  // "置身钉内_14.34.50.pdf" 在 ".34" 后被劈开：纯数字段不是扩展名
  assert.equal(terminalFileUriLooksOpenAtEnd('file:///Users/a/置身钉内_14.34'), true);
});

test('terminalFileUriLooksOpenAtEnd ignores directory dots before the basename', () => {
  assert.equal(terminalFileUriLooksOpenAtEnd('file:///Users/a/.obsidian/plug'), true);
});

test('terminalFileUriLooksOpenAtEnd detects a split file:// prefix at a boundary', () => {
  assert.equal(terminalFileUriLooksOpenAtEnd('open file:/'), true);
  assert.equal(terminalFileUriLooksOpenAtEnd('open fil'), true);
  // 普通单词结尾不是前缀残段
  assert.equal(terminalFileUriLooksOpenAtEnd('bookshelf'), false);
});

test('terminalFileUriLooksOpenAtEnd leaves complete links alone', () => {
  assert.equal(terminalFileUriLooksOpenAtEnd('file:///Users/a/Note.md'), false);
  assert.equal(terminalFileUriLooksOpenAtEnd('file:///Users/a/Note.md#L12'), false);
  assert.equal(terminalFileUriLooksOpenAtEnd('file:///Users/a/AVGO 26Q1 CB.md'), false);
  assert.equal(terminalFileUriLooksOpenAtEnd('file:///Users/a/Note.md 已经打开'), false);
  assert.equal(terminalFileUriLooksOpenAtEnd('no links here'), false);
  assert.equal(terminalFileUriLooksOpenAtEnd(''), false);
});

test('buildTerminalFileUriJunctionCandidates orders exact, spaced, then truncated', () => {
  const text = 'file:///a/00Temp/N.md';
  const junction = text.indexOf('Temp');
  assert.deepEqual(buildTerminalFileUriJunctionCandidates(text, [junction]), [
    text,
    'file:///a/00 Temp/N.md',
    'file:///a/00',
  ]);
  // 无拼接点 / 越界拼接点 → 只有原样
  assert.deepEqual(buildTerminalFileUriJunctionCandidates(text, []), [text]);
  assert.deepEqual(buildTerminalFileUriJunctionCandidates(text, [0, text.length, -3]), [text]);
});

test('buildTerminalFileUriJunctionCandidates enumerates small combinations by size', () => {
  assert.deepEqual(buildTerminalFileUriJunctionCandidates('abcdef', [2, 4]), [
    'abcdef',
    'ab cdef',
    'abcd ef',
    'ab cd ef',
    'abcd',
    'ab',
  ]);
});

test('parseTerminalFileUriLinks splits links glued together by hard-wrap joins', () => {
  // 回归：相邻两条链接被硬换行拼接粘连时（"…md#L12file:///…"），
  // 锚点的字符类不能把下一条链接吞进来，必须各自独立成链。
  const first = 'file:///Users/a/00Temp/存储_全综述.md#L12';
  const second = 'file:///Users/a/00Temp/置身钉内_14.34.50.pdf';
  const links = parseTerminalFileUriLinks(`${first}${second}`);

  assert.deepEqual(links, [
    { uri: first, startIndex: 0, endIndex: first.length },
    { uri: second, startIndex: first.length, endIndex: first.length + second.length },
  ]);
});
