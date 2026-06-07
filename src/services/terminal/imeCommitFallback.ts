interface ImeKeyboardEventLike {
  type: string;
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
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
