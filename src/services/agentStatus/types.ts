export type AgentKind = 'claude' | 'codex';

export type AgentState = 'running' | 'waitingApproval' | 'idle' | 'stale' | 'unknown';

export interface AgentClient {
  id: string;
  kind: AgentKind;
  pid: number;
  parentPid: number;
  processGroupId: number;
  workspaceId: string | null;
  surfaceId: string | null;
  tty: string | null;
  state: AgentState;
  cwd: string | null;
  title: string | null;
  detail: string | null;
  lastSeenAtMs: number | null;
  waitingSinceMs: number | null;
}

export interface AgentTmuxClient {
  pid: number;
  tty: string | null;
  sessionName: string;
  surfaceId: string;
}

export interface AgentSummary {
  total: number;
  claude: number;
  codex: number;
  running: number;
  waitingApproval: number;
  idle: number;
  stale: number;
  unknown: number;
}

export interface AgentSnapshot {
  generatedAtMs: number;
  agentPids: number[];
  clients: AgentClient[];
  tmuxClients: AgentTmuxClient[];
  summary: AgentSummary;
  credits: AgentCreditSnapshot;
}

export interface AgentCreditStatus {
  fiveHourRemainingPercent: number | null;
  weeklyRemainingPercent: number | null;
  fiveHourResetAtMs: number | null;
  weeklyResetAtMs: number | null;
  unlimited: boolean;
  source: string;
}

export interface AgentCreditSnapshot {
  generatedAtMs: number;
  codex: AgentCreditStatus | null;
  claude: AgentCreditStatus | null;
}

export const EMPTY_AGENT_SUMMARY: AgentSummary = {
  total: 0,
  claude: 0,
  codex: 0,
  running: 0,
  waitingApproval: 0,
  idle: 0,
  stale: 0,
  unknown: 0,
};

export const EMPTY_AGENT_CREDIT_SNAPSHOT: AgentCreditSnapshot = {
  generatedAtMs: 0,
  codex: null,
  claude: null,
};

export const EMPTY_AGENT_SNAPSHOT: AgentSnapshot = {
  generatedAtMs: 0,
  agentPids: [],
  clients: [],
  tmuxClients: [],
  summary: EMPTY_AGENT_SUMMARY,
  credits: EMPTY_AGENT_CREDIT_SNAPSHOT,
};
