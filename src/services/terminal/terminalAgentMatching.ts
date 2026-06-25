import type { AgentClient, AgentKind } from '../agentStatus/types.ts';
import type { ForegroundInfo } from '../server/types.ts';
import type { TerminalTabStatus } from './foregroundStatus.ts';

export interface DirectTerminalAgentMatchInput {
  status: TerminalTabStatus;
  foreground: ForegroundInfo | null | undefined;
  clients: AgentClient[];
  lastKnownAgentKind: AgentKind | null;
  lastKnownAgentSessionId: string | null;
}

export interface DirectTerminalAgentMatchOptions {
  allowRememberedSession?: boolean;
  allowSingleLocalFallback?: boolean;
}

export function matchDirectTerminalAgentClients(
  input: DirectTerminalAgentMatchInput,
  options: DirectTerminalAgentMatchOptions = {},
): AgentClient[] {
  const allowRememberedSession = options.allowRememberedSession ?? true;
  const allowSingleLocalFallback = options.allowSingleLocalFallback ?? true;
  const rememberedMatches = (): AgentClient[] => {
    if (!allowRememberedSession) {
      return [];
    }

    const sessionId = normalizeAgentSessionId(input.lastKnownAgentSessionId);
    if (!sessionId) {
      return [];
    }

    return input.clients.filter((client) =>
      client.agentSessionId === sessionId
      && (!input.lastKnownAgentKind || client.kind === input.lastKnownAgentKind));
  };

  if (input.status !== 'claude' && input.status !== 'codex') {
    return rememberedMatches();
  }

  const kindClients = input.clients.filter((client) => client.kind === input.status);
  const pid = input.foreground?.pid ?? null;
  if (pid) {
    const pidMatches = kindClients.filter((client) =>
      client.pid === pid
      || client.parentPid === pid
      || client.processGroupId === pid);
    if (pidMatches.length > 0) {
      return pidMatches;
    }

    return rememberedMatches();
  }

  const sessionMatches = rememberedMatches();
  if (sessionMatches.length > 0) {
    return sessionMatches;
  }

  const localClients = kindClients.filter((client) => !client.surfaceId);
  return allowSingleLocalFallback && localClients.length === 1 ? localClients : [];
}

function normalizeAgentSessionId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
