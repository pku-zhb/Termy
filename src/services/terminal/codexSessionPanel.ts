import type { AgentClient, AgentState } from '../agentStatus/types.ts';
import type { CodexSessionActivityState } from './codexSessionActivity.ts';

export type CodexSessionPanelState =
  | 'needsInput'
  | 'working'
  | 'completed'
  | 'aborted'
  | 'idle'
  | 'unknown';

export interface CodexSessionDescriptor {
  sessionId: string;
  clientState: AgentState;
  cwd: string | null;
  title: string | null;
  pid: number;
  lastSeenAtMs: number | null;
}

const AGENT_STATE_PRIORITY: Readonly<Record<AgentState, number>> = {
  waitingApproval: 0,
  running: 1,
  idle: 2,
  unknown: 3,
  stale: 4,
};

export function collectCodexSessionDescriptors(
  clients: readonly AgentClient[],
): CodexSessionDescriptor[] {
  const bySessionId = new Map<string, AgentClient>();
  for (const client of clients) {
    const sessionId = normalizeSessionId(client.agentSessionId);
    if (client.kind !== 'codex' || !sessionId) {
      continue;
    }

    const current = bySessionId.get(sessionId);
    if (!current || compareClients(client, current) < 0) {
      bySessionId.set(sessionId, client);
    }
  }

  return [...bySessionId.entries()]
    .map(([sessionId, client]) => ({
      sessionId,
      clientState: client.state,
      cwd: normalizeNullableText(client.cwd),
      title: normalizeNullableText(client.title),
      pid: client.pid,
      lastSeenAtMs: client.lastSeenAtMs,
    }))
    .sort(compareDescriptors);
}

export function reconcileCodexSessionSelection(
  sessionIds: readonly string[],
  selectedSessionId: string | null,
  preferredSessionId: string | null,
): string | null {
  if (selectedSessionId && sessionIds.includes(selectedSessionId)) {
    return selectedSessionId;
  }
  if (preferredSessionId && sessionIds.includes(preferredSessionId)) {
    return preferredSessionId;
  }
  return sessionIds[0] ?? null;
}

export function moveCodexSessionSelection(
  sessionIds: readonly string[],
  selectedSessionId: string | null,
  direction: -1 | 1,
): string | null {
  if (sessionIds.length === 0) {
    return null;
  }
  const currentIndex = selectedSessionId ? sessionIds.indexOf(selectedSessionId) : -1;
  if (currentIndex < 0) {
    return direction > 0 ? sessionIds[0] : sessionIds[sessionIds.length - 1];
  }
  return sessionIds[Math.max(0, Math.min(sessionIds.length - 1, currentIndex + direction))];
}

export function resolveCodexSessionPanelState(
  clientState: AgentState,
  activityState: CodexSessionActivityState | null,
): CodexSessionPanelState {
  // The canonical transcript wins over scanner state because hook/process
  // snapshots can briefly remain running after a turn has completed.
  if (activityState === 'complete') {
    return 'completed';
  }
  if (activityState === 'aborted') {
    return 'aborted';
  }
  if (clientState === 'waitingApproval') {
    return 'needsInput';
  }
  if (activityState === 'running' || clientState === 'running') {
    return 'working';
  }
  if (clientState === 'idle' || clientState === 'stale') {
    return 'idle';
  }
  return 'unknown';
}

function compareClients(left: AgentClient, right: AgentClient): number {
  const stateDifference = AGENT_STATE_PRIORITY[left.state] - AGENT_STATE_PRIORITY[right.state];
  if (stateDifference !== 0) {
    return stateDifference;
  }
  const lastSeenDifference = (right.lastSeenAtMs ?? 0) - (left.lastSeenAtMs ?? 0);
  if (lastSeenDifference !== 0) {
    return lastSeenDifference;
  }
  return left.pid - right.pid;
}

function compareDescriptors(left: CodexSessionDescriptor, right: CodexSessionDescriptor): number {
  const stateDifference = AGENT_STATE_PRIORITY[left.clientState] - AGENT_STATE_PRIORITY[right.clientState];
  if (stateDifference !== 0) {
    return stateDifference;
  }
  const lastSeenDifference = (right.lastSeenAtMs ?? 0) - (left.lastSeenAtMs ?? 0);
  if (lastSeenDifference !== 0) {
    return lastSeenDifference;
  }
  return left.sessionId.localeCompare(right.sessionId);
}

function normalizeSessionId(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function normalizeNullableText(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized || null;
}
