export type AgentKind = 'claude' | 'codex';

export interface AgentClient {
  id: string;
  kind: AgentKind;
  pid: number;
  parentPid: number;
  processGroupId: number;
  surfaceId: string | null;
  tty: string | null;
}

export interface AgentTmuxClient {
  pid: number;
  tty: string | null;
  sessionName: string;
  surfaceId: string;
}

export interface AgentSnapshot {
  generatedAtMs: number;
  clients: AgentClient[];
  tmuxClients: AgentTmuxClient[];
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
}

export const EMPTY_AGENT_CREDIT_SNAPSHOT: AgentCreditSnapshot = {
  generatedAtMs: 0,
  codex: null,
};

export const EMPTY_AGENT_SNAPSHOT: AgentSnapshot = {
  generatedAtMs: 0,
  clients: [],
  tmuxClients: [],
  credits: EMPTY_AGENT_CREDIT_SNAPSHOT,
};
