/**
 * 终端键盘路由规则表（数据驱动 + 人类可读 DSL）。
 *
 * 用户可在设置里用一份 JSON 配置覆盖默认规则，每条形如：
 *   { "when": "Ctrl+Tab", "route": "obsidian" }
 *   { "when": "Opt+1..9", "route": "termy", "action": "tab-goto" }
 *
 * 三个去向（route）：
 *  - 'terminal'：透传给终端里运行的程序（PTY）。默认 —— Ctrl 行编辑、中断、
 *    图片粘贴（Ctrl+V）都靠它，Claude Code / Codex 重度依赖。
 *  - 'termy'：交给 Termy 自己的动作（action 字段指定）。
 *  - 'obsidian'：还给宿主 Obsidian —— 不发 PTY、也不 preventDefault，让事件冒泡
 *    到 Obsidian 的快捷键系统（如 Ctrl+Tab 切标签页）。
 *
 * 匹配语义：按数组顺序，第一条命中的规则生效（具体规则在前、通配 `*` 在后）。
 * 物理键用 event.code，这样 macOS 上 Opt+字母 打出的特殊字符不影响匹配。
 *
 * 注意：IME 合成事件不走这里，必须在调用层最先放行（见 terminalInstance 入口）。
 */

export type KeyboardRoute = 'terminal' | 'termy' | 'obsidian';

export type TermyKeyAction =
  | 'tab-new'
  | 'tab-close'
  | 'tab-rename'
  | 'tab-next'
  | 'tab-prev'
  | 'tab-goto'
  | 'font-increase'
  | 'font-decrease'
  | 'font-reset'
  | 'search-toggle'
  | 'copy'
  | 'paste'
  | 'newline';

const TERMY_ACTIONS = new Set<TermyKeyAction>([
  'tab-new', 'tab-close', 'tab-rename', 'tab-next', 'tab-prev', 'tab-goto',
  'font-increase', 'font-decrease', 'font-reset', 'search-toggle', 'copy', 'paste', 'newline',
]);
const ROUTES = new Set<KeyboardRoute>(['terminal', 'termy', 'obsidian']);

interface KeybindingModifiers {
  ctrl?: boolean;
  cmd?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export interface KeybindingRule {
  /** 人类可读标签（即原始 when 串），便于 UI 展示与排错，不参与匹配。 */
  label: string;
  mods: KeybindingModifiers;
  /** 物理键码白名单；省略表示"该修饰键组合下的任意键"（通配 `*`）。 */
  codes?: string[];
  route: KeyboardRoute;
  action?: TermyKeyAction;
}

/** 用户可编辑的配置项形态（一行一条），会被 compile 成内部 KeybindingRule。 */
export interface KeybindingConfigEntry {
  when: string;
  route: KeyboardRoute;
  action?: TermyKeyAction;
}

export interface KeybindingEventLike {
  type: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export interface KeybindingMatch {
  route: KeyboardRoute;
  action?: TermyKeyAction;
  /** tab-goto 专用：0-based 目标下标。 */
  tabIndex?: number;
}

/**
 * 默认配置（人类可读）。顺序即优先级：具体规则在前、通配 `*` 在后。
 * 这份就是「设置 → 键盘」里展示和可恢复的默认值。
 */
export const DEFAULT_KEYBINDING_CONFIG: KeybindingConfigEntry[] = [
  // Opt → Termy 内部
  { when: 'Opt+T', route: 'termy', action: 'tab-new' },
  { when: 'Opt+W', route: 'termy', action: 'tab-close' },
  { when: 'Opt+R', route: 'termy', action: 'tab-rename' },
  { when: 'Opt+Tab', route: 'termy', action: 'tab-next' },
  { when: 'Opt+Shift+Tab', route: 'termy', action: 'tab-prev' },
  { when: 'Opt+1..9', route: 'termy', action: 'tab-goto' },
  { when: 'Opt+F', route: 'termy', action: 'search-toggle' },
  { when: 'Opt+=', route: 'termy', action: 'font-increase' },
  { when: 'Opt+-', route: 'termy', action: 'font-decrease' },
  { when: 'Opt+0', route: 'termy', action: 'font-reset' },
  // Cmd → 复制粘贴留 Termy，其余还 Obsidian
  { when: 'Cmd+C', route: 'termy', action: 'copy' },
  { when: 'Cmd+V', route: 'termy', action: 'paste' },
  { when: 'Cmd+*', route: 'obsidian' },
  // Ctrl 黑名单 → Obsidian（其余 Ctrl 全透传给程序）
  { when: 'Ctrl+W', route: 'obsidian' },
  { when: 'Ctrl+Q', route: 'obsidian' },
  { when: 'Ctrl+1..5', route: 'obsidian' },
  { when: 'Ctrl+Shift+1..5', route: 'obsidian' },
  { when: 'Ctrl+Tab', route: 'obsidian' },
  { when: 'Ctrl+Shift+Tab', route: 'obsidian' },
  // 换行
  { when: 'Shift+Enter', route: 'termy', action: 'newline' },
  // 其余 Ctrl 透传给程序
  { when: 'Ctrl+*', route: 'terminal' },
];

const MODIFIER_ALIASES: Record<string, keyof KeybindingModifiers> = {
  opt: 'alt', option: 'alt', alt: 'alt',
  cmd: 'cmd', command: 'cmd', meta: 'cmd', super: 'cmd', win: 'cmd',
  ctrl: 'ctrl', control: 'ctrl',
  shift: 'shift',
};

function keyTokenToCodes(token: string): string[] | null {
  // 数字范围：1..5 / 1-5
  const range = /^([0-9])(?:\.\.|-)([0-9])$/.exec(token);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (from > to) return null;
    const codes: string[] = [];
    for (let d = from; d <= to; d += 1) codes.push(`Digit${d}`);
    return codes;
  }
  if (/^[0-9]$/.test(token)) return [`Digit${token}`];
  if (/^[A-Za-z]$/.test(token)) return [`Key${token.toUpperCase()}`];

