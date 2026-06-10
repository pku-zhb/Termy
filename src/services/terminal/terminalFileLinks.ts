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

const FILE_URI_PREFIX = 'file://';
const PARTIAL_PREFIX_BOUNDARY_REGEX = /[\s"'(<[`]/;
// 「像样的扩展名」：点 + 字母开头（纯数字段如 ".34" 多半是被折行劈开的文件名片段），
// 且后面必须是边界字符或文本结束——目录名里的点（如 ".obsidian/"）后跟 "/"，不算。
const FILE_URI_PLAUSIBLE_EXTENSION_REGEX = /\.[A-Za-z][A-Za-z0-9]{0,15}(?=[\s"',.!?;:#?)\]}>]|$)/;
const FILE_URI_COMPLETE_TAIL_REGEX = /\.[A-Za-z][A-Za-z0-9]{0,15}(?:[#?][^\s"',.!?;:*(){}|\\^<>`]*)?(?::\d+)?$/;

// 窗口文本末尾是否「悬着一个未闭合的 file:// 链接」。
// 用途：TUI（Claude Code 等）把长链接硬换行劈成多条真实行时，链接窗口据此决定
// 是否把下一行拼进来继续解析。只回答「还可能没写完吗」，最终边界仍由解析正则裁定。
export function terminalFileUriLooksOpenAtEnd(text: string): boolean {
  if (!text) {
    return false;
  }

  // 1) "file://" 前缀本身被劈开（行尾是 "file:/"、"fil" 等），要求前缀前是边界字符。
  for (let k = Math.min(FILE_URI_PREFIX.length - 1, text.length); k >= 1; k -= 1) {
    if (!text.endsWith(FILE_URI_PREFIX.slice(0, k))) {
      continue;
    }
    const before = text[text.length - k - 1];
    if (before === undefined || PARTIAL_PREFIX_BOUNDARY_REGEX.test(before)) {
      return true;
    }
  }

  const prefixIndex = text.toLowerCase().lastIndexOf(FILE_URI_PREFIX);
  if (prefixIndex === -1) {
    return false;
  }

  // 2) 最后一个 file:// 候选里还没出现像样的扩展名 → 多半还没写完。
  const candidate = text.slice(prefixIndex);
  if (!FILE_URI_PLAUSIBLE_EXTENSION_REGEX.test(candidate)) {
    return true;
  }

  // 3) 已有扩展名：仅当解析出的链接正好顶到文本末尾、且结尾不是完整的
  //    「.扩展名[#锚点][:行号]」（如被劈开的 "._14.34"）才继续拼。
  const tailLink = parseTerminalFileUriLinks(text).find((link) => link.endIndex >= text.length);
  if (!tailLink) {
    return false;
  }
  return !FILE_URI_COMPLETE_TAIL_REGEX.test(tailLink.uri);
}

// 硬换行拼接点的点击回退候选。TUI 按词折行会吃掉断点处的空格（"00 Temp" 折成
// "00"+"Temp"，拼回是 "00Temp"），按字符折行则不吃；点击时无法区分，只能按
// 「原样 → 补空格（组合数从少到多）→ 在拼接点截断」的顺序逐个尝试解析。
// junctions 是相对链接文本的拼接点下标。
export function buildTerminalFileUriJunctionCandidates(text: string, junctions: number[]): string[] {
  const valid = [...new Set(junctions)]
    .filter((junction) => junction > 0 && junction < text.length)
    .sort((a, b) => a - b);
  if (valid.length === 0) {
    return [text];
  }

  const withSpacesAt = (subset: number[]): string => {
    let out = text;
    for (let i = subset.length - 1; i >= 0; i -= 1) {
      out = `${out.slice(0, subset[i])} ${out.slice(subset[i])}`;
    }
    return out;
  };

  const candidates: string[] = [text];
  if (valid.length <= 3) {
    const subsets: number[][] = [];
    for (let mask = 1; mask < (1 << valid.length); mask += 1) {
      subsets.push(valid.filter((_, i) => (mask & (1 << i)) !== 0));
    }
    subsets.sort((a, b) => a.length - b.length);
    for (const subset of subsets) {
      candidates.push(withSpacesAt(subset));
    }
  } else {
    // 拼接点过多时只试单点补空格和全补，避免组合爆炸
    for (const junction of valid) {
      candidates.push(withSpacesAt([junction]));
    }
    candidates.push(withSpacesAt(valid));
  }

  for (let i = valid.length - 1; i >= 0; i -= 1) {
    candidates.push(text.slice(0, valid[i]));
  }

  return [...new Set(candidates)];
}

export function parseTerminalFileUriLinks(text: string): TerminalFileUriLink[] {
  // 按 file:// 出现位置分段、每段独立解析：相邻链接被硬换行拼到一起时
  // （"…md#L12file:///…"），锚点/路径的字符类会把下一条链接整个吞进来。
  // 段边界保证一条链接绝不跨进下一条的前缀。
  const prefixIndices: number[] = [];
  for (const prefixMatch of text.matchAll(/file:[/]{2}/gi)) {
    prefixIndices.push(prefixMatch.index ?? 0);
  }

  const links: TerminalFileUriLink[] = [];
  for (let i = 0; i < prefixIndices.length; i += 1) {
    const segmentStart = prefixIndices[i];
    const segment = text.slice(segmentStart, prefixIndices[i + 1] ?? text.length);
    const match = new RegExp(TERMINAL_FILE_URI_REGEX.source, TERMINAL_FILE_URI_REGEX.flags).exec(segment);
    if (!match) {
      continue;
    }

    const uri = normalizeTerminalFileUriLinkTarget(match[0]);
    if (!uri) {
      continue;
    }

    const startIndex = segmentStart + match.index + match[0].indexOf(uri);
    links.push({
      uri,
      startIndex,
      endIndex: startIndex + uri.length,
    });
  }

  return links;
}

