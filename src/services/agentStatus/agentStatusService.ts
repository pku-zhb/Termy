import { debugLog, errorLog } from '@/utils/logger';
import { AgentScanner } from './agentScanner.ts';
import { CreditScanner } from './creditScanner.ts';
import { createElectronAgentStatusRuntime, type AgentStatusRuntime } from './runtime.ts';
import {
  EMPTY_AGENT_CREDIT_SNAPSHOT,
  EMPTY_AGENT_SNAPSHOT,
  type AgentCreditSnapshot,
  type AgentCreditStatus,
  type AgentSnapshot,
} from './types.ts';

export type AgentStatusListener = (snapshot: AgentSnapshot) => void;

export interface AgentStatusServiceOptions {
  scanIntervalMs?: number;
  creditRefreshIntervalMs?: number;
  creditRetryIntervalMs?: number;
  runtime?: AgentStatusRuntime;
}

export class AgentStatusService {
  private readonly scanner: AgentScanner;
  private readonly creditScanner: CreditScanner;
  private readonly scanIntervalMs: number;
  private readonly creditRefreshIntervalMs: number;
  private readonly creditRetryIntervalMs: number;
  private readonly listeners = new Set<AgentStatusListener>();
  private snapshot: AgentSnapshot = EMPTY_AGENT_SNAPSHOT;
  private credits: AgentCreditSnapshot = EMPTY_AGENT_CREDIT_SNAPSHOT;
  private timer: number | null = null;
  private scanInFlight = false;
  private creditRefreshInFlight = false;
  private nextCreditRefreshAt = 0;

  constructor(options: AgentStatusServiceOptions = {}) {
    const runtime = options.runtime ?? createElectronAgentStatusRuntime();
    this.scanner = new AgentScanner(runtime);
    this.creditScanner = new CreditScanner(runtime);
    this.scanIntervalMs = options.scanIntervalMs ?? 5000;
    this.creditRefreshIntervalMs = options.creditRefreshIntervalMs ?? 5 * 60 * 1000;
    this.creditRetryIntervalMs = options.creditRetryIntervalMs ?? 60 * 1000;
  }

  getSnapshot(): AgentSnapshot {
    return this.snapshot;
  }

  subscribe(listener: AgentStatusListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    this.start();

    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.stop();
      }
    };
  }

  start(): void {
    if (this.timer !== null) {
      return;
    }

    void this.refresh();
    this.timer = window.setInterval(() => {
      void this.refresh();
    }, this.scanIntervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  async refresh(forceCredits = false): Promise<void> {
    if (this.scanInFlight) {
      return;
    }

    this.scanInFlight = true;
    try {
      const snapshot = await this.scanner.scan();
      const nextSnapshot = { ...snapshot, credits: this.credits };
      this.snapshot = nextSnapshot;
      this.emit(nextSnapshot);
      debugLog('[AgentStatus] snapshot refreshed', {
        tmuxClients: snapshot.tmuxClients,
        clients: snapshot.clients.map((client) => ({
          id: client.id,
          kind: client.kind,
          pid: client.pid,
          parentPid: client.parentPid,
          processGroupId: client.processGroupId,
          tty: client.tty,
          surfaceId: client.surfaceId,
        })),
      });
      void this.refreshCreditsIfNeeded(forceCredits);
    } catch (error) {
      errorLog('[AgentStatus] refresh failed:', error);
    } finally {
      this.scanInFlight = false;
    }
  }

  private emit(snapshot: AgentSnapshot): void {
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        errorLog('[AgentStatus] listener failed:', error);
      }
    }
  }

  private async refreshCreditsIfNeeded(force: boolean): Promise<void> {
    if (this.creditRefreshInFlight) {
      return;
    }
    if (!force && Date.now() < this.nextCreditRefreshAt) {
      return;
    }

    this.creditRefreshInFlight = true;
    try {
      const credits = await this.creditScanner.scan();
      this.credits = replaceMissingCreditValues(credits, this.credits);
      this.nextCreditRefreshAt = Date.now() + nextCreditRefreshInterval(
        this.credits,
        this.creditRefreshIntervalMs,
        this.creditRetryIntervalMs,
      );
      this.snapshot = { ...this.snapshot, credits: this.credits };
      this.emit(this.snapshot);
      debugLog('[AgentStatus] credits refreshed', this.credits);
    } catch (error) {
      this.nextCreditRefreshAt = Date.now() + this.creditRetryIntervalMs;
      errorLog('[AgentStatus] credit refresh failed:', error);
    } finally {
      this.creditRefreshInFlight = false;
    }
  }
}

function replaceMissingCreditValues(
  credits: AgentCreditSnapshot,
  previous: AgentCreditSnapshot,
): AgentCreditSnapshot {
  return {
    generatedAtMs: credits.generatedAtMs,
    claude: hasDisplayableUsage(credits.claude) ? credits.claude : previous.claude,
    codex: hasDisplayableUsage(credits.codex) ? credits.codex : previous.codex,
  };
}

function nextCreditRefreshInterval(
  credits: AgentCreditSnapshot,
  refreshIntervalMs: number,
  retryIntervalMs: number,
): number {
  return hasDisplayableUsage(credits.claude) || hasDisplayableUsage(credits.codex)
    ? refreshIntervalMs
    : retryIntervalMs;
}

function hasDisplayableUsage(status: AgentCreditStatus | null): status is AgentCreditStatus {
  return Boolean(status && (
    status.unlimited
    || status.windows.some((window) => window.usedPercent !== null || window.resetAtMs !== null)
    || status.fiveHourRemainingPercent !== null
    || status.weeklyRemainingPercent !== null
    || status.fiveHourResetAtMs !== null
    || status.weeklyResetAtMs !== null
  ));
}

export type {
  AgentClient,
  AgentCreditSnapshot,
  AgentCreditStatus,
  AgentCreditWindow,
  AgentKind,
  AgentSnapshot,
  AgentTmuxClient,
} from './types.ts';
