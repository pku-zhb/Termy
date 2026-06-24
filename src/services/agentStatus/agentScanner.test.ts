import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentScanner, resolveCodexState } from './agentScanner.ts';
import type { AgentCommandOptions, AgentCommandResult, AgentStatusRuntime } from './runtime.ts';

class FakeRuntime implements AgentStatusRuntime {
  platform: NodeJS.Platform = 'darwin';
  homeDir = '/Users/example';
  files = new Map<string, string>();
  dirs = new Map<string, string[]>();
  commandResults = new Map<string, AgentCommandResult | null>();
  tmuxPanesResult: AgentCommandResult | null = null;
  tmuxClientsResult: AgentCommandResult | null = null;

  async runCommand(
    executable: string,
    args: string[],
    _options?: AgentCommandOptions,
  ): Promise<AgentCommandResult | null> {
    if (executable === '/bin/sh' && args[0] === '-lc') {
      const command = args[1] ?? '';
      if (command.includes('list-panes')) {
        return this.tmuxPanesResult;
      }
      if (command.includes('list-clients')) {
        return this.tmuxClientsResult;
      }
    }
    return this.commandResults.get(`${executable} ${args.join(' ')}`) ?? null;
  }

  async fileExists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async readTextFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async readDir(path: string): Promise<string[] | null> {
    return this.dirs.get(path) ?? null;
  }
}

test('AgentScanner detects global Claude and Codex TTY sessions', async () => {
  const runtime = new FakeRuntime();
  runtime.commandResults.set('/bin/ps -axo pid,ppid,pgid,stat,tty,comm,args', {
    exitCode: 0,
    stderr: '',
    stdout: [
      '  PID  PPID  PGID STAT TTY      COMM             ARGS',
      '  101     1   101 S+   ttys001  /opt/homebrew/bin/codex codex',
      '  120   101   101 S    ??       /bin/sh          sh -c git status',
      '  201     1   201 S+   ttys002  /opt/homebrew/bin/claude claude',
      '  301     1   301 S+   ttys003  /opt/homebrew/bin/codex codex exec -- echo hi',
      '  401     1   401 T    ttys004  /opt/homebrew/bin/claude claude',
    ].join('\n'),
  });
  runtime.tmuxPanesResult = {
    exitCode: 0,
    stderr: '',
    stdout: [
      'research|100|/dev/ttys001',
      'review|200|/dev/ttys002',
    ].join('\n'),
  };
  runtime.tmuxClientsResult = {
    exitCode: 0,
    stderr: '',
    stdout: '777|/dev/ttys010|research\n',
  };
  runtime.dirs.set('/Users/example/.claude/sessions', ['201.json']);
  runtime.files.set('/Users/example/.claude/sessions/201.json', JSON.stringify({
    pid: 201,
    cwd: '/Users/example/projects/demo',
    status: 'waiting',
    updatedAt: 1_700_000_000_000,
    name: 'Claude Review',
  }));

  const snapshot = await new AgentScanner(runtime, { now: () => 1_700_000_010_000 }).scan();

  assert.equal(snapshot.summary.total, 2);
  assert.equal(snapshot.summary.codex, 1);
  assert.equal(snapshot.summary.claude, 1);
  assert.equal(snapshot.summary.running, 1);
  assert.equal(snapshot.summary.waitingApproval, 1);
  assert.deepEqual(snapshot.clients.map((client) => client.id).sort(), ['claude-201', 'codex-101']);
  assert.equal(snapshot.clients.find((client) => client.id === 'claude-201')?.title, 'Claude Review');
  assert.equal(snapshot.clients.find((client) => client.id === 'codex-101')?.state, 'running');
  assert.equal(snapshot.clients.find((client) => client.id === 'codex-101')?.surfaceId, 'tmux:research');
  assert.equal(snapshot.clients.find((client) => client.id === 'claude-201')?.surfaceId, 'tmux:review');
  assert.deepEqual(snapshot.tmuxClients, [{
    pid: 777,
    tty: '/dev/ttys010',
    sessionName: 'research',
    surfaceId: 'tmux:research',
  }]);
});

test('AgentScanner ignores persistent Codex app companion children', async () => {
  const runtime = new FakeRuntime();
  runtime.commandResults.set('/bin/ps -axo pid,ppid,pgid,stat,tty,comm,args', {
    exitCode: 0,
    stderr: '',
    stdout: [
      '  PID  PPID  PGID STAT TTY      COMM             ARGS',
      '  501     1   501 S+   ttys009  /opt/homebrew/bin/codex codex resume',
      '  601   501   601 S    ttys009  /Applications/Co /Applications/Codex.app/Contents/Resources/node_repl',
      '  602   601   601 S    ttys009  /Applications/Co /Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://',
    ].join('\n'),
  });

  const snapshot = await new AgentScanner(runtime, { now: () => 1_700_000_010_000 }).scan();

  assert.equal(snapshot.summary.total, 1);
  assert.equal(snapshot.summary.running, 0);
  assert.equal(snapshot.summary.idle, 1);
  assert.equal(snapshot.clients.find((client) => client.id === 'codex-501')?.state, 'idle');
});

