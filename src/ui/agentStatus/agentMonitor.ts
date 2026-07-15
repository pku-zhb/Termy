import { setIcon } from 'obsidian';
import type {
  AgentCreditStatus,
  AgentKind,
  AgentSnapshot,
  AgentState,
  AgentStatusService,
} from '../../services/agentStatus/agentStatusService';
import { t } from '../../i18n';
import { CLAUDE_ICON, CODEX_ICON } from '../terminal/statusIcons';

interface AgentMonitorOptions {
  codexActivityEnabled: boolean;
  onCodexActivityToggle: (enabled: boolean) => void;
}

export class AgentMonitor {
  private readonly rootEl: HTMLElement;
  private service: AgentStatusService | null;
  private unsubscribe: (() => void) | null = null;
  private latestSnapshot: AgentSnapshot | null = null;
  private codexActivityEnabled: boolean;
  private readonly onCodexActivityToggle: (enabled: boolean) => void;

  constructor(
    container: HTMLElement,
    service: AgentStatusService | null,
    options: AgentMonitorOptions,
  ) {
    this.service = service;
    this.codexActivityEnabled = options.codexActivityEnabled;
    this.onCodexActivityToggle = options.onCodexActivityToggle;
    this.rootEl = container.createDiv('termy-agent-monitor');

    this.render(this.latestSnapshot);
    this.bindService();
  }

  setService(service: AgentStatusService | null): void {
    this.service = service;
    this.bindService();
  }

  setCodexActivityEnabled(enabled: boolean): void {
    if (enabled === this.codexActivityEnabled) {
      return;
    }
    this.codexActivityEnabled = enabled;
    this.render(this.latestSnapshot);
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

    const activityDot = root.createSpan('termy-agent-monitor-activity');
    activityDot.addClass(snapshot?.summary.waitingApproval ? 'is-waiting-approval' : snapshot?.summary.running ? 'is-running' : 'is-idle');
    activityDot.title = 'Agent monitor';

    const summaryEl = root.createDiv('termy-agent-monitor-summary');
    this.appendKindPill(summaryEl, 'claude', snapshot?.summary.claude ?? 0, snapshot?.credits.claude ?? null);
    this.appendKindPill(summaryEl, 'codex', snapshot?.summary.codex ?? 0, snapshot?.credits.codex ?? null);
    this.appendStatePill(summaryEl, 'waitingApproval', snapshot?.summary.waitingApproval ?? 0);
    this.appendStatePill(summaryEl, 'running', snapshot?.summary.running ?? 0);
    this.appendStatePill(summaryEl, 'idle', (snapshot?.summary.idle ?? 0) + (snapshot?.summary.stale ?? 0));
    if ((snapshot?.summary.unknown ?? 0) > 0) {
      this.appendStatePill(summaryEl, 'unknown', snapshot?.summary.unknown ?? 0);
    }

    const toggleLabel = this.codexActivityEnabled
      ? t('terminal.sessionActivity.hidePanel')
      : t('terminal.sessionActivity.showPanel');
    const activityToggle = root.createEl('button', {
      cls: 'termy-agent-monitor-codex-activity-toggle clickable-icon',
    });
    activityToggle.type = 'button';
    activityToggle.toggleClass('is-active', this.codexActivityEnabled);
    activityToggle.setAttr('aria-label', toggleLabel);
    activityToggle.setAttr('aria-pressed', String(this.codexActivityEnabled));
    activityToggle.title = toggleLabel;
    setIcon(activityToggle, 'message-square');
    activityToggle.addEventListener('click', (event) => {
      event.stopPropagation();
      this.onCodexActivityToggle(!this.codexActivityEnabled);
    });
  }

  private appendKindPill(parent: HTMLElement, kind: AgentKind, count: number, credit: AgentCreditStatus | null): void {
    const pill = parent.createDiv(`termy-agent-pill is-kind is-${kind}`);
    pill.toggleClass('is-empty-credit', !credit);
    pill.title = credit
      ? `${kind === 'claude' ? 'Claude' : 'Codex'} ${count}\n${creditTooltip(kind, credit)}`
      : `${kind === 'claude' ? 'Claude' : 'Codex'} ${count}`;
    const icon = pill.createEl('img', { cls: 'termy-agent-pill-icon' });
    icon.alt = '';
    icon.src = kind === 'claude' ? CLAUDE_ICON : CODEX_ICON;
    pill.createSpan('termy-agent-pill-count').setText(String(count));

    const meters = pill.createDiv('termy-agent-credit-meters');
    if (kind === 'claude') {
      appendMeter(meters, credit ? usedPercent(credit.fiveHourRemainingPercent) : null, '5h usage', ['is-usage']);
      appendMeter(meters, credit ? resetElapsedPercent(credit.fiveHourResetAtMs, 5 * 60 * 60 * 1000) : null, '5h reset', ['is-reset']);
    }
    const weeklyUsageClasses = kind === 'claude' ? ['is-usage', 'is-weekly-start'] : ['is-usage'];
    appendMeter(meters, credit ? usedPercent(credit.weeklyRemainingPercent) : null, 'weekly usage', weeklyUsageClasses);
    appendMeter(meters, credit ? resetElapsedPercent(credit.weeklyResetAtMs, 7 * 24 * 60 * 60 * 1000) : null, 'weekly reset', ['is-reset']);
  }

  private appendStatePill(parent: HTMLElement, state: AgentState, count: number): void {
    const pill = parent.createDiv(`termy-agent-pill is-state is-${agentStateClass(state)}`);
    pill.title = `${agentStateLabel(state)} ${count}`;
    pill.createSpan('termy-agent-pill-dot');
    pill.createSpan('termy-agent-pill-count').setText(String(count));
  }

}

function appendMeter(parent: HTMLElement, percent: number | null, title: string, extraClasses: string[] = []): void {
  const meter = parent.createSpan('termy-agent-credit-meter');
  for (const extraClass of extraClasses) {
    meter.addClass(extraClass);
  }
  meter.style.setProperty('--termy-agent-meter-fill', `${percent ?? 0}%`);
  meter.toggleClass('is-empty', percent === null);
  meter.title = percent === null ? `${title}: n/a` : `${title}: ${percent}%`;
}

function creditTooltip(kind: AgentKind, credit: AgentCreditStatus): string {
  const name = kind === 'claude' ? 'Claude' : 'Codex';
  if (credit.unlimited) {
    return `${name}: unlimited · ${credit.source}`;
  }

  const lines = [
    `${name} · ${credit.source}`,
  ];
  if (kind === 'claude') {
    lines.push(`5h usage ${displayUsedPercent(credit.fiveHourRemainingPercent)}, reset ${displayResetTime(credit.fiveHourResetAtMs)}`);
  }
  lines.push(`weekly usage ${displayUsedPercent(credit.weeklyRemainingPercent)}, reset ${displayResetTime(credit.weeklyResetAtMs)}`);
  return lines.join('\n');
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
  if (sameDay) {
    return `${hours}:${minutes}`;
  }

  return `${date.getMonth() + 1}/${date.getDate()} ${hours}:${minutes}`;
}

function agentStateLabel(state: AgentState): string {
  switch (state) {
    case 'waitingApproval':
      return '需处理';
    case 'running':
      return '运行';
    case 'idle':
      return '空闲';
    case 'stale':
      return '空闲';
    case 'unknown':
      return '未知';
  }
}

function agentStateClass(state: AgentState): string {
  return state === 'waitingApproval' ? 'waiting-approval' : state;
}
