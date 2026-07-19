import { classifyCodexRateLimitWindows } from './codexRateLimits.ts';
import type { AgentStatusRuntime } from './runtime.ts';
import type { AgentCreditSnapshot, AgentCreditStatus, AgentCreditWindow } from './types.ts';

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const CLAUDE_USAGE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class CreditScanner {
  private readonly runtime: AgentStatusRuntime;

  constructor(runtime: AgentStatusRuntime) {
    this.runtime = runtime;
  }

  async scan(): Promise<AgentCreditSnapshot> {
    const [claude, codex] = await Promise.all([
      this.claudeCreditStatus(),
      this.codexCreditStatus(),
    ]);

    return {
      generatedAtMs: Date.now(),
      claude,
      codex,
    };
  }

  private async claudeCreditStatus(): Promise<AgentCreditStatus | null> {
    const raw = await this.runtime.readTextFile(this.claudeConfigJsonPath());
    const config = parseJson<Record<string, unknown>>(raw);
    const cachedUsage = recordValue(config?.cachedUsageUtilization);
    if (!cachedUsage) {
      return null;
    }

    const fetchedAtMs = numberValue(cachedUsage.fetchedAtMs);
    if (fetchedAtMs !== null && Date.now() - fetchedAtMs > CLAUDE_USAGE_CACHE_MAX_AGE_MS) {
      return null;
    }

    const utilization = recordValue(cachedUsage.utilization);
    if (!utilization) {
      return null;
    }

    const windows = this.claudeCreditWindows(utilization);
    if (windows.length === 0) {
      return null;
    }

    const fiveHour = windows.find((window) => window.id === 'five-hour') ?? null;
    const weekly = windows.find((window) => window.id === 'weekly-all') ?? null;

    return {
      fiveHourRemainingPercent: remainingPercentFromUsedPercent(fiveHour?.usedPercent),
      weeklyRemainingPercent: remainingPercentFromUsedPercent(weekly?.usedPercent),
      fiveHourResetAtMs: fiveHour?.resetAtMs ?? null,
      weeklyResetAtMs: weekly?.resetAtMs ?? null,
      unlimited: false,
      source: 'claude-cache',
      windows,
    };
  }

  private claudeConfigJsonPath(): string {
    const configDir = envString('CLAUDE_CONFIG_DIR')?.trim();
    if (!configDir) {
      return `${this.runtime.homeDir}/.claude.json`;
    }

    const expanded = configDir === '~'
      ? this.runtime.homeDir
      : configDir.startsWith('~/')
        ? `${this.runtime.homeDir}/${configDir.slice(2)}`
        : configDir;
    return `${expanded}.json`;
  }

  private claudeCreditWindows(utilization: Record<string, unknown>): AgentCreditWindow[] {
    const limits = arrayValue(utilization.limits)
      .map((entry) => recordValue(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null);

    const sessionLimit = limits.find((entry) => stringValue(entry.kind) === 'session')
      ?? limits.find((entry) => stringValue(entry.group) === 'session')
      ?? null;
    const weeklyAllLimit = limits.find((entry) => stringValue(entry.kind) === 'weekly_all')
      ?? limits.find((entry) => stringValue(entry.group) === 'weekly' && !recordValue(entry.scope))
      ?? null;
    const scopedWeeklyLimit = limits.find((entry) => isFableWeeklyLimit(entry))
      ?? limits.find((entry) => stringValue(entry.kind) === 'weekly_scoped')
      ?? null;

    return [
      limitWindow('five-hour', '5h', sessionLimit, FIVE_HOURS_MS)
        ?? utilizationWindow('five-hour', '5h', recordValue(utilization.five_hour), FIVE_HOURS_MS),
      limitWindow('weekly-all', 'W', weeklyAllLimit, SEVEN_DAYS_MS)
        ?? utilizationWindow('weekly-all', 'W', recordValue(utilization.seven_day), SEVEN_DAYS_MS),
      limitWindow('weekly-fable', 'F', scopedWeeklyLimit, SEVEN_DAYS_MS),
    ].filter((window): window is AgentCreditWindow => window !== null);
  }

  private async codexCreditStatus(): Promise<AgentCreditStatus | null> {
    const codex = await this.codexExecutablePath();
    if (!codex) {
      return null;
    }

    const request = [
      '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"agent-status-bar","title":null,"version":"dev"},"capabilities":null}}',
      '{"id":2,"method":"account/rateLimits/read"}',
      '',
    ].join('\n');

    const result = await this.runtime.runCommand(
      codex,
      ['app-server', '--stdio', '--disable', 'apps'],
      {
        timeoutMs: 12000,
        stdin: request,
        closeStdinAfterMs: 4000,
        environment: this.codexProcessEnvironment(codex),
      },
    );

    if (!result || result.exitCode !== 0) {
      return null;
    }

    return this.parseCodexRateLimits(result.stdout);
  }

  private parseCodexRateLimits(stdout: string): AgentCreditStatus | null {
    for (const line of stdout.split('\n')) {
      const object = parseJson<Record<string, unknown>>(line.trim());
      if (numberValue(object?.id) !== 2) {
        continue;
      }
      const result = object?.result as Record<string, unknown> | undefined;
      const rateLimits = result?.rateLimits as Record<string, unknown> | undefined;
      if (rateLimits) {
        return this.codexStatusFromRateLimits(rateLimits);
      }
    }
    return null;
  }

  private codexStatusFromRateLimits(rateLimits: Record<string, unknown>): AgentCreditStatus {
    const { fiveHour, weekly } = classifyCodexRateLimitWindows(rateLimits);
    const credits = rateLimits.credits as Record<string, unknown> | undefined;
    const weeklyUsedPercent = percentValue(weekly?.usedPercent);
    const weeklyResetAtMs = dateFromUnixSeconds(weekly?.resetsAt);

    return {
      fiveHourRemainingPercent: remainingPercentFromUsedPercent(fiveHour?.usedPercent),
      weeklyRemainingPercent: remainingPercentFromUsedPercent(weeklyUsedPercent),
      fiveHourResetAtMs: dateFromUnixSeconds(fiveHour?.resetsAt),
      weeklyResetAtMs,
      unlimited: boolValue(credits?.unlimited) ?? false,
      source: 'codex-app-server',
      windows: [{
        id: 'weekly',
        label: 'W',
        usedPercent: weeklyUsedPercent,
        resetAtMs: weeklyResetAtMs,
        windowMs: SEVEN_DAYS_MS,
      }],
    };
  }

  private async codexExecutablePath(): Promise<string | null> {
    for (const candidate of await this.codexExecutableCandidates()) {
      if (await this.runtime.fileExists(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  private async codexExecutableCandidates(): Promise<string[]> {
    const candidates: string[] = [];
    const path = envString('PATH');
    if (path) {
      candidates.push(...path
        .split(':')
        .filter(Boolean)
        .map((dir) => `${dir}/codex`));
    }

    candidates.push(
      `${this.runtime.homeDir}/.local/bin/codex`,
      `${this.runtime.homeDir}/.local/share/fnm/current/bin/codex`,
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
    );
    candidates.push(...await this.fnmNodeVersionCandidates());
    candidates.push(...await this.fnmMultishellCandidates());

    return [...new Set(candidates)];
  }

  private async fnmNodeVersionCandidates(): Promise<string[]> {
    const root = `${this.runtime.homeDir}/.local/share/fnm/node-versions`;
    const versions = await this.runtime.readDir(root);
    if (!versions) {
      return [];
    }
    return versions
      .slice()
      .sort()
      .reverse()
      .map((version) => `${root}/${version}/installation/bin/codex`);
  }

  private async fnmMultishellCandidates(): Promise<string[]> {
    const root = `${this.runtime.homeDir}/.local/state/fnm_multishells`;
    const shells = await this.runtime.readDir(root);
    if (!shells) {
      return [];
    }
    return shells
      .slice()
      .sort()
      .reverse()
      .map((shell) => `${root}/${shell}/bin/codex`);
  }

  private codexProcessEnvironment(executablePath: string): Record<string, string> {
    const environment = processEnvironment();
    const executableDir = executablePath.split('/').slice(0, -1).join('/') || '/';
    const currentPath = environment.PATH || '/usr/bin:/bin:/usr/sbin:/sbin';
    return {
      ...environment,
      HOME: this.runtime.homeDir,
      PATH: `${executableDir}:${currentPath}`,
    };
  }
}

function remainingPercentFromUsedPercent(value: unknown): number | null {
  const used = percentValue(value);
  return used === null ? null : clampPercent(100 - used);
}

function limitWindow(
  id: string,
  label: string,
  limit: Record<string, unknown> | null,
  windowMs: number,
): AgentCreditWindow | null {
  if (!limit) {
    return null;
  }

  const usedPercent = percentValue(limit.percent);
  const resetAtMs = dateFromIsoString(limit.resets_at);
  if (usedPercent === null && resetAtMs === null) {
    return null;
  }

  return { id, label, usedPercent, resetAtMs, windowMs };
}

function utilizationWindow(
  id: string,
  label: string,
  window: Record<string, unknown> | null,
  windowMs: number,
): AgentCreditWindow | null {
  if (!window) {
    return null;
  }

  const usedPercent = percentValue(window.utilization);
  const resetAtMs = dateFromIsoString(window.resets_at);
  if (usedPercent === null && resetAtMs === null) {
    return null;
  }

  return { id, label, usedPercent, resetAtMs, windowMs };
}

function isFableWeeklyLimit(limit: Record<string, unknown>): boolean {
  if (stringValue(limit.kind) !== 'weekly_scoped') {
    return false;
  }

  const scope = recordValue(limit.scope);
  const model = recordValue(scope?.model);
  const modelId = stringValue(model?.id)?.toLowerCase() ?? '';
  const displayName = stringValue(model?.display_name)?.toLowerCase() ?? '';
  return modelId.includes('fable') || displayName.includes('fable');
}

function percentValue(value: unknown): number | null {
  const percent = numberValue(value);
  return percent === null ? null : clampPercent(percent);
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
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

function boolValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }
  return null;
}

function dateFromIsoString(value: unknown): number | null {
  const text = stringValue(value);
  if (!text) {
    return null;
  }
  const time = new Date(text).getTime();
  return Number.isFinite(time) ? time : null;
}

function dateFromUnixSeconds(value: unknown): number | null {
  const seconds = numberValue(value);
  return seconds && seconds > 0 ? seconds * 1000 : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseJson<T>(text: string | null | undefined): T | null {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function envString(name: string): string | null {
  const value = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return typeof value === 'string' ? value : null;
}

function processEnvironment(): Record<string, string> {
  const source = typeof process !== 'undefined' ? process.env : {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') {
      result[key] = value;
    }
  }
  return result;
}
