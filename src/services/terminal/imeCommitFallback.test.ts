import * as assert from 'node:assert/strict';
import test from 'node:test';

import {
  isImeCommitFallbackText,
  shouldBypassKeyboardEncodingForTextKey,
  shouldScheduleImeCommitFallbackForBeforeInput,
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

test('shouldScheduleImeCommitFallbackForBeforeInput skips mid-composition partials', () => {
  // 流式语音输入法：每个中间识别结果都是 insertCompositionText，合成进行中，绝不补发。
  assert.equal(
    shouldScheduleImeCommitFallbackForBeforeInput({ inputType: 'insertCompositionText' }, true),
    false,
  );
  assert.equal(
    shouldScheduleImeCommitFallbackForBeforeInput({ inputType: 'insertCompositionText' }, false),
    false,
  );
  // 即便是 insertText，只要还在合成态，也不能逐段补发。
  assert.equal(
    shouldScheduleImeCommitFallbackForBeforeInput({ inputType: 'insertText' }, true),
    false,
  );
});

test('shouldScheduleImeCommitFallbackForBeforeInput arms on non-composition insertText', () => {
  assert.equal(
    shouldScheduleImeCommitFallbackForBeforeInput({ inputType: 'insertText' }, false),
    true,
  );
});

test('shouldScheduleImeCommitFallbackForBeforeInput ignores deletions and other input types', () => {
  assert.equal(
    shouldScheduleImeCommitFallbackForBeforeInput({ inputType: 'deleteContentBackward' }, false),
    false,
  );
  assert.equal(
    shouldScheduleImeCommitFallbackForBeforeInput({ inputType: 'insertFromPaste' }, false),
    false,
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
