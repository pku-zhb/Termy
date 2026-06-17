import * as assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyCommandText,
  classifyForeground,
} from './foregroundStatus.ts';

test('classifyForeground detects local foreground processes only', () => {
  assert.equal(classifyForeground({ name: 'tmux', cmdline: 'tmux attach', pid: null }), 'tmux');
  assert.equal(classifyForeground({ name: 'ssh', cmdline: 'ssh example.com', pid: null }), 'ssh');
  assert.equal(classifyForeground({ name: 'claude', cmdline: 'claude', pid: null }), 'claude');
  assert.equal(classifyForeground({ name: 'codex', cmdline: 'codex resume', pid: null }), 'codex');
  assert.equal(classifyForeground({ name: 'zsh', cmdline: '-zsh', pid: null }), 'none');
});

test('classifyCommandText detects Node-wrapped local AI CLIs via cmdline', () => {
  // codex 是 codex.js、用 node 启动：argv[0]=node，但命令行含 codex → 靠 context 区分。
  assert.equal(classifyCommandText('node', 'node /usr/local/bin/claude'), 'claude');
  assert.equal(classifyCommandText('node', 'node /usr/local/lib/node_modules/@openai/codex/bin/codex.js resume'), 'codex');
});

test('classifyCommandText matches native CLIs by basename', () => {
  assert.equal(classifyCommandText('/usr/local/bin/claude', 'claude'), 'claude');
  assert.equal(classifyCommandText('/opt/homebrew/bin/tmux', 'tmux attach'), 'tmux');
});

test('classifyCommandText keeps filenames from causing AI status', () => {
  // vim 打开 claude.md：argv[0]=vim（非 node/claude），即便命令行含 claude 也不误判。
  assert.equal(classifyCommandText('vim', 'vim claude.md'), 'none');
  assert.equal(classifyCommandText('vim', 'vim codex.md'), 'none');
});
