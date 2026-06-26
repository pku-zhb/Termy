import * as assert from 'node:assert/strict';
import test from 'node:test';

import { parseTerminalVaultPathLinks, type VaultPathResolver } from './terminalVaultPathLinks.ts';

const HOME = '/Users/zhuhuibin';
const VAULT = '/Users/zhuhuibin/Nutstore Files/Nutstore';

// Fake resolver mirroring TerminalView.resolveTerminalVaultPathCandidate: a candidate
// counts as a real file if, taken as absolute / $HOME-relative / vault-root-relative,
// it lands on one of the known vault files.
const REAL_FILES = new Set([
  `${VAULT}/00 Temp/note.md`,
  `${VAULT}/00 Temp/英伟达NVIDIA 2026年股东大会.md`,
  `${VAULT}/01 Research/semi/deck.md`,
]);

const fakeResolve: VaultPathResolver = (candidate) => {
  const tries: string[] = [];
  if (candidate.startsWith('/')) {
    tries.push(candidate);
  }
  tries.push(`${HOME}/${candidate}`);
  tries.push(`${VAULT}/${candidate}`);
  return tries.find((path) => REAL_FILES.has(path)) ?? null;
};

const sliceLink = (text: string, link: { startIndex: number; endIndex: number }): string =>
  text.slice(link.startIndex, link.endIndex);

test('absolute path with :line resolves to the vault file and parses the line', () => {
  const text = '/Users/zhuhuibin/Nutstore Files/Nutstore/00 Temp/note.md:12';
  const links = parseTerminalVaultPathLinks(text, fakeResolve);
  assert.equal(links.length, 1);
  assert.equal(links[0].absolutePath, `${VAULT}/00 Temp/note.md`);
  assert.equal(links[0].line, 12);
  assert.equal(sliceLink(text, links[0]), text);
});

test('$HOME-relative path (Codex default render) resolves without a line', () => {
  const text = 'Nutstore Files/Nutstore/00 Temp/note.md';
  const links = parseTerminalVaultPathLinks(text, fakeResolve);
  assert.equal(links.length, 1);
  assert.equal(links[0].absolutePath, `${VAULT}/00 Temp/note.md`);
  assert.equal(links[0].line, undefined);
  assert.equal(sliceLink(text, links[0]), text);
});

test('$HOME-relative path with :1 keeps the line', () => {
  const text = 'Nutstore Files/Nutstore/00 Temp/note.md:1';
  const links = parseTerminalVaultPathLinks(text, fakeResolve);
  assert.equal(links.length, 1);
  assert.equal(links[0].line, 1);
});

test('CJK filename with internal spaces embedded in Chinese prose', () => {
  const path = 'Nutstore Files/Nutstore/00 Temp/英伟达NVIDIA 2026年股东大会.md';
  const text = `已存到 ${path}，请查收`;
  const links = parseTerminalVaultPathLinks(text, fakeResolve);
  assert.equal(links.length, 1);
  assert.equal(links[0].absolutePath, `${VAULT}/00 Temp/英伟达NVIDIA 2026年股东大会.md`);
  assert.equal(sliceLink(text, links[0]), path);
});

test('non-existent file is not linkified', () => {
  const text = 'Nutstore Files/Nutstore/00 Temp/ghost.md';
  assert.deepEqual(parseTerminalVaultPathLinks(text, fakeResolve), []);
});

test('non-vault absolute path is not linkified (noise control)', () => {
  const text = 'see /usr/bin/script.sh for details';
  assert.deepEqual(parseTerminalVaultPathLinks(text, fakeResolve), []);
});

test('does not re-linkify a file:// URI (no double underline with the file:// parser)', () => {
  const text = 'file:///Users/zhuhuibin/Nutstore Files/Nutstore/00 Temp/note.md';
  assert.deepEqual(parseTerminalVaultPathLinks(text, fakeResolve), []);
});

test('two distinct cited paths on one line both resolve, non-overlapping', () => {
  const a = 'Nutstore Files/Nutstore/00 Temp/note.md';
  const b = 'Nutstore Files/Nutstore/01 Research/semi/deck.md:5';
  const text = `compare ${a} and ${b} please`;
  const links = parseTerminalVaultPathLinks(text, fakeResolve);
  assert.equal(links.length, 2);
  assert.equal(links[0].absolutePath, `${VAULT}/00 Temp/note.md`);
  assert.equal(links[1].absolutePath, `${VAULT}/01 Research/semi/deck.md`);
  assert.equal(links[1].line, 5);
  assert.ok(links[0].endIndex <= links[1].startIndex);
});

test('trailing sentence period is not swallowed into the path', () => {
  const text = 'saved to Nutstore Files/Nutstore/00 Temp/note.md.';
  const links = parseTerminalVaultPathLinks(text, fakeResolve);
  assert.equal(links.length, 1);
  assert.equal(sliceLink(text, links[0]), 'Nutstore Files/Nutstore/00 Temp/note.md');
});
