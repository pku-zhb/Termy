import { classifyCodexRateLimitWindows } from './codexRateLimits.ts';
import type { AgentStatusRuntime } from './runtime.ts';
import type { AgentCreditSnapshot, AgentCreditStatus } from './types.ts';

export class CreditScanner {
  private readonly runtime: AgentStatusRuntime;

  constructor(runtime: AgentStatusRuntime) {
    this.runtime = runtime;
  }

  async scan(): Promise<AgentCreditSnapshot> {
    const codex = await this.codexCreditStatus();

    return {
      generatedAtMs: Date.now(),
      codex,
    };
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

    return {
      fiveHourRemainingPercent: remainingPercentFromUsedPercent(fiveHour?.usedPercent),
      weeklyRemainingPercent: remainingPercentFromUsedPercent(weekly?.usedPercent),
      fiveHourResetAtMs: dateFromUnixSeconds(fiveHour?.resetsAt),
      weeklyResetAtMs: dateFromUnixSeconds(weekly?.resetsAt),
      unlimited: boolValue(credits?.unlimited) ?? false,
      source: 'codex-app-server',
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
  const used = numberValue(value);
  return used === null ? null : clampPercent(100 - used);
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

function dateFromUnixSeconds(value: unknown): number | null {
  const seconds = numberValue(value);
  return seconds && seconds > 0 ? seconds * 1000 : null;
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
