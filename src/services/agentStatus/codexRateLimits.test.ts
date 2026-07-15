import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyCodexRateLimitWindows } from './codexRateLimits.ts';

test('classifies the current weekly-only Codex window from primary', () => {
  const primary = {
    usedPercent: 2,
    windowDurationMins: 10_080,
    resetsAt: 1_784_507_610,
  };

  assert.deepEqual(classifyCodexRateLimitWindows({
    primary,
    secondary: null,
  }), {
    fiveHour: null,
    weekly: primary,
  });
});

test('classifies legacy dual Codex windows by duration', () => {
  const primary = { usedPercent: 20, windowDurationMins: 300 };
  const secondary = { usedPercent: 40, windowDurationMins: 10_080 };

  assert.deepEqual(classifyCodexRateLimitWindows({ primary, secondary }), {
    fiveHour: primary,
    weekly: secondary,
  });
});

test('falls back to legacy primary and secondary positions without duration metadata', () => {
  const primary = { usedPercent: 20 };
  const secondary = { usedPercent: 40 };

  assert.deepEqual(classifyCodexRateLimitWindows({ primary, secondary }), {
    fiveHour: primary,
    weekly: secondary,
  });
});
