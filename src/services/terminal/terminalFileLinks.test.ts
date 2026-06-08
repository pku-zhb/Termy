import * as assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeTerminalFileUriLinkTarget,
  parseTerminalFileUriReference,
  parseTerminalFileUriLinks,
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
