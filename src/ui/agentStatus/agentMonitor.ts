import type {
  AgentCreditStatus,
  AgentCreditWindow,
  AgentSnapshot,
  AgentStatusService,
} from '../../services/agentStatus/agentStatusService';
import { CLAUDE_ICON, CODEX_ICON } from '../terminal/statusIcons';

interface CreditPillSpec {
  name: string;
  className: string;
  iconSrc: string;
  credit: AgentCreditStatus | null;
}

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
    root.empty();
    root.toggleClass('is-loading', snapshot === null || snapshot.generatedAtMs === 0);

    const specs: CreditPillSpec[] = [
      {
        name: 'Claude',
        className: 'is-claude',
        iconSrc: CLAUDE_ICON,
        credit: snapshot?.credits.claude ?? null,
      },
      {
        name: 'Codex',
        className: 'is-codex',
        iconSrc: CODEX_ICON,
        credit: snapshot?.credits.codex ?? null,
      },
    ];

    for (const spec of specs) {
      appendCreditPill(root, spec);
    }
  }
}

function appendCreditPill(parent: HTMLElement, spec: CreditPillSpec): void {
  const pill = parent.createDiv(`termy-agent-credit ${spec.className}`);
  pill.toggleClass('is-empty-credit', !spec.credit);
  pill.title = spec.credit ? creditTooltip(spec.name, spec.credit) : `${spec.name} usage: n/a`;

  const icon = pill.createEl('img', { cls: 'termy-agent-credit-icon' });
  icon.alt = spec.name;
  icon.src = spec.iconSrc;

  const meters = pill.createDiv('termy-agent-credit-meters');
  for (const window of creditWindows(spec.credit)) {
    appendWindowMeters(meters, spec.name, window);
  }
}

function creditWindows(credit: AgentCreditStatus | null): AgentCreditWindow[] {
  if (!credit || credit.windows.length === 0) {
    return [{
      id: 'weekly',
      label: 'W',
      usedPercent: null,
      resetAtMs: null,
      windowMs: 7 * 24 * 60 * 60 * 1000,
    }];
  }
  return credit.windows;
}

function appendWindowMeters(parent: HTMLElement, productName: string, window: AgentCreditWindow): void {
  const group = parent.createSpan(`termy-agent-credit-window is-${window.id}`);
  group.title = `${productName} ${window.label}: usage ${displayPercent(window.usedPercent)}, reset ${displayResetTime(window.resetAtMs)}`;
  appendMeter(group, window.usedPercent, `${productName} ${window.label} usage`, 'is-usage');
  appendMeter(
    group,
    resetElapsedPercent(window.resetAtMs, window.windowMs),
    `${productName} ${window.label} reset`,
    'is-reset',
  );
}

function appendMeter(parent: HTMLElement, percent: number | null, title: string, className: string): void {
  const meter = parent.createSpan(`termy-agent-credit-meter ${className}`);
  meter.style.setProperty('--termy-agent-meter-fill', `${percent ?? 0}%`);
  meter.toggleClass('is-empty', percent === null);
  meter.title = percent === null ? `${title}: n/a` : `${title}: ${percent}%`;
}

function creditTooltip(productName: string, credit: AgentCreditStatus): string {
  if (credit.unlimited) {
    return `${productName}: unlimited · ${credit.source}`;
  }

  const windows = credit.windows.length > 0
    ? credit.windows
    : [{
        id: 'weekly',
        label: 'W',
        usedPercent: usedPercent(credit.weeklyRemainingPercent),
        resetAtMs: credit.weeklyResetAtMs,
        windowMs: 7 * 24 * 60 * 60 * 1000,
      }];

  return [
    `${productName} · ${credit.source}`,
    ...windows.map((window) => (
      `${window.label} usage ${displayPercent(window.usedPercent)}, reset ${displayResetTime(window.resetAtMs)}`
    )),
  ].join('\n');
}

function displayPercent(percent: number | null): string {
  return percent === null ? 'n/a' : `${percent}%`;
}

function usedPercent(remainingPercent: number | null): number | null {
  return remainingPercent === null ? null : clampPercent(100 - remainingPercent);
}

function resetElapsedPercent(resetAtMs: number | null, windowMs: number | null): number | null {
  if (!resetAtMs || !windowMs) {
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
