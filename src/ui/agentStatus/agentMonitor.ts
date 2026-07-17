import type {
  AgentCreditStatus,
  AgentSnapshot,
  AgentStatusService,
} from '../../services/agentStatus/agentStatusService';
import { CODEX_ICON } from '../terminal/statusIcons';

export class AgentMonitor {
  private readonly rootEl: HTMLElement;
  private service: AgentStatusService | null;
  private unsubscribe: (() => void) | null = null;
  private latestSnapshot: AgentSnapshot | null = null;

  constructor(container: HTMLElement, service: AgentStatusService | null) {
    this.service = service;
    this.rootEl = container.createDiv('termy-agent-monitor');
    this.render(this.latestSnapshot);
    this.bindService();
  }

  setService(service: AgentStatusService | null): void {
    this.service = service;
    this.bindService();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.rootEl.remove();
  }

  private bindService(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;

    if (!this.service) {
      this.render(this.latestSnapshot);
      return;
    }

    this.unsubscribe = this.service.subscribe((snapshot) => {
      this.latestSnapshot = snapshot;
      this.render(snapshot);
    });
  }

  private render(snapshot: AgentSnapshot | null): void {
    const root = this.rootEl;
    const credit = snapshot?.credits.codex ?? null;
    root.empty();
    root.toggleClass('is-loading', snapshot === null || snapshot.generatedAtMs === 0);

    const pill = root.createDiv('termy-agent-credit is-codex');
    pill.toggleClass('is-empty-credit', !credit);
    pill.title = credit ? creditTooltip(credit) : 'Codex usage: n/a';

    const icon = pill.createEl('img', { cls: 'termy-agent-credit-icon' });
    icon.alt = 'Codex';
    icon.src = CODEX_ICON;

    const meters = pill.createDiv('termy-agent-credit-meters');
    appendMeter(meters, credit ? usedPercent(credit.weeklyRemainingPercent) : null, 'weekly usage', 'is-usage');
    appendMeter(
      meters,
      credit ? resetElapsedPercent(credit.weeklyResetAtMs, 7 * 24 * 60 * 60 * 1000) : null,
      'weekly reset',
      'is-reset',
    );
  }
}

function appendMeter(parent: HTMLElement, percent: number | null, title: string, className: string): void {
  const meter = parent.createSpan(`termy-agent-credit-meter ${className}`);
  meter.style.setProperty('--termy-agent-meter-fill', `${percent ?? 0}%`);
  meter.toggleClass('is-empty', percent === null);
  meter.title = percent === null ? `${title}: n/a` : `${title}: ${percent}%`;
}

function creditTooltip(credit: AgentCreditStatus): string {
  if (credit.unlimited) {
    return `Codex: unlimited · ${credit.source}`;
  }
  return [
    `Codex · ${credit.source}`,
    `weekly usage ${displayUsedPercent(credit.weeklyRemainingPercent)}, reset ${displayResetTime(credit.weeklyResetAtMs)}`,
  ].join('\n');
}

function displayUsedPercent(remainingPercent: number | null): string {
  const percent = usedPercent(remainingPercent);
  return percent === null ? 'n/a' : `${percent}%`;
}

function usedPercent(remainingPercent: number | null): number | null {
  return remainingPercent === null ? null : clampPercent(100 - remainingPercent);
}

function resetElapsedPercent(resetAtMs: number | null, windowMs: number): number | null {
  if (!resetAtMs) {
    return null;
  }
  const remainingMs = resetAtMs - Date.now();
  if (remainingMs <= 0) {
    return 100;
  }
  return clampPercent(((windowMs - remainingMs) / windowMs) * 100);
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function displayResetTime(resetAtMs: number | null): string {
  if (!resetAtMs) {
    return 'n/a';
  }

  const date = new Date(resetAtMs);
  if (Number.isNaN(date.getTime())) {
    return 'n/a';
  }

  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return sameDay ? `${hours}:${minutes}` : `${date.getMonth() + 1}/${date.getDate()} ${hours}:${minutes}`;
}
