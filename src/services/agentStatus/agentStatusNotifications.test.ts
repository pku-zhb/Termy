import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAgentStatusNotification,
  resolveAgentDisplayState,
  resolveAgentStatusTransition,
} from './agentStatusNotifications.ts';
import {
  EMPTY_AGENT_CREDIT_SNAPSHOT,
  type AgentClient,
  type AgentSnapshot,
  type AgentSummary,
} from './types.ts';

test('resolveAgentDisplayState keeps red above green and white as the fallback', () => {
  assert.equal(resolveAgentDisplayState(snapshot({ running: 1 })), 'green');
  assert.equal(resolveAgentDisplayState(snapshot({ waitingApproval: 1 })), 'red');
  assert.equal(resolveAgentDisplayState(snapshot({ running: 1, waitingApproval: 1 })), 'red');
  assert.equal(resolveAgentDisplayState(snapshot({ idle: 1 })), 'white');
  assert.equal(resolveAgentDisplayState(snapshot({ stale: 1, unknown: 1 })), 'white');
});

test('resolveAgentStatusTransition only emits green exits', () => {
  assert.equal(resolveAgentStatusTransition(null, 'green'), null);
  assert.equal(resolveAgentStatusTransition('white', 'green'), null);
  assert.equal(resolveAgentStatusTransition('red', 'white'), null);
  assert.equal(resolveAgentStatusTransition('green', 'green'), null);
  assert.equal(resolveAgentStatusTransition('green', 'white'), 'green-to-white');
  assert.equal(resolveAgentStatusTransition('green', 'red'), 'green-to-red');
});

test('createAgentStatusNotification names waiting clients for green-to-red', () => {
  const notification = createAgentStatusNotification('green-to-red', snapshot({
    waitingApproval: 1,
  }, [{
    id: 'codex-501',
    kind: 'codex',
    pid: 501,
    parentPid: 1,
    processGroupId: 501,
    workspaceId: null,
    surfaceId: null,
    tty: 'ttys001',
    state: 'waitingApproval',
    cwd: '/Users/example/lab/termy',
    title: null,
    detail: 'hook: PermissionRequest',
    lastSeenAtMs: 1_700_000_000_000,
    waitingSinceMs: 1_700_000_000_000,
  }]));

  assert.equal(notification.title, 'Termy Agent 需要处理');
  assert.equal(notification.transition, 'green-to-red');
  assert.match(notification.body, /Codex pid 501/);
  assert.match(notification.body, /\/Users\/example\/lab\/termy/);
});

test('createAgentStatusNotification summarizes green-to-white', () => {
  const notification = createAgentStatusNotification('green-to-white', snapshot({ idle: 1 }));

  assert.equal(notification.title, 'Termy Agent 已完成');
  assert.equal(notification.transition, 'green-to-white');
  assert.match(notification.body, /空闲/);
});

function snapshot(
  summaryOverrides: Partial<AgentSummary>,
  clients: AgentClient[] = [],
): AgentSnapshot {
  const summary: AgentSummary = {
    total: clients.length,
    claude: clients.filter((client) => client.kind === 'claude').length,
    codex: clients.filter((client) => client.kind === 'codex').length,
    running: 0,
    waitingApproval: 0,
    idle: 0,
    stale: 0,
    unknown: 0,
    ...summaryOverrides,
  };

  return {
    generatedAtMs: 1_700_000_000_000,
    agentPids: clients.map((client) => client.pid),
    clients,
    tmuxClients: [],
    summary,
    credits: EMPTY_AGENT_CREDIT_SNAPSHOT,
  };
}
