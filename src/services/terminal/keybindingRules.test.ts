import * as assert from 'node:assert/strict';
import test from 'node:test';

import {
  matchKeybinding,
  parseKeybindingWhen,
  parseKeybindingConfigJson,
  compileKeybindingConfig,
  keyboardEventToWhen,
  DEFAULT_KEYBINDING_CONFIG_JSON,
  type KeybindingEventLike,
} from './keybindingRules.ts';

function keydown(partial: Partial<KeybindingEventLike>): KeybindingEventLike {
  return { type: 'keydown', ...partial };
}

test('Opt tab navigation routes to termy with physical key codes', () => {
  assert.deepEqual(matchKeybinding(keydown({ altKey: true, code: 'KeyT' })), { route: 'termy', action: 'tab-new' });
  assert.deepEqual(matchKeybinding(keydown({ altKey: true, code: 'KeyW' })), { route: 'termy', action: 'tab-close' });
  assert.deepEqual(matchKeybinding(keydown({ altKey: true, code: 'KeyR' })), { route: 'termy', action: 'tab-rename' });
  assert.deepEqual(matchKeybinding(keydown({ altKey: true, code: 'Tab' })), { route: 'termy', action: 'tab-next' });
  assert.deepEqual(matchKeybinding(keydown({ altKey: true, shiftKey: true, code: 'Tab' })), { route: 'termy', action: 'tab-prev' });
});

test('Opt+digit goes to that tab (0-based index)', () => {
  assert.deepEqual(matchKeybinding(keydown({ altKey: true, code: 'Digit1' })), { route: 'termy', action: 'tab-goto', tabIndex: 0 });
  assert.deepEqual(matchKeybinding(keydown({ altKey: true, code: 'Digit9' })), { route: 'termy', action: 'tab-goto', tabIndex: 8 });
});

test('Opt+0 resets font (not a tab jump)', () => {
  assert.deepEqual(matchKeybinding(keydown({ altKey: true, code: 'Digit0' })), { route: 'termy', action: 'font-reset' });
});

test('Opt search and font zoom route to termy', () => {
  assert.deepEqual(matchKeybinding(keydown({ altKey: true, code: 'KeyF' })), { route: 'termy', action: 'search-toggle' });
  assert.deepEqual(matchKeybinding(keydown({ altKey: true, code: 'Equal' })), { route: 'termy', action: 'font-increase' });
  assert.deepEqual(matchKeybinding(keydown({ altKey: true, code: 'Minus' })), { route: 'termy', action: 'font-decrease' });
});

test('Opt shortcuts do not fire when other modifiers are also held', () => {
  // 多修饰键组合不命中任何精确规则 → 返回 null（调用层按默认透传给程序）。
  // Cmd+Opt+T must not trigger Termy tab-new.
  assert.equal(matchKeybinding(keydown({ altKey: true, metaKey: true, code: 'KeyT' })), null);
  // Ctrl+Opt+F must not trigger search.
  assert.equal(matchKeybinding(keydown({ altKey: true, ctrlKey: true, code: 'KeyF' })), null);
});

test('Cmd+C / Cmd+V stay with Termy for copy/paste', () => {
  assert.deepEqual(matchKeybinding(keydown({ metaKey: true, code: 'KeyC' })), { route: 'termy', action: 'copy' });
  assert.deepEqual(matchKeybinding(keydown({ metaKey: true, code: 'KeyV' })), { route: 'termy', action: 'paste' });
});

test('all other Cmd combinations go back to Obsidian', () => {
  assert.deepEqual(matchKeybinding(keydown({ metaKey: true, code: 'KeyF' })), { route: 'obsidian', action: undefined });
  assert.deepEqual(matchKeybinding(keydown({ metaKey: true, code: 'KeyT' })), { route: 'obsidian', action: undefined });
  assert.deepEqual(matchKeybinding(keydown({ metaKey: true, code: 'KeyW' })), { route: 'obsidian', action: undefined });
  assert.deepEqual(matchKeybinding(keydown({ metaKey: true, shiftKey: true, code: 'KeyP' })), { route: 'obsidian', action: undefined });
  assert.deepEqual(matchKeybinding(keydown({ metaKey: true, code: 'Digit1' })), { route: 'obsidian', action: undefined });
});

