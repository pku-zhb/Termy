import { requestUrl } from 'obsidian';
import { classifyCodexRateLimitWindows } from './codexRateLimits.ts';
import type { AgentStatusRuntime } from './runtime.ts';
import type { AgentCreditSnapshot, AgentCreditStatus } from './types.ts';

interface ClaudeUsageCache {
  data?: ClaudeUsageData | null;
  lastGoodData?: ClaudeUsageData | null;
}

interface ClaudeUsageData {
  fiveHour?: unknown;
  sevenDay?: unknown;
  fiveHourResetAt?: string | null;
  sevenDayResetAt?: string | null;
}

interface ClaudeCredentialsFile {
  claudeAiOauth?: ClaudeOAuthCredentials | null;
}

interface ClaudeOAuthCredentials {
  accessToken?: string | null;
  subscriptionType?: string | null;
  expiresAt?: number | null;
}

interface ClaudeUsageApiResponse {
  five_hour?: {
    utilization?: unknown;
    resets_at?: string | null;
  } | null;
  seven_day?: {
    utilization?: unknown;
    resets_at?: string | null;
  } | null;
}

export class CreditScanner {
  private readonly runtime: AgentStatusRuntime;

  constructor(runtime: AgentStatusRuntime) {
    this.runtime = runtime;
  }

  async scan(): Promise<AgentCreditSnapshot> {
    const [codex, claude] = await Promise.all([
      this.codexCreditStatus(),
      this.claudeCreditStatus(),
    ]);

    return {
      generatedAtMs: Date.now(),
      codex,
      claude,
    };
  }

  private async claudeCreditStatus(): Promise<AgentCreditStatus | null> {
    const cachedUsage = await this.cachedClaudeUsage();
    if (cachedUsage && hasUsagePercent(cachedUsage)) {
      return this.claudeCreditStatusFromUsage(cachedUsage, 'claude-hud-cache');
    }

    const refreshedUsage = await this.refreshClaudeUsage();
    if (refreshedUsage && hasUsagePercent(refreshedUsage)) {
      return this.claudeCreditStatusFromUsage(refreshedUsage, 'claude-hud-api');
    }

    return null;
  }

  private claudeCreditStatusFromUsage(usage: ClaudeUsageData, source: string): AgentCreditStatus {
    return {
      fiveHourRemainingPercent: remainingPercentFromUsedPercent(usage.fiveHour),
      weeklyRemainingPercent: remainingPercentFromUsedPercent(usage.sevenDay),
      fiveHourResetAtMs: parseDateMs(usage.fiveHourResetAt),
      weeklyResetAtMs: parseDateMs(usage.sevenDayResetAt),
      unlimited: false,
      source,
    };
  }

  private async cachedClaudeUsage(): Promise<ClaudeUsageData | null> {
    const text = await this.runtime.readTextFile(`${this.runtime.homeDir}/.claude/plugins/claude-hud/.usage-cache.json`);
    const cache = parseJson<ClaudeUsageCache>(text);
    if (!cache) {
      return null;
    }

    return [cache.data, cache.lastGoodData]
      .filter((usage): usage is ClaudeUsageData => Boolean(usage))
      .find((usage) => hasUsagePercent(usage)) ?? null;
  }

