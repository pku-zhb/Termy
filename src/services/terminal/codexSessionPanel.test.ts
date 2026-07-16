import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentClient } from '../agentStatus/types.ts';
import {
  collectCodexSessionDescriptors,
  moveCodexSessionSelection,
  reconcileCodexSessionSelection,
  resolveCodexSessionPanelState,
} from './codexSessionPanel.ts';

test('collectCodexSessionDescriptors keeps one prioritized client per Codex session', () => {
  const descriptors = collectCodexSessionDescriptors([
    client({ id: 'claude', kind: 'claude', agentSessionId: 'claude-session' }),
    client({ id: 'idle-a', agentSessionId: 'session-a', state: 'idle', lastSeenAtMs: 300 }),
    client({ id: 'running-a', agentSessionId: 'session-a', state: 'running', lastSeenAtMs: 200 }),
    client({ id: 'waiting-b', agentSessionId: 'session-b', state: 'waitingApproval', lastSeenAtMs: 100 }),
    client({ id: 'missing', agentSessionId: null }),
  ]);

  assert.deepEqual(descriptors.map((descriptor) => [descriptor.sessionId, descriptor.clientState]), [
    ['session-b', 'waitingApproval'],
    ['session-a', 'running'],
  ]);
});

test('reconcileCodexSessionSelection preserves selection then prefers the active session', () => {
  const sessionIds = ['session-a', 'session-b'];

  assert.equal(reconcileCodexSessionSelection(sessionIds, 'session-b', 'session-a'), 'session-b');
  assert.equal(reconcileCodexSessionSelection(sessionIds, 'missing', 'session-a'), 'session-a');
  assert.equal(reconcileCodexSessionSelection(sessionIds, null, null), 'session-a');
  assert.equal(reconcileCodexSessionSelection([], 'session-a', 'session-a'), null);
});

test('moveCodexSessionSelection follows bounded arrow-key navigation', () => {
  const sessionIds = ['session-a', 'session-b', 'session-c'];

  assert.equal(moveCodexSessionSelection(sessionIds, null, 1), 'session-a');
  assert.equal(moveCodexSessionSelection(sessionIds, null, -1), 'session-c');
  assert.equal(moveCodexSessionSelection(sessionIds, 'session-a', -1), 'session-a');
  assert.equal(moveCodexSessionSelection(sessionIds, 'session-b', 1), 'session-c');
  assert.equal(moveCodexSessionSelection(sessionIds, 'session-c', 1), 'session-c');
  assert.equal(moveCodexSessionSelection([], 'session-a', 1), null);
});

test('resolveCodexSessionPanelState combines scanner and transcript state', () => {
  assert.equal(resolveCodexSessionPanelState('waitingApproval', 'running'), 'needsInput');
  assert.equal(resolveCodexSessionPanelState('idle', 'running'), 'working');
  assert.equal(resolveCodexSessionPanelState('running', 'complete'), 'completed');
  assert.equal(resolveCodexSessionPanelState('idle', 'aborted'), 'aborted');
  assert.equal(resolveCodexSessionPanelState('stale', null), 'idle');
  assert.equal(resolveCodexSessionPanelState('unknown', null), 'unknown');
});

function client(overrides: Partial<AgentClient>): AgentClient {
  return {
    id: 'codex',
    kind: 'codex',
    pid: 100,
    parentPid: 99,
    processGroupId: 100,
    agentSessionId: 'session',
    workspaceId: null,
    surfaceId: null,
    tty: null,
    state: 'idle',
    cwd: '/Users/example/project',
    title: null,
    detail: null,
    lastSeenAtMs: null,
    waitingSinceMs: null,
    ...overrides,
  };
}
