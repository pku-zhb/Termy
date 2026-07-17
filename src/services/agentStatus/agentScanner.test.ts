import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentScanner } from './agentScanner.ts';
import type { AgentCommandOptions, AgentCommandResult, AgentStatusRuntime } from './runtime.ts';

class FakeRuntime implements AgentStatusRuntime {
  platform: NodeJS.Platform = 'darwin';
  homeDir = '/Users/example';
  commandResults = new Map<string, AgentCommandResult | null>();
  tmuxPanesResult: AgentCommandResult | null = null;
  tmuxClientsResult: AgentCommandResult | null = null;
  readonly calls: string[] = [];

  async runCommand(
    executable: string,
    args: string[],
    _options?: AgentCommandOptions,
  ): Promise<AgentCommandResult | null> {
    this.calls.push(`${executable} ${args.join(' ')}`);
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

  async fileExists(_path: string): Promise<boolean> { return false; }
  async readTextFile(_path: string): Promise<string | null> { return null; }
  async readDir(_path: string): Promise<string[] | null> { return null; }
}

test('AgentScanner detects Claude and Codex processes and maps tmux surfaces', async () => {
  const runtime = new FakeRuntime();
  runtime.commandResults.set('/bin/ps -axo pid,ppid,pgid,stat,tty,comm,args', ok([
    '  PID  PPID  PGID STAT TTY      COMM             ARGS',
    '  101     1   101 S+   ttys001  /opt/homebrew/bin/codex codex',
    '  201     1   201 S+   ttys002  /opt/homebrew/bin/claude claude',
  ].join('\n')));
  runtime.tmuxPanesResult = ok([
    'research|100|/dev/ttys001',
    'review|200|/dev/ttys002',
  ].join('\n'));
  runtime.tmuxClientsResult = ok('777|/dev/ttys010|research\n');

  const snapshot = await new AgentScanner(runtime, { now: () => 1_700_000_010_000 }).scan();

  assert.equal(snapshot.generatedAtMs, 1_700_000_010_000);
  assert.deepEqual(snapshot.clients, [
    {
      id: 'claude-201',
      kind: 'claude',
      pid: 201,
      parentPid: 1,
      processGroupId: 201,
      surfaceId: 'tmux:review',
      tty: 'ttys002',
    },
    {
      id: 'codex-101',
      kind: 'codex',
      pid: 101,
      parentPid: 1,
      processGroupId: 101,
      surfaceId: 'tmux:research',
      tty: 'ttys001',
    },
  ]);
  assert.deepEqual(snapshot.tmuxClients, [{
    pid: 777,
    tty: '/dev/ttys010',
    sessionName: 'research',
    surfaceId: 'tmux:research',
  }]);
});

test('AgentScanner ignores Codex exec, Claude print mode, and stopped processes', async () => {
  const runtime = new FakeRuntime();
  runtime.commandResults.set('/bin/ps -axo pid,ppid,pgid,stat,tty,comm,args', ok([
    '  PID  PPID  PGID STAT TTY      COMM             ARGS',
    '  301     1   301 S+   ttys003  /opt/homebrew/bin/codex codex exec -- echo hi',
    '  401     1   401 S+   ttys004  /opt/homebrew/bin/claude claude --print hi',
    '  501     1   501 T    ttys005  /opt/homebrew/bin/claude claude',
    '  601     1   601 S+   ttys006  /opt/homebrew/bin/codex codex resume',
  ].join('\n')));

  const snapshot = await new AgentScanner(runtime).scan();

  assert.deepEqual(snapshot.clients.map((client) => client.id), ['codex-601']);
});

test('AgentScanner performs process discovery without reading agent state or sqlite databases', async () => {
  const runtime = new FakeRuntime();
  runtime.commandResults.set('/bin/ps -axo pid,ppid,pgid,stat,tty,comm,args', ok([
    '  PID  PPID  PGID STAT TTY      COMM             ARGS',
    '  101     1   101 S+   ttys001  /opt/homebrew/bin/codex codex',
  ].join('\n')));

  await new AgentScanner(runtime).scan();

  assert.equal(runtime.calls.some((call) => call.includes('sqlite3')), false);
  assert.equal(runtime.calls.some((call) => call.includes('agent-status/state.json')), false);
});

function ok(stdout: string): AgentCommandResult {
  return { exitCode: 0, stderr: '', stdout };
}
