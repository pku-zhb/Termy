import * as assert from 'node:assert/strict';
import test from 'node:test';

import { computeImeCompositionViewBounds } from './imeCompositionView.ts';

test('computeImeCompositionViewBounds uses full terminal width with first-line cursor indent', () => {
  assert.deepEqual(
    computeImeCompositionViewBounds({
      screenWidth: 800,
      screenHeight: 400,
      cursorLeft: 560,
      cursorTop: 120,
      cellHeight: 20,
      padding: 4,
      maxRows: 6,
    }),
    {
      width: 796,
      left: 0,
      textIndent: 560,
      maxHeight: 120,
    },
  );
});

test('computeImeCompositionViewBounds keeps later wrapped lines full width near the right edge', () => {
  assert.deepEqual(
    computeImeCompositionViewBounds({
      screenWidth: 800,
      screenHeight: 400,
      cursorLeft: 799,
      cursorTop: 120,
      cellHeight: 20,
      padding: 4,
    }),
    {
      width: 796,
      left: 0,
      textIndent: 795,
      maxHeight: 120,
    },
  );
});

test('computeImeCompositionViewBounds caps height by visible space below the cursor', () => {
  assert.equal(
    computeImeCompositionViewBounds({
      screenWidth: 800,
      screenHeight: 160,
      cursorLeft: 10,
      cursorTop: 130,
      cellHeight: 20,
      padding: 4,
      maxRows: 6,
    }).maxHeight,
    26,
  );
});
