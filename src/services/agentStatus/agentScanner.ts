import {
  EMPTY_AGENT_CREDIT_SNAPSHOT,
  type AgentClient,
  type AgentKind,
  type AgentSnapshot,
  type AgentState,
  type AgentSummary,
  type AgentTmuxClient,
} from './types.ts';
import type { AgentStatusRuntime } from './runtime.ts';
import {
  loadHookAgentState,
  matchHookAgentState,
  type HookAgentStateStore,
} from './hookState.ts';

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

interface CodexThreadInfo {
  id: string;
  title: string | null;
  cwd: string | null;
  updatedAtMs: number | null;
}

interface CodexRuntimeInfo {
  state: AgentState;
  threadId: string | null;
  detail: string | null;
  lastSeenAtMs: number | null;
  waitingSinceMs: number | null;
}

interface ClaudeSessionInfo {
  pid: number;
  sessionId?: string | null;
  cwd?: string | null;
  startedAt?: number | null;
  status?: string | null;
  updatedAt?: number | null;
  name?: string | null;
  kind?: string | null;
  entrypoint?: string | null;
}

export interface AgentScannerOptions {
  now?: () => number;
  sqlitePath?: string;
}

const CLAUDE_BUSY_FRESHNESS_MS = 5 * 60 * 1000;
const CODEX_TURN_ACTIVITY_FRESHNESS_MS = 90 * 1000;
const CODEX_THREAD_LOOKUP_WINDOW_SECONDS = 24 * 60 * 60;
const SQLITE_QUERY_TIMEOUT_MS = 1000;
const TMUX_FIELD_SEPARATOR = '|';
const TMUX_BINARY_CANDIDATES = [
  '/opt/homebrew/bin/tmux',
  '/usr/local/bin/tmux',
  '/usr/bin/tmux',
  '/bin/tmux',
];

export class AgentScanner {
  private readonly runtime: AgentStatusRuntime;
  private readonly now: () => number;
  private readonly sqlitePath: string;

  constructor(runtime: AgentStatusRuntime, options: AgentScannerOptions = {}) {
    this.runtime = runtime;
    this.now = options.now ?? (() => Date.now());
    this.sqlitePath = options.sqlitePath ?? '/usr/bin/sqlite3';
  }

