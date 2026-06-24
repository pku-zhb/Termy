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
    title: 'Claude Code',
    updatedAtMs: 100,
  }], 0));
  await secondary.saveSnapshot(snapshot([{
    customName: null,
    cwd: '/Users/example/lab/other',
    agentKind: 'codex',
    title: 'Codex',
    updatedAtMs: 200,
  }], 0));

  assert.equal((await primary.loadSnapshot()).tabs[0]?.agentKind, 'claude');
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
    title: 'Claude',
    updatedAtMs: 100,
  }], 0));
  await secondary.saveSnapshot(snapshot([{
    customName: 'Codex',
    cwd: '/tmp/two',
    agentKind: 'codex',
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
  fs.writeFileSync(path.join(restoreDir, 'terminal-restore.json'), '{"vaults":[{"vaultPath":"/vault","activeIndex":99,"tabs":[{"agentKind":"bad"},{"agentKind":"codex","cwd":"/tmp","updatedAtMs":5}]}]}');

  const restored = await store(homeDir, '/vault').loadSnapshot();

  assert.equal(restored.activeIndex, 0);
  assert.equal(restored.tabs.length, 1);
  assert.equal(restored.tabs[0]?.agentKind, 'codex');
});

test('restored agent helpers detect and command Claude/Codex tabs', () => {
  assert.equal(hasRestorableAgentTabs(snapshot([], 0)), false);
  assert.equal(hasRestorableAgentTabs(snapshot([{
    customName: null,
    cwd: '/tmp',
    agentKind: 'claude',
    title: 'Claude',
    updatedAtMs: 100,
  }], 0)), true);
  assert.equal(restoredAgentCommand('claude'), 'claude --continue');
  assert.equal(restoredAgentCommand('codex'), 'codex resume --last');
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
