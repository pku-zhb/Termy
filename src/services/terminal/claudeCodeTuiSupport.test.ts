import { Buffer } from 'buffer';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClaudeCodeTuiEnv,
  decodeOsc52Clipboard,
  decodeTmuxPassthroughOsc52Clipboard,
  encodeClaudeCodeExtendedKey,
  formatOscColorResponse,
  XTERM_JS_VERSION,
  XTVERSION_RESPONSE,
} from './claudeCodeTuiSupport.ts';

test('buildClaudeCodeTuiEnv declares terminal capabilities without IDE identity', () => {
  const env = buildClaudeCodeTuiEnv({}, {}, 'darwin');

  assert.equal(env.TERM, 'mlterm-256color');
  assert.equal(env.KITTY_WINDOW_ID, '1');
  assert.equal('TERM_PROGRAM' in env, false);
  assert.equal('TERM_PROGRAM_VERSION' in env, false);
  assert.equal(env.COLORTERM, 'truecolor');
  assert.equal(env.FORCE_HYPERLINK, '1');
  assert.equal('LC_TERMINAL' in env, false);
});

test('buildClaudeCodeTuiEnv keeps the portable xterm identity outside macOS', () => {
  const env = buildClaudeCodeTuiEnv({}, {}, 'linux');

  assert.equal(env.TERM, 'xterm-256color');
});

test('buildClaudeCodeTuiEnv preserves user overrides', () => {
  const env = buildClaudeCodeTuiEnv(
    {
      COLORTERM: '24bit',
      FORCE_HYPERLINK: '0',
    },
    {
      TERM: 'screen-256color',
      TERM_PROGRAM: 'custom-terminal',
      COLORTERM: 'ansi',
      KITTY_WINDOW_ID: 'custom-window',
    },
  );

  assert.equal(env.TERM, 'screen-256color');
  assert.equal(env.TERM_PROGRAM, 'custom-terminal');
  assert.equal(env.COLORTERM, 'ansi');
  assert.equal(env.KITTY_WINDOW_ID, 'custom-window');
  assert.equal(env.FORCE_HYPERLINK, '0');
});

test('buildClaudeCodeTuiEnv clears inherited no-color mode', () => {
  const env = buildClaudeCodeTuiEnv(
    {
      NO_COLOR: '1',
    },
    {
      NO_COLOR: '1',
    },
  );

  assert.equal('NO_COLOR' in env, false);
});

test('decodeOsc52Clipboard decodes clipboard selection payloads', () => {
  const text = 'hello Claude 世界';
  const payload = Buffer.from(text, 'utf8').toString('base64');

  assert.equal(decodeOsc52Clipboard(`c;${payload}`), text);
  assert.equal(decodeOsc52Clipboard(`;${payload}`), text);
});

test('decodeOsc52Clipboard ignores unsupported selections and queries', () => {
  const payload = Buffer.from('primary selection', 'utf8').toString('base64');

  assert.equal(decodeOsc52Clipboard(`p;${payload}`), null);
  assert.equal(decodeOsc52Clipboard('c;?'), null);
  assert.equal(decodeOsc52Clipboard('c;not valid base64!'), null);
});

test('decodeTmuxPassthroughOsc52Clipboard unwraps tmux DCS passthrough', () => {
  const text = 'copied from tmux';
  const payload = Buffer.from(text, 'utf8').toString('base64');
  const osc52 = `\x1b]52;c;${payload}\x07`;
  const tmuxDcsPayload = `mux;${osc52.replaceAll('\x1b', '\x1b\x1b')}`;

  assert.equal(decodeTmuxPassthroughOsc52Clipboard(tmuxDcsPayload), text);
});

test('formatOscColorResponse emits xterm default-color replies', () => {
  assert.equal(formatOscColorResponse(10, { r: 238, g: 127.4, b: -2 }), '\x1b]10;rgb:eeee/7f7f/0000\x1b\\');
  assert.equal(formatOscColorResponse(11, { r: 17, g: 255, b: 512 }), '\x1b]11;rgb:1111/ffff/ffff\x1b\\');
});

test('encodeClaudeCodeExtendedKey emits modifyOtherKeys sequences', () => {
  assert.equal(
    encodeClaudeCodeExtendedKey({
      type: 'keydown',
      key: 'C',
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
    }, 'modifyOtherKeys'),
    '\x1b[27;6;67~',
  );
});

test('XTVERSION_RESPONSE reports xterm.js to Claude Code', () => {
  assert.equal(XTVERSION_RESPONSE, `\x1bP>|xterm.js(${XTERM_JS_VERSION})\x1b\\`);
});