  async scan(): Promise<AgentSnapshot> {
    if (this.runtime.platform === 'win32') {
      return this.makeSnapshot([]);
    }

    const processes = await this.loadProcesses();
    const processByPid = new Map(processes.map((process) => [process.pid, process]));
    const [claudeSessions, hookState, tmuxPaneByTty, tmuxClients] = await Promise.all([
      this.loadClaudeSessions(),
      loadHookAgentState(this.runtime),
      this.loadTmuxPanes(),
      this.loadTmuxClients(),
    ]);

    const codexClients = await Promise.all(
      this.codexProcesses(processes, processByPid)
        .map((process) => this.makeCodexClient(process, processes, processByPid, tmuxPaneByTty, hookState)),
    );
    const claudeClients = processes
      .filter((process) =>
        this.isScannableTerminalProcess(process)
        && this.isClaude(process)
        && !this.isClaudePrintMode(process))
      .map((process) =>
        this.makeClaudeClient(process, claudeSessions.get(process.pid), processes, processByPid, tmuxPaneByTty, hookState));

    const clients = this.dedupe([...codexClients, ...claudeClients]).sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind.localeCompare(b.kind);
      }
      return a.pid - b.pid;
    });

    return this.makeSnapshot(clients, tmuxClients);
  }

  private makeSnapshot(clients: AgentClient[], tmuxClients: TmuxClientInfo[] = []): AgentSnapshot {
    return {
      generatedAtMs: this.now(),
      agentPids: [...clients.map((client) => client.pid)].sort((a, b) => a - b),
      clients,
      tmuxClients: this.makeTmuxClients(tmuxClients),
      summary: this.makeSummary(clients),
      credits: EMPTY_AGENT_CREDIT_SNAPSHOT,
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
    const result = await this.runtime.runCommand('/bin/ps', ['-axo', 'pid,ppid,pgid,stat,tty,comm,args'], { timeoutMs: 3000 });
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

  private isTerminalProcess(process: ProcInfo): boolean {
    return process.tty !== '??';
  }

  private isScannableTerminalProcess(process: ProcInfo): boolean {
    return this.isTerminalProcess(process) && !this.isStoppedOrZombieProcess(process);
  }

  private isStoppedOrZombieProcess(process: ProcInfo): boolean {
    return process.stat.includes('T') || process.stat.includes('Z');
  }

  private executableName(process: ProcInfo): string {
    return basename(process.comm);
  }

  private isClaude(process: ProcInfo): boolean {
    const executable = this.executableName(process);
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
    if (this.executableName(process) === 'codex') {
      return true;
    }
    return process.args.includes('@openai/codex')
      && process.args.includes('/vendor/')
      && (process.args.includes('/codex/codex')
        || process.args.endsWith('/bin/codex')
        || process.args.includes('/bin/codex '));
  }

  private isCodexWrapper(process: ProcInfo): boolean {
    return this.executableName(process) === 'node'
      && process.args.includes('/bin/codex')
      && !process.args.includes('/node_modules/');
  }

  private codexProcesses(processes: ProcInfo[], processByPid: Map<number, ProcInfo>): ProcInfo[] {
    const native = processes.filter((process) =>
      this.isScannableTerminalProcess(process)
      && this.isCodexNative(process)
      && !this.isCodexExecMode(process, processByPid));
    const nativeAncestorPids = new Set(native.flatMap((process) => this.ancestors(process.pid, processByPid)));
    const wrappers = processes.filter((process) =>
      this.isScannableTerminalProcess(process)
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

  private async makeCodexClient(
    process: ProcInfo,
    processes: ProcInfo[],
    processByPid: Map<number, ProcInfo>,
    tmuxPaneByTty: Map<string, TmuxPaneInfo>,
    hookState: HookAgentStateStore,
  ): Promise<AgentClient> {
    const hasActiveChild = this.hasActiveChildProcess(process.pid, processes, processByPid);
    let hook = matchHookAgentState(hookState, {
      kind: 'codex',
      pid: process.pid,
      hasActiveChild,
    }, this.now());
    const shouldUseHookWithoutRuntime = hook?.authoritativeState === 'running'
      || hook?.authoritativeState === 'waitingApproval'
      || hook?.authoritativeState === 'idle';
    const fallbackState = this.processState(hasActiveChild);
    const runtime = shouldUseHookWithoutRuntime
      ? unknownCodexRuntimeInfo()
      : await this.codexRuntimeInfo(process.pid, hasActiveChild);
    const thread = runtime.threadId ? await this.codexThreadInfo(runtime.threadId) : null;
    if (!hook && thread?.cwd) {
      hook = matchHookAgentState(hookState, {
        kind: 'codex',
        pid: process.pid,
        cwd: thread.cwd,
        hasActiveChild,
      }, this.now());
    }
    const state = hook?.authoritativeState ?? (runtime.state === 'unknown' ? fallbackState : runtime.state);

    const tmuxPane = this.tmuxPaneForProcess(process, tmuxPaneByTty);

    return {
      id: `codex-${process.pid}`,
      kind: 'codex',
      pid: process.pid,
      parentPid: process.ppid,
      processGroupId: process.pgid,
      workspaceId: tmuxPane?.sessionName ?? null,
      surfaceId: tmuxPane ? `tmux:${tmuxPane.sessionName}` : null,
      tty: process.tty || null,
      state,
      cwd: thread?.cwd ?? hook?.record.cwd ?? null,
      title: thread?.title ?? hook?.record.title ?? this.processTitle('codex', process),
      detail: hookDetail(hook?.record.detail ?? null, hook?.record.eventName ?? null) ?? runtime.detail ?? detailText('process', state),
      lastSeenAtMs: newestTime(runtime.lastSeenAtMs, thread?.updatedAtMs ?? null, hook?.record.updatedAtMs ?? null),
      waitingSinceMs: state === 'waitingApproval' ? (hook?.record.waitingSinceMs ?? runtime.waitingSinceMs) : null,
    };
  }

  private makeClaudeClient(
    process: ProcInfo,
    session: ClaudeSessionInfo | undefined,
    processes: ProcInfo[],
    processByPid: Map<number, ProcInfo>,
    tmuxPaneByTty: Map<string, TmuxPaneInfo>,
    hookState: HookAgentStateStore,
  ): AgentClient {
    const hasActiveChild = this.hasActiveChildProcess(process.pid, processes, processByPid);
    const sessionUpdatedAtMs = dateFromMilliseconds(session?.updatedAt);
    const hook = matchHookAgentState(hookState, {
      kind: 'claude',
      pid: process.pid,
      sessionId: session?.sessionId ?? null,
      cwd: session?.cwd ?? null,
      hasActiveChild,
    }, this.now());
    const state = hook?.authoritativeState ?? this.claudeState(session, hasActiveChild);
    const tmuxPane = this.tmuxPaneForProcess(process, tmuxPaneByTty);

    return {
      id: `claude-${process.pid}`,
      kind: 'claude',
      pid: process.pid,
      parentPid: process.ppid,
      processGroupId: process.pgid,
      workspaceId: tmuxPane?.sessionName ?? null,
      surfaceId: tmuxPane ? `tmux:${tmuxPane.sessionName}` : null,
      tty: process.tty || null,
      state,
      cwd: session?.cwd?.trim() || hook?.record.cwd || null,
      title: this.claudeTitle(session, process, hook?.record.title ?? null),
      detail: hookDetail(hook?.record.detail ?? null, hook?.record.eventName ?? null) ?? this.claudeDetail(session, state),
      lastSeenAtMs: newestTime(sessionUpdatedAtMs, hook?.record.updatedAtMs ?? null),
      waitingSinceMs: state === 'waitingApproval' ? (hook?.record.waitingSinceMs ?? sessionUpdatedAtMs) : null,
    };
  }

  private processTitle(kind: AgentKind, process: ProcInfo): string {
    return process.tty ? `${displayAgentKind(kind)} ${process.tty}` : displayAgentKind(kind);
  }

  private processState(hasActiveChild: boolean): AgentState {
    return hasActiveChild ? 'running' : 'idle';
  }

  private claudeState(session: ClaudeSessionInfo | undefined, hasActiveChild: boolean): AgentState {
    const status = session?.status?.trim();
    if (!status) {
      return this.processState(hasActiveChild);
    }

    const compact = compactStatus(status);
    if (['busy', 'running', 'thinking', 'working'].includes(compact)) {
      const updatedAtMs = dateFromMilliseconds(session?.updatedAt);
      return hasActiveChild || this.isRecent(updatedAtMs, CLAUDE_BUSY_FRESHNESS_MS) ? 'running' : 'idle';
    }
    if (['waiting', 'needsinput', 'needsapproval', 'waitingapproval', 'blocked', 'paused'].includes(compact)) {
      return 'waitingApproval';
    }
    if (compact === 'idle' || compact === 'ready') {
      return 'idle';
    }
    if (['ended', 'exited', 'closed'].includes(compact)) {
      return 'stale';
    }
    return this.processState(hasActiveChild);
  }

  private claudeTitle(session: ClaudeSessionInfo | undefined, process: ProcInfo, hookTitle: string | null): string {
    const name = session?.name?.trim();
    return name || hookTitle || this.processTitle('claude', process);
  }

  private claudeDetail(session: ClaudeSessionInfo | undefined, state: AgentState): string {
    const status = session?.status?.trim();
    if (status) {
      const compact = compactStatus(status);
      if (state === 'idle' && ['busy', 'running', 'thinking', 'working'].includes(compact)) {
        return `claude session: stale ${status}`;
      }
      return `claude session: ${status}`;
    }
    return detailText('process', state);
  }

  private async loadClaudeSessions(): Promise<Map<number, ClaudeSessionInfo>> {
    const directory = `${this.runtime.homeDir}/.claude/sessions`;
    const files = await this.runtime.readDir(directory);
    const sessions = new Map<number, ClaudeSessionInfo>();
    if (!files) {
      return sessions;
    }

    await Promise.all(files
      .filter((file) => file.endsWith('.json'))
      .map(async (file) => {
        const text = await this.runtime.readTextFile(`${directory}/${file}`);
        if (!text) {
          return;
        }
        try {
          const session = JSON.parse(text) as ClaudeSessionInfo;
          if (Number.isFinite(session.pid)) {
            sessions.set(session.pid, session);
          }
        } catch {
          // Ignore malformed session files.
        }
      }));
    return sessions;
  }

  private async loadTmuxPanes(): Promise<Map<string, TmuxPaneInfo>> {
    const command = tmuxShellCommand(`list-panes -a -F "#{session_name}${TMUX_FIELD_SEPARATOR}#{pane_pid}${TMUX_FIELD_SEPARATOR}#{pane_tty}"`);
    const result = await this.runtime.runCommand('/bin/sh', [
      '-lc',
      command,
    ], { timeoutMs: 1000 });
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
    const command = tmuxShellCommand(`list-clients -F "#{client_pid}${TMUX_FIELD_SEPARATOR}#{client_tty}${TMUX_FIELD_SEPARATOR}#{session_name}"`);
    const result = await this.runtime.runCommand('/bin/sh', [
      '-lc',
      command,
    ], { timeoutMs: 1000 });
    if (!result || result.exitCode !== 0) {
      return [];
    }

    const clients = result.stdout
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
      .filter((client): client is TmuxClientInfo =>
        client !== null
        && Number.isFinite(client.clientPid)
        && client.sessionName.length > 0);
    return clients;
  }

  private tmuxPaneForProcess(
    process: ProcInfo,
    tmuxPaneByTty: Map<string, TmuxPaneInfo>,
  ): TmuxPaneInfo | undefined {
    return tmuxPaneByTty.get(normalizeTty(process.tty));
  }

  private hasActiveChildProcess(rootPid: number, processes: ProcInfo[], processByPid: Map<number, ProcInfo>): boolean {
    const roots = new Set([rootPid]);
    return processes.some((process) =>
      process.pid !== rootPid
      && !this.isIgnorableAgentChild(process)
      && this.isDescendant(process.pid, roots, processByPid));
  }

  private isIgnorableAgentChild(process: ProcInfo): boolean {
    const executable = this.executableName(process);
    return executable === 'caffeinate'
      || process.args === 'caffeinate'
      || process.args.startsWith('caffeinate ')
      || process.args === '/usr/bin/caffeinate'
      || process.args.startsWith('/usr/bin/caffeinate ')
      || this.isCodexCompanionChild(process);
  }

  private isCodexCompanionChild(process: ProcInfo): boolean {
    return process.args.includes('/Codex.app/Contents/Resources/node_repl')
      || process.args.includes('/Codex.app/Contents/Resources/codex app-server')
      || process.args.includes('/codex app-server --listen stdio://')
      || process.args.endsWith('/Resources/node_repl');
  }

  private isDescendant(pid: number, roots: Set<number>, processByPid: Map<number, ProcInfo>): boolean {
    if (roots.has(pid)) {
      return true;
    }
    let current = pid;
    const seen = new Set<number>();
    while (processByPid.has(current) && !seen.has(current)) {
      seen.add(current);
      const process = processByPid.get(current);
      if (!process) {
        break;
      }
      if (roots.has(process.ppid)) {
        return true;
      }
      current = process.ppid;
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

  private async codexRuntimeInfo(pid: number, hasActiveToolChild: boolean): Promise<CodexRuntimeInfo> {
    const db = `${this.runtime.homeDir}/.codex/logs_2.sqlite`;
    if (!await this.runtime.fileExists(db)) {
      return unknownCodexRuntimeInfo();
    }

    const like = `pid:${pid}:%`;
    const metricsQuery = `
WITH latest_thread AS (
  SELECT thread_id
  FROM logs
  WHERE ts >= strftime('%s','now') - ${CODEX_THREAD_LOOKUP_WINDOW_SECONDS}
    AND process_uuid LIKE '${sqlEscape(like)}'
    AND thread_id IS NOT NULL
    AND thread_id != ''
  ORDER BY ts DESC, ts_nanos DESC, id DESC
  LIMIT 1
)
SELECT
  (SELECT thread_id FROM latest_thread),
  COALESCE(MAX(ts * 1000000000 + ts_nanos), 0),
  COALESCE(MAX(CASE WHEN target = 'codex_core::tasks' AND feedback_log_body LIKE 'codex_core::tasks: new%' AND feedback_log_body LIKE '%turn{%' THEN ts * 1000000000 + ts_nanos END), 0),
  COALESCE(MAX(CASE WHEN target = 'codex_core::tasks' AND feedback_log_body LIKE 'codex_core::tasks: close time.busy=%' AND feedback_log_body LIKE '%turn{%' THEN ts * 1000000000 + ts_nanos END), 0),
  COALESCE(MAX(CASE WHEN target = 'codex_core::stream_events_utils' AND feedback_log_body LIKE '%:handle_output_item_done: ToolCall: exec_command {%' AND (feedback_log_body LIKE '%"sandbox_permissions":"require_escalated"%' OR feedback_log_body LIKE '%"sandbox_permissions": "require_escalated"%') THEN ts * 1000000000 + ts_nanos END), 0),
  COALESCE(MAX(CASE WHEN target IN ('codex_core::session', 'codex_core::tasks') AND (feedback_log_body LIKE 'session_loop%op.dispatch.exec_approval%' OR feedback_log_body LIKE 'session_loop%op.dispatch.patch_approval%') THEN ts * 1000000000 + ts_nanos END), 0),
  COALESCE(MAX(CASE WHEN target = 'codex_otel.trace_safe' AND feedback_log_body LIKE '%event.name="codex.tool_result"%' AND feedback_log_body LIKE '%tool_name=exec_command%' THEN ts * 1000000000 + ts_nanos END), 0),
  COALESCE(MAX(CASE WHEN target = 'codex_core::stream_events_utils' AND (feedback_log_body LIKE '%:handle_output_item_done: ToolCall: request_user_input {%' OR feedback_log_body LIKE '%:handle_output_item_done: ToolCall: ask_question {%' OR feedback_log_body LIKE '%:handle_output_item_done: ToolCall: askquestion {%') THEN ts * 1000000000 + ts_nanos END), 0),
  COALESCE(MAX(CASE WHEN target = 'codex_otel.trace_safe' AND feedback_log_body LIKE '%event.name="codex.tool_result"%' AND (feedback_log_body LIKE '%tool_name=request_user_input%' OR feedback_log_body LIKE '%tool_name=ask_question%' OR feedback_log_body LIKE '%tool_name=askquestion%') THEN ts * 1000000000 + ts_nanos END), 0),
  COALESCE(MAX(CASE WHEN target = 'codex_core::session' AND feedback_log_body LIKE 'session_loop%interrupt received: abort current task%' THEN ts * 1000000000 + ts_nanos END), 0),
  COALESCE(MAX(CASE WHEN (target = 'codex_otel.trace_safe' AND (feedback_log_body LIKE '%otel.name="session_task.turn"%' OR feedback_log_body LIKE '%codex.op="user_input_with_turn_context"%' OR feedback_log_body LIKE '%run_sampling_request%' OR feedback_log_body LIKE '%event.name="codex.tool_result"%')) OR (target = 'codex_core::stream_events_utils' AND feedback_log_body LIKE '%:handle_output_item_done: ToolCall:%') THEN ts * 1000000000 + ts_nanos END), 0),
  COALESCE(MAX(CASE WHEN target = 'codex_core::stream_events_utils' AND feedback_log_body LIKE '%:handle_output_item_done: ToolCall:%' THEN ts * 1000000000 + ts_nanos END), 0),
  COALESCE(MAX(CASE WHEN target = 'codex_otel.trace_safe' AND feedback_log_body LIKE '%event.name="codex.tool_result"%' THEN ts * 1000000000 + ts_nanos END), 0),
  COALESCE(MAX(CASE WHEN target = 'codex_core::session::turn' AND feedback_log_body LIKE '%:run_turn: post sampling token usage%' AND feedback_log_body LIKE '% needs_follow_up=true%' THEN ts * 1000000000 + ts_nanos END), 0),
  COALESCE(MAX(CASE WHEN target = 'codex_core::session::turn' AND feedback_log_body LIKE '%:run_turn: post sampling token usage%' AND feedback_log_body LIKE '% needs_follow_up=false%' THEN ts * 1000000000 + ts_nanos END), 0)
FROM logs
WHERE thread_id = (SELECT thread_id FROM latest_thread);
`;

    const metrics = (await this.sqliteRows(db, metricsQuery))[0] ?? [];
    const threadId = nilIfEmpty(metrics[0]);
    const lastSeenAtMs = dateFromNanoseconds(metrics[1]);
    const turnStart = bigIntValue(metrics[2]);
    const turnEnd = bigIntValue(metrics[3]);
    const escalated = bigIntValue(metrics[4]);
    const approval = bigIntValue(metrics[5]);
    const toolResult = bigIntValue(metrics[6]);
    const question = bigIntValue(metrics[7]);
    const questionResult = bigIntValue(metrics[8]);
    const interrupt = bigIntValue(metrics[9]);
    const turnActivityNs = bigIntValue(metrics[10]);
    const turnActivityMs = dateFromNanoseconds(metrics[10]);
    const toolCall = bigIntValue(metrics[11]);
    const anyToolResult = bigIntValue(metrics[12]);
    const turnNeedsFollowUp = bigIntValue(metrics[13]);
    const turnFinished = bigIntValue(metrics[14]);

    const approvalResolvedNs = maxBigInt(approval, toolResult, interrupt);
    const questionResolvedNs = maxBigInt(questionResult, interrupt);
    const approvalWaitingSinceMs = dateFromNanoseconds(metrics[4]);
    const questionWaitingSinceMs = dateFromNanoseconds(metrics[7]);
    const approvalIsMature = approvalWaitingSinceMs !== null && this.now() - approvalWaitingSinceMs >= 1200;
    const approvalPending = escalated > approvalResolvedNs && approvalIsMature && !hasActiveToolChild;
    const questionPending = question > questionResolvedNs;
    const waitingNs = questionPending ? question : (approvalPending ? escalated : 0n);
    const waitingSinceMs = dateFromNanoseconds(waitingNs.toString());
    const isWaitingForQuestion = questionPending && questionWaitingSinceMs !== null;
    const hasRecentTurnActivity = turnActivityMs !== null && this.now() - turnActivityMs <= CODEX_TURN_ACTIVITY_FRESHNESS_MS;
    const toolCallWaitingSinceMs = dateFromNanoseconds(metrics[11]);
    const toolCallIsRecent = toolCallWaitingSinceMs !== null && this.now() - toolCallWaitingSinceMs <= 30 * 60 * 1000;
    const toolCallPending = toolCall > anyToolResult && toolCallIsRecent;
    const strictTurnResolved = maxBigInt(turnFinished, interrupt);
    const hasStrictTurnSignal = maxBigInt(turnNeedsFollowUp, turnFinished) > 0n;
    const strictTurnRunning = turnNeedsFollowUp > strictTurnResolved;
    const strictTurnFinished = hasStrictTurnSignal
      && strictTurnResolved > turnNeedsFollowUp
      && turnActivityNs <= strictTurnResolved;

    const state = resolveCodexState({
      approvalPending,
      questionPending,
      hasActiveToolChild,
      toolCallPending,
      strictTurnRunning,
      strictTurnFinished,
      turnStart,
      turnEnd,
      hasRecentTurnActivity,
      hasLastSeen: lastSeenAtMs !== null,
    });

    return {
      state,
      threadId,
      detail: codexDetail(state, isWaitingForQuestion, toolCallPending, strictTurnRunning),
      lastSeenAtMs,
      waitingSinceMs: state === 'waitingApproval' ? waitingSinceMs : null,
    };
  }

  private async codexThreadInfo(threadId: string): Promise<CodexThreadInfo | null> {
    const db = `${this.runtime.homeDir}/.codex/state_5.sqlite`;
    if (!await this.runtime.fileExists(db)) {
      return null;
    }
    const query = `
SELECT title, cwd, updated_at_ms
FROM threads
WHERE id = '${sqlEscape(threadId)}'
LIMIT 1;
`;
    const row = (await this.sqliteRows(db, query))[0];
    if (!row) {
      return null;
    }
    return {
      id: threadId,
      title: nilIfEmpty(row[0]),
      cwd: nilIfEmpty(row[1]),
      updatedAtMs: numberValue(row[2]),
    };
  }

  private async sqliteRows(db: string, query: string): Promise<string[][]> {
    if (!await this.runtime.fileExists(db)) {
      return [];
    }
    const result = await this.runtime.runCommand(
      this.sqlitePath,
      ['-batch', '-separator', '\t', db, query],
      { timeoutMs: SQLITE_QUERY_TIMEOUT_MS },
    );
    if (!result || result.exitCode !== 0) {
      return [];
    }

    return result.stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => line.split('\t'));
  }

  private isRecent(timeMs: number | null, freshnessMs: number): boolean {
    return timeMs !== null && this.now() - timeMs <= freshnessMs;
  }

  private makeSummary(clients: AgentClient[]): AgentSummary {
    return {
      total: clients.length,
      claude: clients.filter((client) => client.kind === 'claude').length,
      codex: clients.filter((client) => client.kind === 'codex').length,
      running: clients.filter((client) => client.state === 'running').length,
      waitingApproval: clients.filter((client) => client.state === 'waitingApproval').length,
      idle: clients.filter((client) => client.state === 'idle').length,
      stale: clients.filter((client) => client.state === 'stale').length,
      unknown: clients.filter((client) => client.state === 'unknown').length,
    };
  }
}

interface CodexStateInput {
  approvalPending: boolean;
  questionPending: boolean;
  hasActiveToolChild: boolean;
  toolCallPending: boolean;
  strictTurnRunning: boolean;
  strictTurnFinished: boolean;
  turnStart: bigint;
  turnEnd: bigint;
  hasRecentTurnActivity: boolean;
  hasLastSeen: boolean;
}

export function resolveCodexState(input: CodexStateInput): AgentState {
  if (input.approvalPending || input.questionPending) {
    return 'waitingApproval';
  }
  if (input.hasActiveToolChild || input.toolCallPending || input.strictTurnRunning) {
    return 'running';
  }
  if (input.strictTurnFinished) {
    return 'idle';
  }
  if (input.turnStart > input.turnEnd || input.hasRecentTurnActivity) {
    return 'running';
  }
  if (input.hasLastSeen) {
    return 'idle';
  }
  return 'unknown';
}

function unknownCodexRuntimeInfo(): CodexRuntimeInfo {
  return {
    state: 'unknown',
    threadId: null,
    detail: null,
    lastSeenAtMs: null,
    waitingSinceMs: null,
  };
}

function codexDetail(
  state: AgentState,
  isWaitingForQuestion: boolean,
  toolCallPending: boolean,
  strictTurnRunning: boolean,
): string | null {
  if (state === 'waitingApproval') {
    return isWaitingForQuestion ? '等待用户回答' : '等待命令或补丁批准';
  }
  if (state === 'running') {
    if (toolCallPending) {
      return 'tool call pending';
    }
    return strictTurnRunning ? 'turn follow-up pending' : 'turn active';
  }
  if (state === 'idle' || state === 'stale') {
    return 'idle';
  }
  return null;
}

function hookDetail(detail: string | null, eventName: string | null): string | null {
  if (detail) {
    return `hook: ${detail}`;
  }
  return eventName ? `hook: ${eventName}` : null;
}

function detailText(source: string, state: AgentState): string {
  switch (state) {
    case 'waitingApproval':
      return `${source}: needs input`;
    case 'running':
      return `${source}: running`;
    case 'idle':
      return `${source}: idle`;
    case 'stale':
      return `${source}: stale`;
    case 'unknown':
      return `${source}: unknown`;
  }
}

function displayAgentKind(kind: AgentKind): string {
  return kind === 'claude' ? 'Claude Code' : 'Codex';
}

function compactStatus(status: string): string {
  return status.toLowerCase().replace(/[^a-z0-9]/g, '');
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

function nilIfEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed || null;
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

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function dateFromNanoseconds(value: string | undefined): number | null {
  const raw = bigIntValue(value);
  if (raw <= 0n) {
    return null;
  }
  return Number(raw / 1_000_000n);
}

function dateFromMilliseconds(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || value <= 0) {
    return null;
  }
  return value;
}

function numberValue(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bigIntValue(value: string | undefined): bigint {
  if (!value) {
    return 0n;
  }
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function maxBigInt(...values: bigint[]): bigint {
  return values.reduce((max, value) => value > max ? value : max, 0n);
}

function newestTime(...values: Array<number | null>): number | null {
  const valid = values.filter((value): value is number => value !== null);
  return valid.length > 0 ? Math.max(...valid) : null;
}
