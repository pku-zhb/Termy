import { setIcon } from 'obsidian';
import type {
  AgentClient,
  AgentCreditStatus,
  AgentKind,
  AgentSnapshot,
  AgentState,
  AgentStatusService,
} from '../../services/agentStatus/agentStatusService';
import { CLAUDE_ICON, CODEX_ICON } from '../terminal/statusIcons';

export class AgentMonitor {
  private readonly rootEl: HTMLElement;
  private readonly panelEl: HTMLElement;
  private service: AgentStatusService | null;
  private unsubscribe: (() => void) | null = null;
  private latestSnapshot: AgentSnapshot | null = null;

  constructor(container: HTMLElement, service: AgentStatusService | null) {
    this.service = service;
    this.rootEl = container.createDiv('termy-agent-monitor');
    this.panelEl = container.createDiv('termy-agent-monitor-panel');
    this.panelEl.addClass('is-hidden');

    this.rootEl.addEventListener('click', (event) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('button')) {
        return;
      }
      this.togglePanel();
      this.render(this.latestSnapshot);
    });

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
    this.panelEl.remove();
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

  private togglePanel(): void {
    this.panelEl.toggleClass('is-hidden', !this.panelEl.hasClass('is-hidden'));
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

    const refreshBtn = root.createEl('button', { cls: 'termy-agent-monitor-refresh clickable-icon' });
    refreshBtn.type = 'button';
    refreshBtn.setAttr('aria-label', '刷新 Agent 状态');
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      void this.service?.refresh(true);
    });

    const toggleBtn = root.createEl('button', { cls: 'termy-agent-monitor-toggle clickable-icon' });
    toggleBtn.type = 'button';
    toggleBtn.setAttr('aria-label', '展开 Agent 状态');
    setIcon(toggleBtn, this.panelEl.hasClass('is-hidden') ? 'chevron-down' : 'chevron-up');
    toggleBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      this.togglePanel();
      this.render(this.latestSnapshot);
    });

    this.renderPanel(snapshot);
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
    appendMeter(meters, credit ? usedPercent(credit.fiveHourRemainingPercent) : null, '5h usage');
    appendMeter(meters, credit ? resetElapsedPercent(credit.fiveHourResetAtMs, 5 * 60 * 60 * 1000) : null, '5h reset');
    appendMeter(meters, credit ? usedPercent(credit.weeklyRemainingPercent) : null, 'weekly usage', 'is-weekly-start');
    appendMeter(meters, credit ? resetElapsedPercent(credit.weeklyResetAtMs, 7 * 24 * 60 * 60 * 1000) : null, 'weekly reset');
  }

  private appendStatePill(parent: HTMLElement, state: AgentState, count: number): void {
    const pill = parent.createDiv(`termy-agent-pill is-state is-${agentStateClass(state)}`);
    pill.title = `${agentStateLabel(state)} ${count}`;
    pill.createSpan('termy-agent-pill-dot');
    pill.createSpan('termy-agent-pill-count').setText(String(count));
  }

  private renderPanel(snapshot: AgentSnapshot | null): void {
    const wasHidden = this.panelEl.hasClass('is-hidden');
    this.panelEl.empty();
    this.panelEl.toggleClass('is-hidden', wasHidden);

    if (!snapshot || snapshot.generatedAtMs === 0) {
      this.panelEl.createDiv('termy-agent-monitor-empty').setText('正在扫描 agent 会话...');
      return;
    }

    if (snapshot.clients.length === 0) {
      this.panelEl.createDiv('termy-agent-monitor-empty').setText('没有检测到 agent 进程');
      return;
    }

    const sections: Array<{ title: string; states: AgentState[] }> = [
      { title: '需要处理', states: ['waitingApproval'] },
      { title: '运行中', states: ['running'] },
      { title: '空闲', states: ['idle', 'stale'] },
      { title: '未知', states: ['unknown'] },
    ];

    for (const section of sections) {
      const clients = snapshot.clients
        .filter((client) => section.states.includes(client.state))
        .sort((a, b) => agentSortRank(a) - agentSortRank(b) || a.kind.localeCompare(b.kind) || a.pid - b.pid);
      if (clients.length === 0) {
        continue;
      }

      const sectionEl = this.panelEl.createDiv('termy-agent-monitor-section');
      const headingEl = sectionEl.createDiv('termy-agent-monitor-section-title');
      headingEl.createSpan().setText(section.title);
      headingEl.createSpan('termy-agent-monitor-section-count').setText(String(clients.length));

      for (const client of clients) {
        this.appendClientRow(sectionEl, client);
      }
    }
  }

  private appendClientRow(parent: HTMLElement, client: AgentClient): void {
    const row = parent.createDiv(`termy-agent-client is-${client.kind} is-${agentStateClass(client.state)}`);
    const icon = row.createEl('img', { cls: 'termy-agent-client-icon' });
    icon.alt = '';
    icon.src = client.kind === 'claude' ? CLAUDE_ICON : CODEX_ICON;

    const body = row.createDiv('termy-agent-client-body');
    const title = body.createDiv('termy-agent-client-title');
    title.createSpan('termy-agent-client-name').setText(agentClientTitle(client));
    title.createSpan(`termy-agent-client-state is-${agentStateClass(client.state)}`).setText(agentStateLabel(client.state));

    body.createDiv('termy-agent-client-subtitle').setText(agentClientSubtitle(client));
  }

}

function agentClientTitle(client: AgentClient): string {
  const title = client.title?.trim();
  if (title) {
    return title;
  }
  if (client.cwd) {
    return basenamePath(client.cwd);
  }
  return client.kind === 'claude' ? 'Claude Code 会话' : 'Codex 会话';
}

function agentClientSubtitle(client: AgentClient): string {
  const parts = [client.detail || agentStateLabel(client.state)];
  if (client.waitingSinceMs && client.state === 'waitingApproval') {
    parts.push(`已等 ${durationSince(client.waitingSinceMs)}`);
  } else if (client.lastSeenAtMs) {
    parts.push(`${durationSince(client.lastSeenAtMs)}前`);
  }
  if (client.cwd) {
    parts.push(basenamePath(client.cwd));
  }
  if (client.surfaceId) {
    parts.push(client.surfaceId);
  }
  parts.push(`pid ${client.pid}`);
  return parts.join(' · ');
}

function appendMeter(parent: HTMLElement, percent: number | null, title: string, extraClass?: string): void {
  const meter = parent.createSpan('termy-agent-credit-meter');
  if (extraClass) {
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

  return [
    `${name} · ${credit.source}`,
    `5h usage ${displayUsedPercent(credit.fiveHourRemainingPercent)}, reset ${displayResetTime(credit.fiveHourResetAtMs)}`,
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

function agentSortRank(client: AgentClient): number {
  switch (client.state) {
    case 'waitingApproval':
      return 0;
    case 'running':
      return 1;
    case 'unknown':
      return 2;
    case 'idle':
    case 'stale':
      return 4;
  }
}

function durationSince(timeMs: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timeMs) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h`;
}

function basenamePath(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
