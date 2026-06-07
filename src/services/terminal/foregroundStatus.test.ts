import * as assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyCommandText,
  classifyForeground,
} from './foregroundStatus.ts';

test('classifyForeground detects local foreground processes only', () => {
  assert.equal(classifyForeground({ name: 'tmux', cmdline: 'tmux attach' }), 'tmux');
  assert.equal(classifyForeground({ name: 'ssh', cmdline: 'ssh example.com' }), 'ssh');
  assert.equal(classifyForeground({ name: 'claude', cmdline: 'claude' }), 'claude');
  assert.equal(classifyForeground({ name: 'codex', cmdline: 'codex resume' }), 'codex');
  assert.equal(classifyForeground({ name: 'zsh', cmdline: '-zsh' }), 'none');
});

test('classifyCommandText detects Node-based local AI CLIs', () => {
  assert.equal(classifyCommandText('node', 'node /usr/local/bin/claude'), 'claude');
  assert.equal(classifyCommandText('node', 'node /usr/local/bin/codex resume'), 'codex');
});

test('classifyCommandText keeps filenames from causing AI status', () => {
  assert.equal(classifyCommandText('vim', 'vim claude.md'), 'none');
  assert.equal(classifyCommandText('vim', 'vim codex.md'), 'none');
});
