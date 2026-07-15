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
    agentSessionId: overrides.agentSessionId ?? null,
    workspaceId: null,
    surfaceId: overrides.surfaceId ?? null,
    tty: overrides.tty ?? null,
    state: overrides.state ?? 'running',
    cwd: null,
    title: null,
    detail: null,
    lastSeenAtMs: null,
    waitingSinceMs: null,
  };
}

test('matchDirectTerminalAgentClients prefers foreground pid over stale remembered session', () => {
  const stale = client({ pid: 10, parentPid: 9, processGroupId: 9, agentSessionId: 'old-session' });
  const current = client({ pid: 20, parentPid: 19, processGroupId: 19, agentSessionId: 'current-session' });

  assert.deepEqual(
    matchDirectTerminalAgentClients({
      status: 'codex',
      foreground: { name: 'codex', cmdline: 'codex', pid: 20 },
      clients: [stale, current],
      lastKnownAgentKind: 'codex',
      lastKnownAgentSessionId: 'old-session',
    }),
    [current],
  );
});

test('matchDirectTerminalAgentClients matches wrapped Codex by parent pid', () => {
  const current = client({ pid: 20, parentPid: 19, processGroupId: 19, agentSessionId: 'current-session' });

  assert.deepEqual(
    matchDirectTerminalAgentClients({
      status: 'codex',
      foreground: { name: 'node', cmdline: 'node /bin/codex', pid: 19 },
      clients: [current],
      lastKnownAgentKind: null,
      lastKnownAgentSessionId: null,
    }),
    [current],
  );
});

test('matchDirectTerminalAgentClients infers Claude below an unknown foreground wrapper', () => {
  const current = client({
    kind: 'claude',
    pid: 16767,
    parentPid: 16722,
    processGroupId: 16722,
    agentSessionId: 'current-session',
  });
  const foreground = {
    name: 'python3',
    cmdline: 'python3 /Users/example/.local/bin/claude3',
    pid: 16722,
  };

  assert.deepEqual(
    matchDirectTerminalAgentClients({
      status: 'none',
      foreground,
      clients: [current],
      lastKnownAgentKind: null,
      lastKnownAgentSessionId: null,
    }),
    [current],
  );
  assert.deepEqual(
    matchUniqueDirectAgentClientsByForegroundPid([current], foreground.pid),
    [current],
  );
});

test('wrapped-agent inference rejects mixed kinds and tmux-owned clients', () => {
  const claude = client({
    kind: 'claude',
    pid: 20,
    parentPid: 19,
    processGroupId: 19,
    agentSessionId: 'claude-session',
  });
  const codex = client({
    kind: 'codex',
    pid: 21,
    parentPid: 19,
    processGroupId: 19,
    agentSessionId: 'codex-session',
  });
  const tmuxClaude = client({
    kind: 'claude',
    pid: 30,
    parentPid: 29,
    processGroupId: 29,
    surfaceId: 'tmux:work',
  });

  assert.deepEqual(matchUniqueDirectAgentClientsByForegroundPid([claude, codex], 19), []);
  assert.deepEqual(matchUniqueDirectAgentClientsByForegroundPid([tmuxClaude], 29), []);
});

test('matchDirectTerminalAgentClients does not use singleton fallback when a foreground pid disagrees', () => {
  const other = client({ pid: 20, parentPid: 19, processGroupId: 19, agentSessionId: 'other-session' });

  assert.deepEqual(
    matchDirectTerminalAgentClients({
      status: 'codex',
      foreground: { name: 'codex', cmdline: 'codex', pid: 99 },
      clients: [other],
      lastKnownAgentKind: null,
      lastKnownAgentSessionId: null,
    }),
    [],
  );
});

test('matchDirectTerminalAgentClients can disable weak fallbacks for restore persistence', () => {
  const onlyClient = client({ pid: 20, agentSessionId: 'only-session' });

  assert.deepEqual(
    matchDirectTerminalAgentClients({
      status: 'codex',
      foreground: null,
      clients: [onlyClient],
      lastKnownAgentKind: 'codex',
      lastKnownAgentSessionId: 'old-session',
    }, {
      allowRememberedSession: false,
      allowSingleLocalFallback: false,
    }),
    [],
  );
});

test('matchDirectTerminalAgentClients keeps singleton fallback available for UI hints', () => {
  const onlyClient = client({ pid: 20, agentSessionId: 'only-session' });

  assert.deepEqual(
    matchDirectTerminalAgentClients({
      status: 'codex',
      foreground: null,
      clients: [onlyClient],
      lastKnownAgentKind: null,
      lastKnownAgentSessionId: null,
    }),
    [onlyClient],
  );
});
