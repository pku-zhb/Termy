import {
  EMPTY_AGENT_CREDIT_SNAPSHOT,
  type AgentClient,
  type AgentKind,
  type AgentSnapshot,
  type AgentTmuxClient,
} from './types.ts';
import type { AgentStatusRuntime } from './runtime.ts';

interface ProcInfo {
  pid: number;
  ppid: number;
  pgid: number;
  stat: string;
  tty: string;
  comm: string;
  args: string;
}

interface TmuxPaneInfo {
  sessionName: string;
  panePid: number;
  paneTty: string;
}

interface TmuxClientInfo {
  clientPid: number;
  clientTty: string;
  sessionName: string;
}

export interface AgentScannerOptions {
  now?: () => number;
}

const TMUX_FIELD_SEPARATOR = '|';
const TMUX_BINARY_CANDIDATES = [
  '/opt/homebrew/bin/tmux',
  '/usr/local/bin/tmux',
  '/usr/bin/tmux',
  '/bin/tmux',
];

/**
 * Lightweight process discovery for tab and tmux badges.
 *
 * Deliberately does not inspect Claude session files, Termy hooks, Codex logs,
 * or sqlite state. Termy only needs to know which process exists and where it
 * is attached; agent progress belongs to the agent UI itself.
 */
export class AgentScanner {
  private readonly runtime: AgentStatusRuntime;
  private readonly now: () => number;

  constructor(runtime: AgentStatusRuntime, options: AgentScannerOptions = {}) {
    this.runtime = runtime;
    this.now = options.now ?? (() => Date.now());
  }