test('Ctrl blacklist goes to Obsidian', () => {
  assert.deepEqual(matchKeybinding(keydown({ ctrlKey: true, code: 'KeyW' })), { route: 'obsidian', action: undefined });
  assert.deepEqual(matchKeybinding(keydown({ ctrlKey: true, code: 'KeyQ' })), { route: 'obsidian', action: undefined });
  assert.deepEqual(matchKeybinding(keydown({ ctrlKey: true, code: 'Digit1' })), { route: 'obsidian', action: undefined });
  assert.deepEqual(matchKeybinding(keydown({ ctrlKey: true, code: 'Digit5' })), { route: 'obsidian', action: undefined });
  assert.deepEqual(matchKeybinding(keydown({ ctrlKey: true, shiftKey: true, code: 'Digit3' })), { route: 'obsidian', action: undefined });
  assert.deepEqual(matchKeybinding(keydown({ ctrlKey: true, code: 'Tab' })), { route: 'obsidian', action: undefined });
  assert.deepEqual(matchKeybinding(keydown({ ctrlKey: true, shiftKey: true, code: 'Tab' })), { route: 'obsidian', action: undefined });
});

test('Ctrl+digit outside 1-5 is NOT blacklisted (passthrough to program)', () => {
  assert.deepEqual(matchKeybinding(keydown({ ctrlKey: true, code: 'Digit6' })), { route: 'terminal', action: undefined });
});

test('Ctrl line-editing keys pass through to the program', () => {
  // Ctrl+E (end of line), Ctrl+A, Ctrl+U, Ctrl+K, Ctrl+V (image paste) — all to terminal.
  for (const code of ['KeyE', 'KeyA', 'KeyU', 'KeyK', 'KeyV', 'KeyC', 'KeyR']) {
    assert.deepEqual(
      matchKeybinding(keydown({ ctrlKey: true, code })),
      { route: 'terminal', action: undefined },
      `Ctrl+${code} should pass through`,
    );
  }
});

test('Shift+Enter inserts a newline via Termy', () => {
  assert.deepEqual(matchKeybinding(keydown({ shiftKey: true, code: 'Enter' })), { route: 'termy', action: 'newline' });
});

test('plain keys and special keys have no rule (caller falls back to terminal)', () => {
  assert.equal(matchKeybinding(keydown({ code: 'KeyA' })), null);
  assert.equal(matchKeybinding(keydown({ code: 'Tab' })), null);
  assert.equal(matchKeybinding(keydown({ shiftKey: true, code: 'Tab' })), null); // bare Shift+Tab → program (mode switch)
  assert.equal(matchKeybinding(keydown({ code: 'Escape' })), null);
  assert.equal(matchKeybinding(keydown({ code: 'Enter' })), null);
});

test('non-keydown events are ignored', () => {
  assert.equal(matchKeybinding({ type: 'keyup', ctrlKey: true, code: 'KeyW' }), null);
  assert.equal(matchKeybinding({ type: 'keypress', code: 'KeyA' }), null);
});

// —— when DSL ——

