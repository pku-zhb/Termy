import * as assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyCommandText,
  classifyForeground,
  terminalStatusAgentKind,
} from './foregroundStatus.ts';

test('classifyForeground detects local foreground processes only', () => {
  assert.equal(classifyForeground({ name: 'tmux', cmdline: 'tmux attach', pid: null }), 'tmux');
  assert.equal(classifyForeground({ name: 'ssh', cmdline: 'ssh example.com', pid: null }), 'ssh');
  assert.equal(classifyForeground({ name: 'claude', cmdline: 'claude', pid: null }), 'claude');
  assert.equal(classifyForeground({ name: 'codex', cmdline: 'codex resume', pid: null }), 'codex');
  assert.equal(classifyForeground({ name: 'zsh', cmdline: '-zsh', pid: null }), 'none');
});

test('classifyCommandText detects Node-wrapped local AI CLIs by script token', () => {
  assert.equal(classifyCommandText('node', 'node /usr/local/bin/claude'), 'claude');
  assert.equal(
    classifyCommandText('node', 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'),
    'claude',
  );
  assert.equal(
    classifyCommandText('node', 'node /usr/local/lib/node_modules/@openai/codex/bin/codex.js resume'),
    'codex',
  );
});

test('classifyCommandText distinguishes claudex and claude3 wrappers', () => {
  assert.equal(classifyCommandText('claudex', 'claudex'), 'claudex');
  assert.equal(classifyCommandText('/Users/example/.local/bin/claudex', 'claudex --resume'), 'claudex');
  assert.equal(classifyCommandText('claude3', 'claude3'), 'claude3');
  assert.equal(classifyCommandText('/Users/example/.local/bin/claude3', 'claude3 --resume'), 'claude3');
});

test('classifyCommandText detects Python-launched wrapper symlinks', () => {
  assert.equal(
    classifyCommandText('python3', 'python3 /Users/example/.local/bin/claudex'),
    'claudex',
  );
  assert.equal(
    classifyCommandText('python3.13', 'python3.13 /Users/example/.local/bin/claude3 --resume'),
    'claude3',
  );
});

test('classifyCommandText matches native CLIs by basename', () => {
  assert.equal(classifyCommandText('/usr/local/bin/claude', 'claude'), 'claude');
  assert.equal(classifyCommandText('/opt/homebrew/bin/tmux', 'tmux attach'), 'tmux');
});

test('classifyCommandText keeps filenames and ordinary arguments from causing AI status', () => {
  assert.equal(classifyCommandText('vim', 'vim claude.md'), 'none');
  assert.equal(classifyCommandText('vim', 'vim claude3.md'), 'none');
  assert.equal(classifyCommandText('vim', 'vim claudex.md'), 'none');
  assert.equal(classifyCommandText('python3', 'python3 unrelated.py --name claudex'), 'none');
  assert.equal(classifyCommandText('node', 'node unrelated.js --label claude3'), 'none');
  assert.equal(classifyCommandText('node', 'node unrelated.js --label claude'), 'none');
});

test('terminalStatusAgentKind keeps wrapper visuals on the Claude agent path', () => {
  assert.equal(terminalStatusAgentKind('claude'), 'claude');
  assert.equal(terminalStatusAgentKind('claudex'), 'claude');
  assert.equal(terminalStatusAgentKind('claude3'), 'claude');
  assert.equal(terminalStatusAgentKind('codex'), 'codex');
  assert.equal(terminalStatusAgentKind('tmux'), null);
});
