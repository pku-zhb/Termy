import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  TerminalRestoreStore,
  hasRestorableAgentTabs,
  parseClaude3RuntimeSelection,
  restoredAgentCommand,
  type TerminalRestoreSnapshot,
} from './terminalRestoreState.ts';

test('TerminalRestoreStore saves per-tab Claude3 model selections per local vault', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termy-restore-'));
  const primary = store(homeDir, '/vault/one');
  const secondary = store(homeDir, '/vault/two');

  await primary.saveSnapshot(snapshot([
    tab('claude', 'claude3', '/Users/example/lab/termy', 'claude-fable-5', 'packy2'),
    tab('claude', 'claude3', '/Users/example/research', 'moonshotai/kimi-k2', 'kimi-xinyi'),
  ], 0));
  await secondary.saveSnapshot(snapshot([tab('codeck', null, '/Users/example/lab/codeck')], 0));

  assert.deepEqual((await primary.loadSnapshot()).tabs, [
    tab('claude', 'claude3', '/Users/example/lab/termy', 'claude-fable-5', 'packy2'),
    tab('claude', 'claude3', '/Users/example/research', 'moonshotai/kimi-k2', 'kimi-xinyi'),
  ]);
  assert.deepEqual((await secondary.loadSnapshot()).tabs[0], tab('codeck', null, '/Users/example/lab/codeck'));
});

test('TerminalRestoreStore clears only the current vault snapshot', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termy-restore-'));
  const primary = store(homeDir, '/vault/one');
  const secondary = store(homeDir, '/vault/two');

  await primary.saveSnapshot(snapshot([tab('claude', 'claude', '/tmp/one')], 0));
  await secondary.saveSnapshot(snapshot([tab('codeck', null, '/tmp/two')], 0));
  await primary.clearSnapshot();

  assert.equal((await primary.loadSnapshot()).tabs.length, 0);
  assert.equal((await secondary.loadSnapshot()).tabs[0]?.agentKind, 'codeck');
});

test('TerminalRestoreStore drops legacy claudex and Codex resume metadata', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termy-restore-'));
  const restoreDir = path.join(homeDir, '.termy');
  fs.mkdirSync(restoreDir, { recursive: true });
  fs.writeFileSync(path.join(restoreDir, 'terminal-restore.json'), JSON.stringify({
    vaults: [{
      vaultPath: '/vault',
      activeIndex: 0,
      tabs: [
        { agentKind: 'claude', agentLauncher: 'claudex', cwd: '/tmp/x', updatedAtMs: 1 },
        { agentKind: 'codex', agentSessionId: 'legacy-session', cwd: '/tmp/codex', updatedAtMs: 2 },
        { agentKind: 'claude', cwd: '/tmp/claude', updatedAtMs: 3 },
      ],
    }],
  }));

  const restored = await store(homeDir, '/vault').loadSnapshot();

  assert.deepEqual(restored.tabs.map((entry) => [entry.agentKind, entry.agentLauncher]), [
    [null, null],
    [null, null],
    ['claude', 'claude'],
  ]);
});

test('restored agent helpers only open Claude agents, c3 agents, and Codeck', () => {
  assert.equal(hasRestorableAgentTabs(snapshot([], 0)), false);
  assert.equal(hasRestorableAgentTabs(snapshot([tab('claude', 'claude', '/tmp')], 0)), true);
  assert.equal(hasRestorableAgentTabs(snapshot([tab('codeck', null, '/tmp')], 0)), true);
  assert.equal(restoredAgentCommand('claude', 'claude'), 'claude agents');
  assert.equal(restoredAgentCommand('claude', 'claude3'), 'c3 agents');
  assert.equal(
    restoredAgentCommand('claude', 'claude3', 'claude-fable-5', 'packy2'),
    'c3 --model claude-fable-5 --provider packy2 agents',
  );
  assert.equal(
    restoredAgentCommand('claude', 'claude3', "model's beta", 'provider two'),
    `c3 --model 'model'"'"'s beta' --provider 'provider two' agents`,
  );
  assert.equal(restoredAgentCommand('claude', null), 'claude agents');
  assert.equal(restoredAgentCommand('codeck', null), 'codeck');
});

test('parseClaude3RuntimeSelection accepts only the matching child PID and safe arguments', () => {
  assert.deepEqual(
    parseClaude3RuntimeSelection({
      pid: 123,
      model: 'claude-fable-5',
      provider: 'packy2',
      updatedAtMs: 1_700_000_000_000,
    }, 123),
    {
      pid: 123,
      model: 'claude-fable-5',
      provider: 'packy2',
      updatedAtMs: 1_700_000_000_000,
    },
  );
  assert.equal(parseClaude3RuntimeSelection({ pid: 456, model: 'a', provider: 'b' }, 123), null);
  assert.equal(parseClaude3RuntimeSelection({ pid: 123, model: 'bad\nmodel', provider: 'b' }, 123), null);
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

function tab(
  agentKind: 'claude' | 'codeck' | null,
  agentLauncher: 'claude' | 'claude3' | null,
  cwd: string,
  agentModel: string | null = null,
  agentProvider: string | null = null,
): TerminalRestoreSnapshot['tabs'][number] {
  return {
    customName: null,
    cwd,
    agentKind,
    agentLauncher,
    agentModel,
    agentProvider,
    title: null,
    updatedAtMs: 1_700_000_000_000,
  };
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
