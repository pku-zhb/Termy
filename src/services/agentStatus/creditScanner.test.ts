import test from 'node:test';
import assert from 'node:assert/strict';

import { CreditScanner } from './creditScanner.ts';
import type { AgentCommandOptions, AgentCommandResult, AgentStatusRuntime } from './runtime.ts';

class FakeRuntime implements AgentStatusRuntime {
  platform: NodeJS.Platform = 'darwin';
  homeDir = '/Users/example';
  readonly files = new Map<string, string>();

  async runCommand(
    _executable: string,
    _args: string[],
    _options?: AgentCommandOptions,
  ): Promise<AgentCommandResult | null> {
    return null;
  }

  async fileExists(_path: string): Promise<boolean> { return false; }
  async readTextFile(path: string): Promise<string | null> { return this.files.get(path) ?? null; }
  async readDir(_path: string): Promise<string[] | null> { return null; }
}

test('CreditScanner reads Claude cached session, weekly, and Fable weekly windows', async () => {
  const runtime = new FakeRuntime();
  const fiveHourReset = '2026-07-19T10:00:00.000Z';
  const weeklyReset = '2026-07-20T10:00:00.000Z';
  const fableReset = '2026-07-21T10:00:00.000Z';
  runtime.files.set('/Users/example/.claude.json', JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: Date.now(),
      utilization: {
        five_hour: { utilization: 3, resets_at: fiveHourReset },
        seven_day: { utilization: 7, resets_at: weeklyReset },
        limits: [
          {
            kind: 'session',
            group: 'session',
            percent: 12,
            resets_at: fiveHourReset,
          },
          {
            kind: 'weekly_all',
            group: 'weekly',
            percent: 34,
            resets_at: weeklyReset,
          },
          {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 56,
            resets_at: fableReset,
            scope: {
              model: {
                id: 'claude-fable-5',
                display_name: 'Fable',
              },
            },
          },
        ],
      },
    },
  }));

  const snapshot = await new CreditScanner(runtime).scan();

  assert.equal(snapshot.codex, null);
  assert.equal(snapshot.claude?.source, 'claude-cache');
  assert.equal(snapshot.claude?.fiveHourRemainingPercent, 88);
  assert.equal(snapshot.claude?.weeklyRemainingPercent, 66);
  assert.deepEqual(snapshot.claude?.windows, [
    {
      id: 'five-hour',
      label: '5h',
      usedPercent: 12,
      resetAtMs: Date.parse(fiveHourReset),
      windowMs: 5 * 60 * 60 * 1000,
    },
    {
      id: 'weekly-all',
      label: 'W',
      usedPercent: 34,
      resetAtMs: Date.parse(weeklyReset),
      windowMs: 7 * 24 * 60 * 60 * 1000,
    },
    {
      id: 'weekly-fable',
      label: 'F',
      usedPercent: 56,
      resetAtMs: Date.parse(fableReset),
      windowMs: 7 * 24 * 60 * 60 * 1000,
    },
  ]);
});

test('CreditScanner ignores stale Claude usage cache', async () => {
  const runtime = new FakeRuntime();
  runtime.files.set('/Users/example/.claude.json', JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: Date.now() - 25 * 60 * 60 * 1000,
      utilization: {
        limits: [
          { kind: 'session', percent: 10 },
        ],
      },
    },
  }));

  const snapshot = await new CreditScanner(runtime).scan();

  assert.equal(snapshot.claude, null);
});