  private async refreshClaudeUsage(): Promise<ClaudeUsageData | null> {
    const credentials = await this.claudeCredentials();
    const accessToken = credentials?.accessToken?.trim();
    if (!accessToken || !isClaudeSubscription(credentials?.subscriptionType)) {
      return null;
    }

    let timeout: number | null = null;
    try {
      const response = await Promise.race([
        requestUrl({
          url: 'https://api.anthropic.com/api/oauth/usage',
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'anthropic-beta': 'oauth-2025-04-20',
            'User-Agent': 'claude-code/2.1',
          },
        }),
        new Promise<null>((resolve) => {
          timeout = window.setTimeout(() => resolve(null), 8000);
        }),
      ]);
      if (!response || response.status !== 200) {
        return null;
      }
      const decoded = response.json as ClaudeUsageApiResponse;
      return {
        fiveHour: decoded.five_hour?.utilization,
        sevenDay: decoded.seven_day?.utilization,
        fiveHourResetAt: decoded.five_hour?.resets_at,
        sevenDayResetAt: decoded.seven_day?.resets_at,
      };
    } catch {
      return null;
    } finally {
      if (timeout !== null) {
        window.clearTimeout(timeout);
      }
    }
  }

  private async claudeCredentials(): Promise<ClaudeOAuthCredentials | null> {
    const keychainCredentials = await this.readClaudeKeychainCredentials();
    if (keychainCredentials) {
      if (isClaudeSubscription(keychainCredentials.subscriptionType)) {
        return keychainCredentials;
      }

      const subscriptionType = await this.readClaudeFileSubscriptionType();
      if (subscriptionType) {
        return {
          ...keychainCredentials,
          subscriptionType,
        };
      }

      return keychainCredentials;
    }

    return this.readClaudeFileCredentials();
  }

  private async readClaudeKeychainCredentials(): Promise<ClaudeOAuthCredentials | null> {
    const serviceNames = ['Claude Code-credentials'];
    const accountName = envString('USER')?.trim() ?? '';

    for (const serviceName of serviceNames) {
      if (accountName) {
        const withAccount = await this.loadClaudeKeychainCredentials(serviceName, accountName);
        if (withAccount) {
          return withAccount;
        }
      }

      const withoutAccount = await this.loadClaudeKeychainCredentials(serviceName, null);
      if (withoutAccount) {
        return withoutAccount;
      }
    }

    return null;
  }

  private async loadClaudeKeychainCredentials(
    serviceName: string,
    accountName: string | null,
  ): Promise<ClaudeOAuthCredentials | null> {
    const args = ['find-generic-password', '-s', serviceName];
    if (accountName) {
      args.push('-a', accountName);
    }
    args.push('-w');

    const result = await this.runtime.runCommand('/usr/bin/security', args, { timeoutMs: 3000 });
    if (!result || result.exitCode !== 0) {
      return null;
    }

    const file = parseJson<ClaudeCredentialsFile>(result.stdout.trim());
    return validClaudeCredentials(file?.claudeAiOauth ?? null);
  }

  private async readClaudeFileCredentials(): Promise<ClaudeOAuthCredentials | null> {
    const text = await this.runtime.readTextFile(`${this.runtime.homeDir}/.claude/.credentials.json`);
    const file = parseJson<ClaudeCredentialsFile>(text);
    return validClaudeCredentials(file?.claudeAiOauth ?? null);
  }

  private async readClaudeFileSubscriptionType(): Promise<string | null> {
    const text = await this.runtime.readTextFile(`${this.runtime.homeDir}/.claude/.credentials.json`);
    const file = parseJson<ClaudeCredentialsFile>(text);
    const subscriptionType = file?.claudeAiOauth?.subscriptionType?.trim();
    return subscriptionType || null;
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

function hasUsagePercent(usage: ClaudeUsageData): boolean {
  return usage.fiveHour !== undefined || usage.sevenDay !== undefined;
}

function validClaudeCredentials(credentials: ClaudeOAuthCredentials | null): ClaudeOAuthCredentials | null {
  const accessToken = credentials?.accessToken?.trim();
  if (!accessToken) {
    return null;
  }

  const expiresAt = credentials?.expiresAt;
  if (typeof expiresAt === 'number' && expiresAt <= Date.now()) {
    return null;
  }

  return credentials;
}

function isClaudeSubscription(subscriptionType: string | null | undefined): boolean {
  const value = subscriptionType?.trim();
  return Boolean(value && !value.toLowerCase().includes('api'));
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

function parseDateMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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
