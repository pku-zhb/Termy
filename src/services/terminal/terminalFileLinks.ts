export interface TerminalFileUriLink {
  uri: string;
  startIndex: number;
  endIndex: number;
}

export interface TerminalFileUriReference {
  uri: string;
  line?: number;
}

// Match literal file:// URLs shown in terminal output. OSC 8 hyperlinks are
// handled by xterm's built-in linkHandler path.
// 第一分支（带扩展名、允许路径含空格）的结束判定：`.ext` 后跟空格时，仅当该空格后面不再
// 是「连续非空字符 + 路径分隔符」才算链接结束——否则像 "v1.2 data/note.md" 里的 ".2 " 会被
// 误判为结尾而截断。`$` 与右括号结尾不受此限制。
export const TERMINAL_FILE_URI_REGEX = /file:[/]{2}[^\r\n"'!*(){}|\\^<>`]*?\.[A-Za-z0-9]{1,16}(?:[#?][^\s"',.!?;:*(){}|\\^<>`]*)?(?::\d+)?(?=(?:[,.!?;:]?)(?:\s(?![^\s]*[/\\])|$|[)\]}>]))|file:[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/i;

const FILE_URI_PREFIX_REGEX = /file:[/]{2}/i;
const FILE_EXTENSION_BOUNDARY_REGEX = /\.[A-Za-z0-9]{1,16}(?:[#?][^\s"',.!?;:*(){}|\\^<>`]*)?(?::\d+)?(?=(?:[,.!?;:]?)(?:\s|$))/g;
const COLON_LINE_SUFFIX_REGEX = /(\.[A-Za-z0-9]{1,16})(?::(\d+))$/;
const HASH_LINE_REFERENCE_REGEX = /^(?:L|line=)(\d+)$/i;
const TRAILING_FILE_URI_PUNCTUATION_REGEX = /[\s"',.:;!?)}\]>]+$/;
const WHITESPACE_REGEX = /\s/;

function trimTerminalFileUriEnd(uri: string): string {
  return uri.replace(TRAILING_FILE_URI_PUNCTUATION_REGEX, '');
}

function findFileUriExtensionBoundaryEnd(uri: string): number {
  // 真正的文件扩展名属于最后一个路径段，所以只认「最后一个路径分隔符之后」的扩展名边界。
  // 否则中间目录名里的点号 + 空格（如 "v1.2 data/note.md" 里的 ".2 "）会被误当扩展名而截断。
  const lastSeparatorIndex = Math.max(uri.lastIndexOf('/'), uri.lastIndexOf('\\'));
  for (const match of uri.matchAll(FILE_EXTENSION_BOUNDARY_REGEX)) {
    const start = match.index ?? 0;
    if (start > lastSeparatorIndex) {
      return start + match[0].length;
    }
  }

  return -1;
}

export function normalizeTerminalFileUriLinkTarget(target: string): string | null {
  const prefixMatch = FILE_URI_PREFIX_REGEX.exec(target);
  if (!prefixMatch) {
    return null;
  }

  const candidate = target.slice(prefixMatch.index);
  const extensionEndIndex = findFileUriExtensionBoundaryEnd(candidate);
  if (extensionEndIndex > 0) {
    const normalized = trimTerminalFileUriEnd(candidate.slice(0, extensionEndIndex));
    return normalized.length > 'file://'.length ? normalized : null;
  }

  const whitespaceIndex = candidate.search(WHITESPACE_REGEX);
  if (whitespaceIndex > 0) {
    const afterWhitespace = candidate.slice(whitespaceIndex + 1);
    if (!/[\\/]/.test(afterWhitespace)) {
      const normalized = trimTerminalFileUriEnd(candidate.slice(0, whitespaceIndex));
      return normalized.length > 'file://'.length ? normalized : null;
    }
  }

  const normalized = trimTerminalFileUriEnd(candidate);
  return normalized.length > 'file://'.length ? normalized : null;
}

function parsePositiveLine(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const line = Number.parseInt(value, 10);
  return Number.isInteger(line) && line > 0 ? line : undefined;
}

export function parseTerminalFileUriReference(target: string): TerminalFileUriReference | null {
  const uri = normalizeTerminalFileUriLinkTarget(target);
  if (!uri) {
    return null;
  }

  const colonLineMatch = COLON_LINE_SUFFIX_REGEX.exec(uri);
  if (colonLineMatch) {
    const line = parsePositiveLine(colonLineMatch[2]);
    if (line !== undefined) {
      return {
        uri: uri.slice(0, -colonLineMatch[2].length - 1),
        line,
      };
    }
  }

  try {
    const url = new URL(uri);
    const hashLineMatch = HASH_LINE_REFERENCE_REGEX.exec(decodeURIComponent(url.hash.slice(1)));
    const line = parsePositiveLine(hashLineMatch?.[1] ?? url.searchParams.get('line'));
    if (line !== undefined) {
      url.hash = '';
      url.searchParams.delete('line');
      return {
        uri: url.toString(),
        line,
      };
    }
  } catch {
    // Keep the normalized URI when URL parsing rejects malformed input.
  }

  return { uri };
}

export function parseTerminalFileUriLinks(text: string): TerminalFileUriLink[] {
  const regex = new RegExp(
    TERMINAL_FILE_URI_REGEX.source,
    TERMINAL_FILE_URI_REGEX.flags.includes('g')
      ? TERMINAL_FILE_URI_REGEX.flags
      : `${TERMINAL_FILE_URI_REGEX.flags}g`,
  );
  const links: TerminalFileUriLink[] = [];

  for (const match of text.matchAll(regex)) {
    const uri = normalizeTerminalFileUriLinkTarget(match[0]);
    if (!uri) {
      continue;
    }

    const startIndex = (match.index ?? 0) + match[0].indexOf(uri);
    links.push({
      uri,
      startIndex,
      endIndex: startIndex + uri.length,
    });
  }

  return links;
}
