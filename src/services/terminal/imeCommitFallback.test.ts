import * as assert from 'node:assert/strict';
import test from 'node:test';

import {
  isImeCommitFallbackText,
  shouldBypassKeyboardEncodingForTextKey,
} from './imeCommitFallback.ts';

test('isImeCommitFallbackText accepts fullwidth punctuation', () => {
  assert.equal(isImeCommitFallbackText('，'), true);
  assert.equal(isImeCommitFallbackText('。'), true);
  assert.equal(isImeCommitFallbackText('（）'), true);
});

test('isImeCommitFallbackText accepts non-ascii committed text', () => {
  assert.equal(isImeCommitFallbackText('你好'), true);
  assert.equal(isImeCommitFallbackText('path：value'), true);
});

test('isImeCommitFallbackText rejects ascii and empty text', () => {
  assert.equal(isImeCommitFallbackText(''), false);
  assert.equal(isImeCommitFallbackText('abc'), false);
  assert.equal(isImeCommitFallbackText('!?,.'), false);
  assert.equal(isImeCommitFallbackText(null), false);
  assert.equal(isImeCommitFallbackText(undefined), false);
});

test('isImeCommitFallbackText rejects control sequences', () => {
  assert.equal(isImeCommitFallbackText('\r'), false);
  assert.equal(isImeCommitFallbackText('\u001b[A'), false);
  assert.equal(isImeCommitFallbackText('，\n'), false);
});

test('shouldBypassKeyboardEncodingForTextKey accepts printable text events', () => {
  assert.equal(shouldBypassKeyboardEncodingForTextKey({ type: 'keydown', key: ',' }), true);
  assert.equal(shouldBypassKeyboardEncodingForTextKey({ type: 'keypress', key: '.' }), true);
  assert.equal(
    shouldBypassKeyboardEncodingForTextKey({ type: 'keydown', key: '?', shiftKey: true }),
    true,
  );
  assert.equal(
    shouldBypassKeyboardEncodingForTextKey({ type: 'keydown', key: ' ', code: 'Space' }),
    true,
  );
  assert.equal(
    shouldBypassKeyboardEncodingForTextKey({ type: 'keydown', key: 'a', code: 'KeyA' }),
    true,
  );
  assert.equal(
    shouldBypassKeyboardEncodingForTextKey({ type: 'keydown', key: '1', code: 'Digit1' }),
    true,
  );
});

test('shouldBypassKeyboardEncodingForTextKey accepts text-producing physical keys', () => {
  assert.equal(
    shouldBypassKeyboardEncodingForTextKey({ type: 'keydown', key: '1', code: 'Digit1', shiftKey: true }),
    true,
  );
  assert.equal(
    shouldBypassKeyboardEncodingForTextKey({ type: 'keydown', key: 'Dead', code: 'Quote' }),
    true,
  );
  assert.equal(
    shouldBypassKeyboardEncodingForTextKey({ type: 'keydown', key: 'Unidentified', code: 'Slash', shiftKey: true }),
    true,
  );
});

test('shouldBypassKeyboardEncodingForTextKey rejects control keys and shortcuts', () => {
  assert.equal(shouldBypassKeyboardEncodingForTextKey({ type: 'keyup', key: ',' }), false);
  assert.equal(shouldBypassKeyboardEncodingForTextKey({ type: 'keydown', key: 'Enter' }), false);
  assert.equal(shouldBypassKeyboardEncodingForTextKey({ type: 'keydown', key: 'ArrowLeft' }), false);
  assert.equal(
    shouldBypassKeyboardEncodingForTextKey({ type: 'keydown', key: ',', metaKey: true }),
    false,
  );
  assert.equal(
    shouldBypassKeyboardEncodingForTextKey({ type: 'keydown', key: ',', ctrlKey: true }),
    false,
  );
  assert.equal(
    shouldBypassKeyboardEncodingForTextKey({ type: 'keydown', key: ',', altKey: true }),
    true,
  );
});
