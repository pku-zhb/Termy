export interface TerminalWebLink {
  uri: string;
  startIndex: number;
  endIndex: number;
}

const HTTP_URL_PREFIX_REGEX = /https?:[/]{2}/i;
const HTTP_URL_CANDIDATE_REGEX = /https?:[/]{2}[^\s"'<>`\\^{}|]+/gi;
const HTTP_URL_TRAILING_PUNCTUATION_REGEX = /[\s"',.;!?]+$/;
const PARTIAL_HTTP_PREFIX_BOUNDARY_REGEX = /[\s"'(<[`]/;
const HTTP_PREFIXES = ['https://', 'http://'] as const;
const WEB_URL_CONTINUATION_TOKEN_REGEX = /^\S+/;
const WEB_URL_CONTINUATION_MARKER_REGEX = /[/?#&=:%._~+-]/;
const WEB_URL_CONTINUATION_START_REGEX = /^[/?#&=:%._~+-]/;

function countChar(text: string, char: string): number {
  let count = 0;
  for (const current of text) {
    if (current === char) {
      count += 1;
    }
  }
  return count;
}

function trimUnbalancedClosingWrapper(uri: string, closing: string, opening: string): string {
  let trimmed = uri;
  while (
    trimmed.endsWith(closing)
    && countChar(trimmed, closing) > countChar(trimmed, opening)
  ) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function trimTerminalWebUrlEnd(uri: string): string {
  let trimmed = uri.replace(HTTP_URL_TRAILING_PUNCTUATION_REGEX, '');
  trimmed = trimUnbalancedClosingWrapper(trimmed, ')', '(');
  trimmed = trimUnbalancedClosingWrapper(trimmed, ']', '[');
  trimmed = trimUnbalancedClosingWrapper(trimmed, '}', '{');
  return trimUnbalancedClosingWrapper(trimmed, '>', '<');
}

function isValidHttpUrl(uri: string): boolean {
  try {
    const url = new URL(uri);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.hostname.length > 0;
  } catch {
    return false;
  }
}

export function normalizeTerminalWebLinkTarget(target: string): string | null {
  const prefixMatch = HTTP_URL_PREFIX_REGEX.exec(target);
  if (!prefixMatch) {
    return null;
  }

  const normalized = trimTerminalWebUrlEnd(target.slice(prefixMatch.index));
  return isValidHttpUrl(normalized) ? normalized : null;
}

export function parseTerminalWebLinks(text: string): TerminalWebLink[] {
  const links: TerminalWebLink[] = [];
  for (const match of text.matchAll(HTTP_URL_CANDIDATE_REGEX)) {
    const raw = match[0];
    const uri = normalizeTerminalWebLinkTarget(raw);
    if (!uri) {
      continue;
    }

    const startIndex = match.index ?? 0;
    links.push({
      uri,
      startIndex,
      endIndex: startIndex + uri.length,
    });
  }

  return links;
}

export function terminalWebUrlLooksOpenAtEnd(text: string): boolean {
  if (!text) {
    return false;
  }

  const lowerText = text.toLowerCase();
  for (const prefix of HTTP_PREFIXES) {
    for (let k = Math.min(prefix.length - 1, text.length); k >= 1; k -= 1) {
      if (!lowerText.endsWith(prefix.slice(0, k))) {
        continue;
      }
      const before = text[text.length - k - 1];
      if (before === undefined || PARTIAL_HTTP_PREFIX_BOUNDARY_REGEX.test(before)) {
        return true;
      }
    }
  }

  const httpIndex = Math.max(lowerText.lastIndexOf('http://'), lowerText.lastIndexOf('https://'));
  if (httpIndex === -1) {
    return false;
  }

  const candidate = text.slice(httpIndex);
  return !/\s/.test(candidate) && trimTerminalWebUrlEnd(candidate).length > 'http://'.length;
}

export function terminalWebUrlLooksLikeContinuation(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed || HTTP_URL_PREFIX_REGEX.test(trimmed)) {
    return false;
  }

  const token = WEB_URL_CONTINUATION_TOKEN_REGEX.exec(trimmed)?.[0] ?? '';
  if (!token || /^[)\]}>;,!]/.test(token)) {
    return false;
  }

  const hasTextAfterToken = token.length < trimmed.length;
  if (/^[A-Za-z0-9]/.test(token) && hasTextAfterToken) {
    return false;
  }

  return WEB_URL_CONTINUATION_START_REGEX.test(token)
    || WEB_URL_CONTINUATION_MARKER_REGEX.test(token);
}
