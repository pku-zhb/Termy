import * as assert from 'node:assert/strict';
import test from 'node:test';

import { computeImeCompositionViewLayout } from './imeCompositionView.ts';

test('computeImeCompositionViewLayout uses full terminal width with first-line cursor indent', () => {
  assert.deepEqual(
    computeImeCompositionViewLayout({
      screenWidth: 800,
      screenHeight: 400,
      cursorLeft: 560,
      cursorTop: 120,
      cellHeight: 20,
      contentHeight: 20,
      padding: 4,
      maxRows: 6,
    }),
    {
      width: 796,
      left: 0,
      top: 120,
      textIndent: 560,
      maxHeight: 120,
      visibleHeight: 20,
    },
  );
});

test('computeImeCompositionViewLayout keeps later wrapped lines full width near the right edge', () => {
  assert.deepEqual(
    computeImeCompositionViewLayout({
      screenWidth: 800,
      screenHeight: 400,
      cursorLeft: 799,
      cursorTop: 120,
      cellHeight: 20,
      contentHeight: 40,
      padding: 4,
    }),
    {
      width: 796,
      left: 0,
      top: 120,
      textIndent: 795,
      maxHeight: 120,
      visibleHeight: 40,
    },
  );
});

test('computeImeCompositionViewLayout floats upward when composition would leave the screen', () => {
  assert.deepEqual(
    computeImeCompositionViewLayout({
      screenWidth: 800,
      screenHeight: 160,
      cursorLeft: 10,
      cursorTop: 130,
      cellHeight: 20,
      contentHeight: 80,
      padding: 4,
      maxRows: 6,
    }),
    {
      width: 796,
      left: 0,
      top: 76,
      textIndent: 10,
      maxHeight: 120,
      visibleHeight: 80,
    },
  );
});

test('computeImeCompositionViewLayout caps tall voice composition previews', () => {
  assert.deepEqual(
    computeImeCompositionViewLayout({
      screenWidth: 800,
      screenHeight: 260,
      cursorLeft: 10,
      cursorTop: 230,
      cellHeight: 20,
      contentHeight: 300,
      padding: 4,
      maxRows: 6,
    }),
    {
      width: 796,
      left: 0,
      top: 136,
      textIndent: 10,
      maxHeight: 120,
      visibleHeight: 120,
    },
  );
});
