import test from 'node:test';
import assert from 'node:assert/strict';

import { resetElapsedPercent } from './creditProgress.ts';

test('resetElapsedPercent preserves sub-percent progress for short quota windows', () => {
  const nowMs = 1_000_000;
  const windowMs = 5 * 60 * 60 * 1000;
  const resetAtMs = nowMs + windowMs - 60_000;

  assert.equal(resetElapsedPercent(resetAtMs, windowMs, nowMs), 0.333);
});

test('resetElapsedPercent returns to zero when the quota window expires', () => {
  const nowMs = 1_000_000;

  assert.equal(resetElapsedPercent(nowMs, 5 * 60 * 60 * 1000, nowMs), 0);
  assert.equal(resetElapsedPercent(nowMs - 1, 5 * 60 * 60 * 1000, nowMs), 0);
});

test('resetElapsedPercent clamps invalid or out-of-window values', () => {
  const nowMs = 1_000_000;
  const windowMs = 5 * 60 * 60 * 1000;

  assert.equal(resetElapsedPercent(nowMs + windowMs + 1, windowMs, nowMs), 0);
  assert.equal(resetElapsedPercent(null, windowMs, nowMs), null);
  assert.equal(resetElapsedPercent(nowMs + windowMs, 0, nowMs), null);
});