  async scan(): Promise<AgentSnapshot> {
    if (this.runtime.platform === 'win32') {
      return this.makeSnapshot([]);
    }

    const [processes, tmuxPaneByTty, tmuxClients] = await Promise.all([
      this.loadProcesses(),
      this.loadTmuxPanes(),
      this.loadTmuxClients(),
    ]);
    const processByPid = new Map(processes.map((process) => [process.pid, process]));

    const codexClients = this.codexProcesses(processes, processByPid)
      .map((process) => this.makeClient('codex', process, tmuxPaneByTty));
    const claudeClients = processes
      .filter((process) => this.isScannableTerminalProcess(process)
        && this.isClaude(process)
        && !this.isClaudePrintMode(process))
      .map((process) => this.makeClient('claude', process, tmuxPaneByTty));

    const clients = this.dedupe([...codexClients, ...claudeClients]).sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind.localeCompare(right.kind);
      }
      return left.pid - right.pid;
    });

    return this.makeSnapshot(clients, tmuxClients);
  }

  private makeSnapshot(clients: AgentClient[], tmuxClients: TmuxClientInfo[] = []): AgentSnapshot {
    return {
      generatedAtMs: this.now(),
      clients,
      tmuxClients: this.makeTmuxClients(tmuxClients),
      credits: EMPTY_AGENT_CREDIT_SNAPSHOT,
    };
  }

  private makeClient(
    kind: AgentKind,
    process: ProcInfo,
    tmuxPaneByTty: Map<string, TmuxPaneInfo>,
  ): AgentClient {
    const tmuxPane = tmuxPaneByTty.get(normalizeTty(process.tty));
    return {
      id: `${kind}-${process.pid}`,
      kind,
      pid: process.pid,
      parentPid: process.ppid,
      processGroupId: process.pgid,
      surfaceId: tmuxPane ? `tmux:${tmuxPane.sessionName}` : null,
      tty: process.tty || null,
    };
  }

  private makeTmuxClients(tmuxClients: TmuxClientInfo[]): AgentTmuxClient[] {
    return tmuxClients
      .filter((client) => Number.isFinite(client.clientPid) && client.sessionName)
      .map((client) => ({
        pid: client.clientPid,
        tty: client.clientTty || null,
        sessionName: client.sessionName,
        surfaceId: `tmux:${client.sessionName}`,
      }));
  }

  private async loadProcesses(): Promise<ProcInfo[]> {
    const result = await this.runtime.runCommand(
      '/bin/ps',
      ['-axo', 'pid,ppid,pgid,stat,tty,comm,args'],
      { timeoutMs: 3000 },
    );
    if (!result || result.exitCode !== 0) {
      return [];
    }

    return result.stdout
      .split('\n')
      .slice(1)
      .map((line) => this.parseProcessLine(line))
      .filter((process): process is ProcInfo => process !== null);
  }

  private parseProcessLine(line: string): ProcInfo | null {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!match) {
      return null;
    }

    return {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      stat: match[4],
      tty: match[5],
      comm: match[6],
      args: match[7],
    };
  }

  private isScannableTerminalProcess(process: ProcInfo): boolean {
    return process.tty !== '??' && !process.stat.includes('T') && !process.stat.includes('Z');
  }

  private isClaude(process: ProcInfo): boolean {
    const executable = basename(process.comm);
    return executable === 'claude'
      || executable === 'claude-code'
      || process.args === 'claude'
      || process.args.startsWith('claude ')
      || process.args.endsWith('/claude')
      || process.args.includes('/bin/claude ')
      || process.args.includes('/bin/claude\t');
  }

  private isClaudePrintMode(process: ProcInfo): boolean {
    const tokens = argumentTokens(process.args);
    return tokens.includes('-p') || tokens.includes('--print');
  }

  private isCodexNative(process: ProcInfo): boolean {
    if (basename(process.comm) === 'codex') {
      return true;
    }
    return process.args.includes('@openai/codex')
      && process.args.includes('/vendor/')
      && (process.args.includes('/codex/codex')
        || process.args.endsWith('/bin/codex')
        || process.args.includes('/bin/codex '));
  }

  private isCodexWrapper(process: ProcInfo): boolean {
    return basename(process.comm) === 'node'
      && process.args.includes('/bin/codex')
      && !process.args.includes('/node_modules/');
  }

  private codexProcesses(processes: ProcInfo[], processByPid: Map<number, ProcInfo>): ProcInfo[] {
    const native = processes.filter((process) => this.isScannableTerminalProcess(process)
      && this.isCodexNative(process)
      && !this.isCodexExecMode(process, processByPid));
    const nativeAncestorPids = new Set(native.flatMap((process) => this.ancestors(process.pid, processByPid)));
    const wrappers = processes.filter((process) => this.isScannableTerminalProcess(process)
      && this.isCodexWrapper(process)
      && !this.isCodexExecMode(process, processByPid)
      && !nativeAncestorPids.has(process.pid));
    return [...native, ...wrappers];
  }

  private isCodexExecMode(process: ProcInfo, processByPid: Map<number, ProcInfo>): boolean {
    if (commandAfterExecutable(process.args, 'codex') === 'exec') {
      return true;
    }

    let current = process.ppid;
    const seen = new Set<number>();
    while (processByPid.has(current) && !seen.has(current)) {
      seen.add(current);
      const ancestor = processByPid.get(current);
      if (!ancestor) {
        break;
      }
      if (commandAfterExecutable(ancestor.args, 'codex') === 'exec') {
        return true;
      }
      current = ancestor.ppid;
    }
    return false;
  }

  private ancestors(pid: number, processByPid: Map<number, ProcInfo>): number[] {
    const result: number[] = [];
    let current = pid;
    const seen = new Set<number>();
    while (processByPid.has(current) && !seen.has(current)) {
      seen.add(current);
      const process = processByPid.get(current);
      if (!process) {
        break;
      }
      result.push(process.ppid);
      current = process.ppid;
    }
    return result;
  }

  private dedupe(clients: AgentClient[]): AgentClient[] {
    const result: AgentClient[] = [];
    const seen = new Set<string>();
    for (const client of clients) {
      const key = `${client.kind}:${client.pid}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(client);
      }
    }
    return result;
  }

  private async loadTmuxPanes(): Promise<Map<string, TmuxPaneInfo>> {
    const command = tmuxShellCommand(
      `list-panes -a -F "#{session_name}${TMUX_FIELD_SEPARATOR}#{pane_pid}${TMUX_FIELD_SEPARATOR}#{pane_tty}"`,
    );
    const result = await this.runtime.runCommand('/bin/sh', ['-lc', command], { timeoutMs: 1000 });
    const panes = new Map<string, TmuxPaneInfo>();
    if (!result || result.exitCode !== 0) {
      return panes;
    }

    for (const line of result.stdout.split('\n')) {
      const [sessionName, panePid, paneTty] = splitTmuxFields(line);
      if (!sessionName || !paneTty) {
        continue;
      }
      panes.set(normalizeTty(paneTty), {
        sessionName,
        panePid: Number(panePid) || 0,
        paneTty,
      });
    }
    return panes;
  }

  private async loadTmuxClients(): Promise<TmuxClientInfo[]> {
    const command = tmuxShellCommand(
      `list-clients -F "#{client_pid}${TMUX_FIELD_SEPARATOR}#{client_tty}${TMUX_FIELD_SEPARATOR}#{session_name}"`,
    );
    const result = await this.runtime.runCommand('/bin/sh', ['-lc', command], { timeoutMs: 1000 });
    if (!result || result.exitCode !== 0) {
      return [];
    }

    return result.stdout
      .split('\n')
      .map((line) => {
        const [clientPid, clientTty, sessionName] = splitTmuxFields(line);
        if (!clientPid || !sessionName) {
          return null;
        }
        return {
          clientPid: Number(clientPid),
          clientTty: clientTty || '',
          sessionName,
        };
      })
      .filter((client): client is TmuxClientInfo => client !== null
        && Number.isFinite(client.clientPid)
        && client.sessionName.length > 0);
  }
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function commandAfterExecutable(args: string, executableSuffix: string): string | null {
  const tokens = argumentTokens(args);
  for (let index = 0; index < tokens.length; index += 1) {
    if (basename(tokens[index]) === executableSuffix && index + 1 < tokens.length) {
      return tokens[index + 1];
    }
  }
  return null;
}

function argumentTokens(args: string): string[] {
  return args.split(/[ \t\n]+/).filter((token) => token.length > 0);
}

function normalizeTty(tty: string): string {
  return tty.replace(/^\/dev\//, '');
}

function splitTmuxFields(line: string): string[] {
  if (line.includes(TMUX_FIELD_SEPARATOR)) {
    return line.split(TMUX_FIELD_SEPARATOR);
  }
  if (line.includes('\t')) {
    return line.split('\t');
  }
  if (line.includes('\\t')) {
    return line.split('\\t');
  }
  return line.split('_');
}

function tmuxShellCommand(command: string): string {
  const candidates = [
    '"$(command -v tmux 2>/dev/null)"',
    ...TMUX_BINARY_CANDIDATES.map((candidate) => shellQuote(candidate)),
  ].join(' ');

  return [
    'tmux_uid="$(id -u 2>/dev/null || echo 0)"',
    `for tmux_bin in ${candidates}; do`,
    '[ -x "$tmux_bin" ] || continue',
    `tmux_output="$("$tmux_bin" ${command} 2>/dev/null)"`,
    'if [ -n "$tmux_output" ]; then printf "%s\\n" "$tmux_output"; exit 0; fi',
    'for tmux_socket in "/private/tmp/tmux-${tmux_uid}/default" "/tmp/tmux-${tmux_uid}/default"; do',
    '[ -S "$tmux_socket" ] || continue',
    `tmux_output="$("$tmux_bin" -S "$tmux_socket" ${command} 2>/dev/null)"`,
    'if [ -n "$tmux_output" ]; then printf "%s\\n" "$tmux_output"; exit 0; fi',
    'done',
    'done',
    'true',
  ].join('\n');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
