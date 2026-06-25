import * as assert from 'node:assert/strict';
import test from 'node:test';

import { computeImeCompositionViewBounds } from './imeCompositionView.ts';

test('computeImeCompositionViewBounds clamps width to the remaining cursor row', () => {
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
      maxWidth: 236,
      maxHeight: 120,
    },
  );
});

test('computeImeCompositionViewBounds keeps a visible one-pixel width at the right edge', () => {
  assert.equal(
    computeImeCompositionViewBounds({
      screenWidth: 800,
      screenHeight: 400,
      cursorLeft: 799,
      cursorTop: 120,
      cellHeight: 20,
      padding: 4,
    }).maxWidth,
    1,
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
