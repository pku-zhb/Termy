interface ImeKeyboardEventLike {
  type: string;
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

interface ImeBeforeInputLike {
  inputType: string;
}

/**
 * Decide whether a `beforeinput` event should arm the IME commit fallback.
 *
 * The fallback exists to re-deliver committed IME text that xterm occasionally
 * drops. It must never fire for *mid-composition* results: streaming voice IMEs
 * emit a `beforeinput` with `inputType === 'insertCompositionText'` for every
 * partial recognition (already CJK, so `isImeCommitFallbackText` lets them
 * through), and forwarding each partial appends it to the PTY instead of
 * replacing the previous one — producing "这这这这这句这句话…" garbage. The real
 * commit always arrives separately via `compositionend`, so only genuine
 * non-composition `insertText` should arm the fallback here.
 */
export function shouldScheduleImeCommitFallbackForBeforeInput(
  event: ImeBeforeInputLike,
  isComposing: boolean,
): boolean {
  if (isComposing) {
    return false;
  }

  return event.inputType === 'insertText';
}

const TEXT_INPUT_KEY_CODES = new Set([
  'Space',
  'Backquote',
  'Minus',
  'Equal',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'Semicolon',
  'Quote',
  'Comma',
  'Period',
  'Slash',
  'IntlBackslash',
  'IntlRo',
  'IntlYen',
  'Numpad0',
  'Numpad1',
  'Numpad2',
  'Numpad3',
  'Numpad4',
  'Numpad5',
  'Numpad6',
  'Numpad7',
  'Numpad8',
  'Numpad9',
  'NumpadDecimal',
  'NumpadDivide',
  'NumpadMultiply',
  'NumpadSubtract',
  'NumpadAdd',
]);

export function isImeCommitFallbackText(text: string | null | undefined): text is string {
  if (!text) {
    return false;
  }

  let hasNonAscii = false;
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return false;
    }
    if (codePoint > 0x7f) {
      hasNonAscii = true;
    }
  }

  return hasNonAscii;
}

export function shouldBypassKeyboardEncodingForTextKey(
  event: ImeKeyboardEventLike,
): boolean {
  if (
    (event.type !== 'keydown' && event.type !== 'keypress')
    || event.ctrlKey
    || event.metaKey
  ) {
    return false;
  }

  if (isSinglePrintableCharacterKey(event.key)) {
    return true;
  }

  return event.code !== undefined && TEXT_INPUT_KEY_CODES.has(event.code);
}

function isSinglePrintableCharacterKey(key: string): boolean {
  const chars = Array.from(key);
  if (chars.length !== 1) {
    return false;
  }

  const codePoint = chars[0]?.codePointAt(0);
  return codePoint !== undefined && codePoint >= 0x20 && codePoint !== 0x7f;
}