  switch (token.toLowerCase()) {
    case 'tab': return ['Tab'];
    case 'enter': case 'return': return ['Enter'];
    case 'esc': case 'escape': return ['Escape'];
    case 'space': return ['Space'];
    case '=': case '+': case 'equal': case 'plus': return ['Equal'];
    case '-': case 'minus': return ['Minus'];
    default: return null;
  }
}

/**
 * 解析单条 when 串（如 "Ctrl+Shift+1..5" / "Cmd+*"）成匹配条件。
 * 失败返回 null。通配 `*`：列出的主修饰键(ctrl/cmd/alt)锁定、未列出的为 false，
 * shift 不锁定，键不限；具体键：所有未列出的修饰键都精确为 false。
 */
export function parseKeybindingWhen(when: string): { mods: KeybindingModifiers; codes?: string[] } | null {
  const parts = when.split('+').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return null;

  const keyToken = parts[parts.length - 1];
  const modTokens = parts.slice(0, -1);

  let alt = false, ctrl = false, cmd = false, shift = false;
  for (const token of modTokens) {
    const which = MODIFIER_ALIASES[token.toLowerCase()];
    if (!which) return null;
    if (which === 'alt') alt = true;
    else if (which === 'ctrl') ctrl = true;
    else if (which === 'cmd') cmd = true;
    else shift = true;
  }

  if (keyToken === '*') {
    // 通配：主修饰键精确（未列=false），shift 不关心。
    const mods: KeybindingModifiers = { alt, ctrl, cmd };
    if (shift) mods.shift = true;
    return { mods };
  }

  const codes = keyTokenToCodes(keyToken);
  if (!codes) return null;
  return { mods: { alt, ctrl, cmd, shift }, codes };
}

/**
 * 把一份配置编译成内部规则表。无法解析的条目按 onError 上报并跳过。
 */
export function compileKeybindingConfig(
  entries: KeybindingConfigEntry[],
  onError?: (message: string) => void,
): KeybindingRule[] {
  const rules: KeybindingRule[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry.when !== 'string' || !ROUTES.has(entry.route)) {
      onError?.(`无效规则：${JSON.stringify(entry)}`);
      continue;
    }
    if (entry.action !== undefined && !TERMY_ACTIONS.has(entry.action)) {
      onError?.(`未知动作 "${entry.action}"：${entry.when}`);
      continue;
    }
    const parsed = parseKeybindingWhen(entry.when);
    if (!parsed) {
      onError?.(`无法解析按键 "${entry.when}"`);
      continue;
    }
    rules.push({ label: entry.when, mods: parsed.mods, codes: parsed.codes, route: entry.route, action: entry.action });
  }
  return rules;
}

