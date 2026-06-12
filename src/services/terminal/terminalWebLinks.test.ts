import * as assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeTerminalWebLinkTarget,
  parseTerminalWebLinks,
  terminalWebUrlLooksLikeContinuation,
  terminalWebUrlLooksOpenAtEnd,
} from './terminalWebLinks.ts';

test('parseTerminalWebLinks detects http and https URLs case-insensitively', () => {
  const first = 'Https://example.com/path?q=one#section';
  const second = 'http://localhost:3000/status';
  const text = `open ${first} and ${second}`;

  assert.deepEqual(parseTerminalWebLinks(text), [
    {
      uri: first,
      startIndex: 5,
      endIndex: 5 + first.length,
    },
    {
      uri: second,
      startIndex: 10 + first.length,
      endIndex: 10 + first.length + second.length,
    },
  ]);
});

test('normalizeTerminalWebLinkTarget trims wrappers and sentence punctuation', () => {
  assert.equal(
    normalizeTerminalWebLinkTarget('(https://example.com/docs/page).'),
    'https://example.com/docs/page',
  );
  assert.equal(
    normalizeTerminalWebLinkTarget('<https://example.com/docs/page>,'),
    'https://example.com/docs/page',
  );
});

test('parseTerminalWebLinks ignores malformed URLs', () => {
  assert.deepEqual(parseTerminalWebLinks('https:// file://example.com'), []);
});

test('terminalWebUrlLooksOpenAtEnd detects split prefixes and URL tails', () => {
  assert.equal(terminalWebUrlLooksOpenAtEnd('see https:/'), true);
  assert.equal(terminalWebUrlLooksOpenAtEnd('see htt'), true);
  assert.equal(terminalWebUrlLooksOpenAtEnd('see https://example.com/docs/'), true);
  assert.equal(terminalWebUrlLooksOpenAtEnd('see https://example.com/docs/ done'), false);
  assert.equal(terminalWebUrlLooksOpenAtEnd('no URL here'), false);
});

test('terminalWebUrlLooksLikeContinuation accepts URL-shaped fragments only', () => {
  assert.equal(terminalWebUrlLooksLikeContinuation('/next/path'), true);
  assert.equal(terminalWebUrlLooksLikeContinuation('  ?q=value'), true);
  assert.equal(terminalWebUrlLooksLikeContinuation('mple.com/path'), true);
  assert.equal(terminalWebUrlLooksLikeContinuation('plain prose'), false);
  assert.equal(terminalWebUrlLooksLikeContinuation('https://example.com/other'), false);
});
