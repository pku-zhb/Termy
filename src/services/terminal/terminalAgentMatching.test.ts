import * as assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentClient } from '../agentStatus/types.ts';
import {
  matchDirectTerminalAgentClients,
  matchUniqueDirectAgentClientsByForegroundPid,
} from './terminalAgentMatching.ts';

function client(overrides: Partial<AgentClient>): AgentClient {
  return {
    id: `codex-${overrides.pid ?? 1}`,
    kind: overrides.kind ?? 'codex',
    pid: overrides.pid ?? 1,
    parentPid: overrides.parentPid ?? 0,
    processGroupId: overrides.processGroupId ?? overrides.pid ?? 1,
    surfaceId: overrides.surfaceId ?? null,
    tty: overrides.tty ?? null,
  };
}

test('matchDirectTerminalAgentClients matches direct and wrapped processes by pid', () => {
  const direct = client({ pid: 20, parentPid: 19, processGroupId: 19 });

  assert.deepEqual(matchDirectTerminalAgentClients({
    status: 'codex',
    foreground: { name: 'codex', cmdline: 'codex', pid: 20 },
    clients: [direct],
  }), [direct]);
  assert.deepEqual(matchDirectTerminalAgentClients({
    status: 'codex',
    foreground: { name: 'node', cmdline: 'node /bin/codex', pid: 19 },
    clients: [direct],
  }), [direct]);
});

test('matchDirectTerminalAgentClients maps Claude wrappers to Claude processes', () => {
  const current = client({ kind: 'claude', pid: 16767, parentPid: 16722, processGroupId: 16722 });

  for (const status of ['claudex', 'claude3'] as const) {
    assert.deepEqual(matchDirectTerminalAgentClients({
      status,
      foreground: { name: 'python3', cmdline: `python3 /Users/example/.local/bin/${status}`, pid: 16722 },
      clients: [current],
    }), [current]);
  }
});

test('matchDirectTerminalAgentClients infers an agent below an unknown foreground wrapper', () => {
  const current = client({ kind: 'claude', pid: 16767, parentPid: 16722, processGroupId: 16722 });

  assert.deepEqual(matchDirectTerminalAgentClients({
    status: 'none',
    foreground: { name: 'python3', cmdline: 'python3 /Users/example/.local/bin/claude3', pid: 16722 },
    clients: [current],
  }), [current]);
  assert.deepEqual(matchUniqueDirectAgentClientsByForegroundPid([current], 16722), [current]);
});

test('wrapped-agent inference rejects mixed kinds and tmux-owned clients', () => {
  const claude = client({ kind: 'claude', pid: 20, parentPid: 19, processGroupId: 19 });
  const codex = client({ kind: 'codex', pid: 21, parentPid: 19, processGroupId: 19 });
  const tmuxClaude = client({ kind: 'claude', pid: 30, parentPid: 29, processGroupId: 29, surfaceId: 'tmux:work' });

  assert.deepEqual(matchUniqueDirectAgentClientsByForegroundPid([claude, codex], 19), []);
  assert.deepEqual(matchUniqueDirectAgentClientsByForegroundPid([tmuxClaude], 29), []);
});

test('matchDirectTerminalAgentClients only uses singleton fallback without a foreground pid', () => {
  const other = client({ pid: 20 });

  assert.deepEqual(matchDirectTerminalAgentClients({
    status: 'codex',
    foreground: { name: 'codex', cmdline: 'codex', pid: 99 },
    clients: [other],
  }), []);
  assert.deepEqual(matchDirectTerminalAgentClients({
    status: 'codex',
    foreground: null,
    clients: [other],
  }), [other]);
});