test('AgentScanner trusts fresh Claude hook running state over stale session freshness', async () => {
  const runtime = new FakeRuntime();
  const now = 1_700_000_010_000;
  runtime.commandResults.set('/bin/ps -axo pid,ppid,pgid,stat,tty,comm,args', {
    exitCode: 0,
    stderr: '',
    stdout: [
      '  PID  PPID  PGID STAT TTY      COMM             ARGS',
      '  201     1   201 S+   ttys002  /opt/homebrew/bin/claude claude',
    ].join('\n'),
  });
  runtime.dirs.set('/Users/example/.claude/sessions', ['201.json']);
  runtime.files.set('/Users/example/.claude/sessions/201.json', JSON.stringify({
    pid: 201,
    sessionId: 'claude-session-201',
    cwd: '/Users/example/projects/demo',
    status: 'thinking',
    updatedAt: now - 10 * 60 * 1000,
  }));
  runtime.files.set('/Users/example/.termy/agent-status/state.json', JSON.stringify({
    sessions: {
      'claude:claude-session-201': {
        agent: 'claude',
        sessionId: 'claude-session-201',
        pid: 201,
        cwd: '/Users/example/projects/demo',
        state: 'running',
        eventName: 'UserPromptSubmit',
        updatedAtMs: now - 1000,
      },
    },
  }));

  const snapshot = await new AgentScanner(runtime, { now: () => now }).scan();

  assert.equal(snapshot.summary.running, 1);
  const client = snapshot.clients.find((candidate) => candidate.id === 'claude-201');
  assert.equal(client?.state, 'running');
  assert.equal(client?.detail, 'hook: UserPromptSubmit');
  assert.equal(client?.agentSessionId, 'claude-session-201');
});

test('AgentScanner keeps explicit idle Claude sessions from stale running hooks', async () => {
  const runtime = new FakeRuntime();
  const now = 1_700_000_010_000;
  runtime.commandResults.set('/bin/ps -axo pid,ppid,pgid,stat,tty,comm,args', {
    exitCode: 0,
    stderr: '',
    stdout: [
      '  PID  PPID  PGID STAT TTY      COMM             ARGS',
      '  201     1   201 S+   ttys002  /opt/homebrew/bin/claude claude',
    ].join('\n'),
  });
  runtime.dirs.set('/Users/example/.claude/sessions', ['201.json']);
  runtime.files.set('/Users/example/.claude/sessions/201.json', JSON.stringify({
    pid: 201,
    sessionId: 'claude-session-201',
    cwd: '/Users/example/projects/demo',
    status: 'idle',
    updatedAt: now - 1000,
  }));
  runtime.files.set('/Users/example/.termy/agent-status/state.json', JSON.stringify({
    sessions: {
      'claude:claude-session-201': {
        agent: 'claude',
        sessionId: 'claude-session-201',
        pid: 201,
        cwd: '/Users/example/projects/demo',
        state: 'running',
        eventName: 'SessionStart',
        updatedAtMs: now - 500,
      },
    },
  }));

  const snapshot = await new AgentScanner(runtime, { now: () => now }).scan();

  assert.equal(snapshot.summary.running, 0);
  assert.equal(snapshot.summary.idle, 1);
  const client = snapshot.clients.find((candidate) => candidate.id === 'claude-201');
  assert.equal(client?.state, 'idle');
  assert.equal(client?.detail, 'claude session: idle');
});

test('AgentScanner trusts fresh Codex hook waiting state without sqlite log scans', async () => {
  const runtime = new FakeRuntime();
  const now = 1_700_000_010_000;
  runtime.commandResults.set('/bin/ps -axo pid,ppid,pgid,stat,tty,comm,args', {
    exitCode: 0,
    stderr: '',
    stdout: [
      '  PID  PPID  PGID STAT TTY      COMM             ARGS',
      '  501     1   501 S+   ttys009  /opt/homebrew/bin/codex codex resume',
    ].join('\n'),
  });
  runtime.files.set('/Users/example/.termy/agent-status/state.json', JSON.stringify({
    sessions: {
      'codex:501': {
        agent: 'codex',
        sessionId: 'codex-session-501',
        pid: 501,
        cwd: '/Users/example/lab/termy',
        state: 'waitingApproval',
        detail: 'PermissionRequest',
        updatedAtMs: now - 1000,
        waitingSinceMs: now - 1000,
      },
    },
  }));

  const snapshot = await new AgentScanner(runtime, { now: () => now }).scan();

  assert.equal(snapshot.summary.waitingApproval, 1);
  const client = snapshot.clients.find((candidate) => candidate.id === 'codex-501');
  assert.equal(client?.state, 'waitingApproval');
  assert.equal(client?.cwd, '/Users/example/lab/termy');
  assert.equal(client?.detail, 'hook: PermissionRequest');
  assert.equal(client?.agentSessionId, 'codex-session-501');
});

test('resolveCodexState keeps attention and active states above idle fallbacks', () => {
  const base = {
    approvalPending: false,
    questionPending: false,
    hasActiveToolChild: false,
    toolCallPending: false,
    strictTurnRunning: false,
    strictTurnFinished: false,
    turnStart: 0n,
    turnEnd: 0n,
    hasRecentTurnActivity: false,
    hasLastSeen: true,
  };

  assert.equal(resolveCodexState({ ...base, approvalPending: true }), 'waitingApproval');
  assert.equal(resolveCodexState({ ...base, questionPending: true }), 'waitingApproval');
  assert.equal(resolveCodexState({ ...base, hasActiveToolChild: true }), 'running');
  assert.equal(resolveCodexState({ ...base, toolCallPending: true }), 'running');
  assert.equal(resolveCodexState({ ...base, strictTurnRunning: true }), 'running');
  assert.equal(resolveCodexState({ ...base, strictTurnFinished: true }), 'idle');
  assert.equal(resolveCodexState({ ...base, turnStart: 10n, turnEnd: 9n }), 'running');
  assert.equal(resolveCodexState({ ...base, hasRecentTurnActivity: true }), 'running');
  assert.equal(resolveCodexState({ ...base, hasLastSeen: false }), 'unknown');
});