/** 解析用户在设置里编辑的 JSON 文本。成功返回规则，失败返回可读错误。 */
export function parseKeybindingConfigJson(text: string): { rules?: KeybindingRule[]; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { error: `JSON 语法错误：${e instanceof Error ? e.message : String(e)}` };
  }
  if (!Array.isArray(parsed)) {
    return { error: '配置必须是一个数组（每项 { when, route, action? }）。' };
  }

  const problems: string[] = [];
  const rules = compileKeybindingConfig(parsed as KeybindingConfigEntry[], (m) => problems.push(m));
  if (problems.length > 0) {
    return { error: problems.join('；') };
  }
  return { rules };
}

/** 默认配置的 JSON 文本，用于 settings 默认值与「恢复默认」。 */
export const DEFAULT_KEYBINDING_CONFIG_JSON = JSON.stringify(DEFAULT_KEYBINDING_CONFIG, null, 2);

/** 所有 Termy 动作（供设置页动作下拉，顺序即展示顺序）。 */
export const TERMY_ACTION_LIST: TermyKeyAction[] = [
  'tab-new', 'tab-close', 'tab-rename', 'tab-next', 'tab-prev', 'tab-goto',
  'search-toggle', 'font-increase', 'font-decrease', 'font-reset', 'copy', 'paste', 'newline',
];

function codeToWhenKey(code: string | undefined): string | null {
  if (!code) return null;
  const key = /^Key([A-Z])$/.exec(code);
  if (key) return key[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  switch (code) {
    case 'Tab': return 'Tab';
    case 'Enter': return 'Enter';
    case 'Escape': return 'Esc';
    case 'Space': return 'Space';
    case 'Equal': return '=';
    case 'Minus': return '-';
    default: return null;
  }
}

/**
 * 把一次按键反解析成 when 串（如 "Ctrl+Shift+Tab"），供设置页「按下捕获」用。
 * 纯修饰键（只按了 Ctrl/Shift… 没有主键）或不支持的键返回 null。
 * 修饰键顺序固定 Cmd→Ctrl→Opt→Shift，与 parseKeybindingWhen 可往返。
 */
export function keyboardEventToWhen(event: KeybindingEventLike): string | null {
  const key = codeToWhenKey(event.code);
  if (!key) return null;
  const parts: string[] = [];
  if (event.metaKey) parts.push('Cmd');
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Opt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/** 默认规则表（编译自 DEFAULT_KEYBINDING_CONFIG）。 */
export const DEFAULT_KEYBINDING_RULES: KeybindingRule[] = compileKeybindingConfig(DEFAULT_KEYBINDING_CONFIG);

function modifiersMatch(event: KeybindingEventLike, mods: KeybindingModifiers): boolean {
  if (mods.ctrl !== undefined && mods.ctrl !== !!event.ctrlKey) return false;
  if (mods.cmd !== undefined && mods.cmd !== !!event.metaKey) return false;
  if (mods.alt !== undefined && mods.alt !== !!event.altKey) return false;
  if (mods.shift !== undefined && mods.shift !== !!event.shiftKey) return false;
  return true;
}

function tabIndexForGoto(code: string | undefined): number | undefined {
  const match = code ? /^Digit([1-9])$/.exec(code) : null;
  return match ? Number(match[1]) - 1 : undefined;
}

/**
 * 把一个键盘事件匹配到路由结果。只处理 keydown；其余事件返回 null（由调用层走默认路径）。
 * 返回 null 表示"没有规则命中" —— 调用层应按默认（透传给终端程序）处理。
 */
export function matchKeybinding(
  event: KeybindingEventLike,
  rules: KeybindingRule[] = DEFAULT_KEYBINDING_RULES,
): KeybindingMatch | null {
  if (event.type !== 'keydown') {
    return null;
  }

  for (const rule of rules) {
    if (!modifiersMatch(event, rule.mods)) continue;
    if (rule.codes && !(event.code && rule.codes.includes(event.code))) continue;

    const match: KeybindingMatch = { route: rule.route, action: rule.action };
    if (rule.action === 'tab-goto') {
      match.tabIndex = tabIndexForGoto(event.code);
    }
    return match;
  }

  return null;
}
