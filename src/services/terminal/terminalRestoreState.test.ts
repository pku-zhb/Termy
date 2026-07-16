import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  TerminalRestoreStore,
  hasRestorableAgentTabs,
  restoredAgentCommand,
  type TerminalRestoreSnapshot,
} from './terminalRestoreState.ts';

test('TerminalRestoreStore saves and loads tabs per local vault', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termy-restore-'));
  const primary = store(homeDir, '/vault/one');
  const secondary = store(homeDir, '/vault/two');

  await primary.saveSnapshot(snapshot([{
    customName: 'Agent',
    cwd: '/Users/example/lab/termy',
    agentKind: 'claude',
    agentLauncher: 'claudex',
    agentSessionId: 'claude-session-one',
    title: 'Claude Code',
    updatedAtMs: 100,
  }], 0));
  await secondary.saveSnapshot(snapshot([{
    customName: null,
    cwd: '/Users/example/lab/other',
    agentKind: 'codex',
    agentLauncher: null,
    agentSessionId: 'codex-session-two',
    title: 'Codex',
    updatedAtMs: 200,
  }], 0));

  const restoredClaude = (await primary.loadSnapshot()).tabs[0];
  assert.equal(restoredClaude?.agentKind, 'claude');
  assert.equal(restoredClaude?.agentLauncher, 'claudex');
  assert.equal(restoredClaude?.agentSessionId, null);
  assert.equal((await secondary.loadSnapshot()).tabs[0]?.agentKind, 'codex');
});

test('TerminalRestoreStore clears only the current vault snapshot', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termy-restore-'));
  const primary = store(homeDir, '/vault/one');
  const secondary = store(homeDir, '/vault/two');

  await primary.saveSnapshot(snapshot([{
    customName: 'Claude',
    cwd: '/tmp/one',
    agentKind: 'claude',
    agentLauncher: 'claude3',
    agentSessionId: 'claude-session-one',
    title: 'Claude',
    updatedAtMs: 100,
  }], 0));
  await secondary.saveSnapshot(snapshot([{
    customName: 'Codex',
    cwd: '/tmp/two',
    agentKind: 'codex',
    agentLauncher: null,
    agentSessionId: 'codex-session-two',
    title: 'Codex',
    updatedAtMs: 100,
  }], 0));

  await primary.clearSnapshot();

  assert.equal((await primary.loadSnapshot()).tabs.length, 0);
  assert.equal((await secondary.loadSnapshot()).tabs[0]?.agentKind, 'codex');
});

test('TerminalRestoreStore normalizes malformed files', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termy-restore-'));
  const restoreDir = path.join(homeDir, '.termy');
  fs.mkdirSync(restoreDir, { recursive: true });
  fs.writeFileSync(path.join(restoreDir, 'terminal-restore.json'), '{"vaults":[{"vaultPath":"/vault","activeIndex":99,"tabs":[{"agentKind":"bad"},{"agentKind":"codex","agentSessionId":"codex-session","cwd":"/tmp","updatedAtMs":5}]}]}');

  const restored = await store(homeDir, '/vault').loadSnapshot();

  assert.equal(restored.activeIndex, 0);
  assert.equal(restored.tabs.length, 1);
  assert.equal(restored.tabs[0]?.agentKind, 'codex');
});

test('TerminalRestoreStore upgrades legacy Claude snapshots to agents mode', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termy-restore-'));
  const restoreDir = path.join(homeDir, '.termy');
  fs.mkdirSync(restoreDir, { recursive: true });
  fs.writeFileSync(
    path.join(restoreDir, 'terminal-restore.json'),
    JSON.stringify({
      vaults: [{
        vaultPath: '/vault',
        activeIndex: 0,
        tabs: [{
          agentKind: 'claude',
          agentSessionId: 'legacy-session',
          cwd: '/tmp',
          updatedAtMs: 5,
        }],
      }],
    }),
  );

  const restored = await store(homeDir, '/vault').loadSnapshot();

  assert.equal(restored.tabs[0]?.agentLauncher, 'claude');
  assert.equal(restored.tabs[0]?.agentSessionId, null);
  assert.equal(hasRestorableAgentTabs(restored), true);
});

test('restored agent helpers open Claude launchers in agents mode and keep Codex session resume', () => {
  assert.equal(hasRestorableAgentTabs(snapshot([], 0)), false);
  assert.equal(hasRestorableAgentTabs(snapshot([{
    customName: null,
    cwd: '/tmp',
    agentKind: 'claude',
    agentLauncher: 'claude',
    agentSessionId: null,
    title: 'Claude',
    updatedAtMs: 100,
  }], 0)), true);
  assert.equal(restoredAgentCommand('claude', 'claude', null), 'claude agents');
  assert.equal(restoredAgentCommand('claude', 'claudex', 'ignored-session'), 'claudex agents');
  assert.equal(restoredAgentCommand('claude', 'claude3', null), 'claude3 agents');
  assert.equal(restoredAgentCommand('claude', null, null), 'claude agents');
  assert.equal(restoredAgentCommand('codex', null, 'codex-session'), 'codex resume codex-session');
  assert.equal(
    restoredAgentCommand('codex', null, 'codex-session', '/Users/example/My Project'),
    "codex resume --cd '/Users/example/My Project' codex-session",
  );
  assert.equal(restoredAgentCommand('codex', null, null), null);
});

function store(homeDir: string, vaultPath: string): TerminalRestoreStore {
  return new TerminalRestoreStore({
    fs,
    path,
    homeDir,
    hostName: 'test-host',
    vaultPath,
    now: () => 1_700_000_000_000,
  });
}

function snapshot(
  tabs: TerminalRestoreSnapshot['tabs'],
  activeIndex: number,
): TerminalRestoreSnapshot {
  return {
    tabs,
    activeIndex,
    updatedAtMs: 1_700_000_000_000,
  };
}
