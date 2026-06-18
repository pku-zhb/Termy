import type { AgentKind, AgentState } from './types.ts';
import type { AgentStatusRuntime } from './runtime.ts';

export interface HookAgentRecord {
  agent: AgentKind;
  state: AgentState;
  sessionId: string | null;
  pid: number | null;
  cwd: string | null;
  title: string | null;
  detail: string | null;
  eventName: string | null;
  updatedAtMs: number | null;
  waitingSinceMs: number | null;
}

export interface HookAgentStateStore {
  records: HookAgentRecord[];
}

export interface HookAgentStateMatch {
  record: HookAgentRecord;
  authoritativeState: AgentState | null;
}

interface RawHookState {
  sessions?: unknown;
}

export interface HookAgentStateQuery {
  kind: AgentKind;
  pid: number;
  sessionId?: string | null;
  cwd?: string | null;
  hasActiveChild: boolean;
}

const ACTIVE_HOOK_FRESHNESS_MS = 2 * 60 * 60 * 1000;
const IDLE_HOOK_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export async function loadHookAgentState(runtime: AgentStatusRuntime): Promise<HookAgentStateStore> {
  const path = `${runtime.homeDir}/.termy/agent-status/state.json`;
  const text = await runtime.readTextFile(path);
  if (!text) {
    return { records: [] };
  }

  try {
    const raw = JSON.parse(text) as RawHookState;
    return { records: normalizeHookRecords(raw.sessions) };
  } catch {
    return { records: [] };
  }
}

export function matchHookAgentState(
  store: HookAgentStateStore,
  query: HookAgentStateQuery,
  nowMs: number,
): HookAgentStateMatch | null {
  const candidates = store.records
    .filter((record) => record.agent === query.kind && record.updatedAtMs !== null)
    .filter((record) => isFreshHookRecord(record, nowMs));

  const sessionId = query.sessionId?.trim();
  if (sessionId) {
    const match = newestRecord(candidates.filter((record) => record.sessionId === sessionId));
    if (match) {
      return makeMatch(match, query);
    }
  }

  const pidMatch = newestRecord(candidates.filter((record) => record.pid === query.pid));
  if (pidMatch) {
    return makeMatch(pidMatch, query);
  }

  const cwd = query.cwd?.trim();
  if (cwd) {
    const cwdMatches = candidates.filter((record) => record.cwd === cwd);
    const match = newestUnambiguousRecord(cwdMatches);
    if (match) {
      return makeMatch(match, query);
    }
  }

  return null;
}

function makeMatch(record: HookAgentRecord, query: HookAgentStateQuery): HookAgentStateMatch {
  return {
    record,
    authoritativeState: authoritativeHookState(record, query.hasActiveChild),
  };
}

function authoritativeHookState(record: HookAgentRecord, hasActiveChild: boolean): AgentState | null {
  if (record.state === 'running' || record.state === 'waitingApproval') {
    return record.state;
  }
  if ((record.state === 'idle' || record.state === 'stale') && !hasActiveChild) {
    return record.state;
  }
  return null;
}

function isFreshHookRecord(record: HookAgentRecord, nowMs: number): boolean {
  if (record.updatedAtMs === null) {
    return false;
  }
  const ageMs = nowMs - record.updatedAtMs;
  if (ageMs < 0) {
    return true;
  }
  const freshnessMs = record.state === 'idle' || record.state === 'stale'
    ? IDLE_HOOK_FRESHNESS_MS
    : ACTIVE_HOOK_FRESHNESS_MS;
  return ageMs <= freshnessMs;
}

function normalizeHookRecords(rawSessions: unknown): HookAgentRecord[] {
  const values = Array.isArray(rawSessions)
    ? rawSessions
    : rawSessions && typeof rawSessions === 'object'
      ? Object.values(rawSessions as Record<string, unknown>)
      : [];

  return values
    .map((value) => normalizeHookRecord(value))
    .filter((record): record is HookAgentRecord => record !== null);
}

function normalizeHookRecord(value: unknown): HookAgentRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const agent = normalizeAgentKind(raw.agent);
  const state = normalizeAgentState(raw.state);
  if (!agent || !state) {
    return null;
  }

  return {
    agent,
    state,
    sessionId: stringValue(raw.sessionId ?? raw.session_id),
    pid: numberValue(raw.pid ?? raw.agentPid ?? raw.agent_pid),
    cwd: stringValue(raw.cwd),
    title: stringValue(raw.title),
    detail: stringValue(raw.detail),
    eventName: stringValue(raw.eventName ?? raw.event_name),
    updatedAtMs: numberValue(raw.updatedAtMs ?? raw.updated_at_ms ?? raw.updatedAt),
    waitingSinceMs: numberValue(raw.waitingSinceMs ?? raw.waiting_since_ms),
  };
}

function normalizeAgentKind(value: unknown): AgentKind | null {
  const text = stringValue(value)?.toLowerCase();
  return text === 'claude' || text === 'codex' ? text : null;
}

function normalizeAgentState(value: unknown): AgentState | null {
  const text = stringValue(value);
  if (text === 'running' || text === 'waitingApproval' || text === 'idle' || text === 'stale' || text === 'unknown') {
    return text;
  }
  return null;
}

function newestRecord(records: HookAgentRecord[]): HookAgentRecord | null {
  return records
    .filter((record) => record.updatedAtMs !== null)
    .sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0))[0] ?? null;
}

function newestUnambiguousRecord(records: HookAgentRecord[]): HookAgentRecord | null {
  const newest = newestRecord(records);
  if (!newest) {
    return null;
  }
  const newestTime = newest.updatedAtMs ?? 0;
  const nearMatches = records.filter((record) => Math.abs((record.updatedAtMs ?? 0) - newestTime) < 1000);
  return nearMatches.length === 1 ? newest : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