test('parseKeybindingWhen handles modifiers, letters, digits and ranges', () => {
  assert.deepEqual(parseKeybindingWhen('Opt+T'), { mods: { alt: true, ctrl: false, cmd: false, shift: false }, codes: ['KeyT'] });
  assert.deepEqual(parseKeybindingWhen('Cmd+C'), { mods: { alt: false, ctrl: false, cmd: true, shift: false }, codes: ['KeyC'] });
  assert.deepEqual(parseKeybindingWhen('Ctrl+Shift+Tab'), { mods: { alt: false, ctrl: true, cmd: false, shift: true }, codes: ['Tab'] });
  assert.deepEqual(parseKeybindingWhen('Ctrl+1..5'), { mods: { alt: false, ctrl: true, cmd: false, shift: false }, codes: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'] });
  assert.deepEqual(parseKeybindingWhen('Opt+='), { mods: { alt: true, ctrl: false, cmd: false, shift: false }, codes: ['Equal'] });
});

test('parseKeybindingWhen wildcard locks main modifiers but not shift', () => {
  // Cmd+* should match Cmd+anything incl. Cmd+Shift, but not Ctrl/Alt.
  assert.deepEqual(parseKeybindingWhen('Cmd+*'), { mods: { alt: false, ctrl: false, cmd: true } });
  assert.deepEqual(parseKeybindingWhen('Ctrl+*'), { mods: { alt: false, ctrl: true, cmd: false } });
});

test('parseKeybindingWhen rejects unknown modifiers/keys', () => {
  assert.equal(parseKeybindingWhen('Hyper+T'), null);
  assert.equal(parseKeybindingWhen('Ctrl+F13'), null);
  assert.equal(parseKeybindingWhen(''), null);
});

test('default config JSON round-trips into valid rules and matches built-in behaviour', () => {
  const { rules, error } = parseKeybindingConfigJson(DEFAULT_KEYBINDING_CONFIG_JSON);
  assert.equal(error, undefined);
  assert.ok(rules && rules.length > 0);
  // 用解析出的规则跑一遍核心断言，确认 DSL 编译结果与内置一致。
  assert.deepEqual(matchKeybinding(keydown({ altKey: true, code: 'KeyT' }), rules), { route: 'termy', action: 'tab-new' });
  assert.deepEqual(matchKeybinding(keydown({ ctrlKey: true, code: 'Tab' }), rules), { route: 'obsidian', action: undefined });
  assert.deepEqual(matchKeybinding(keydown({ ctrlKey: true, code: 'KeyE' }), rules), { route: 'terminal', action: undefined });
  assert.deepEqual(matchKeybinding(keydown({ metaKey: true, code: 'KeyC' }), rules), { route: 'termy', action: 'copy' });
});

test('parseKeybindingConfigJson reports readable errors', () => {
  assert.match(parseKeybindingConfigJson('not json').error ?? '', /JSON 语法错误/);
  assert.match(parseKeybindingConfigJson('{}').error ?? '', /必须是一个数组/);
  assert.match(parseKeybindingConfigJson('[{"when":"Ctrl+W","route":"nowhere"}]').error ?? '', /无效规则/);
  assert.match(parseKeybindingConfigJson('[{"when":"Zzz+9","route":"termy"}]').error ?? '', /无法解析/);
  assert.match(parseKeybindingConfigJson('[{"when":"Opt+T","route":"termy","action":"explode"}]').error ?? '', /未知动作/);
});

test('keyboardEventToWhen reverses a keypress into a when string', () => {
  assert.equal(keyboardEventToWhen({ type: 'keydown', altKey: true, code: 'KeyT' }), 'Opt+T');
  assert.equal(keyboardEventToWhen({ type: 'keydown', ctrlKey: true, shiftKey: true, code: 'Tab' }), 'Ctrl+Shift+Tab');
  assert.equal(keyboardEventToWhen({ type: 'keydown', metaKey: true, code: 'KeyC' }), 'Cmd+C');
  assert.equal(keyboardEventToWhen({ type: 'keydown', ctrlKey: true, code: 'Digit5' }), 'Ctrl+5');
  // 纯修饰键 / 不支持的键 → null
  assert.equal(keyboardEventToWhen({ type: 'keydown', ctrlKey: true, code: 'ControlLeft' }), null);
});

test('keyboardEventToWhen round-trips with parseKeybindingWhen', () => {
  for (const ev of [
    { type: 'keydown', altKey: true, code: 'KeyW' },
    { type: 'keydown', ctrlKey: true, shiftKey: true, code: 'Digit3' },
    { type: 'keydown', metaKey: true, code: 'KeyV' },
  ] as KeybindingEventLike[]) {
    const when = keyboardEventToWhen(ev);
    assert.ok(when);
    const parsed = parseKeybindingWhen(when);
    assert.ok(parsed && parsed.codes?.includes(ev.code!));
  }
});

test('compileKeybindingConfig skips bad entries and keeps good ones', () => {
  const rules = compileKeybindingConfig([
    { when: 'Opt+T', route: 'termy', action: 'tab-new' },
    { when: 'Bad+Key', route: 'termy' },
  ]);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].label, 'Opt+T');
});
