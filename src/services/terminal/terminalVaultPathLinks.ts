// Linkify bare filesystem paths printed in terminal output (no file:// prefix),
// e.g. Codex citing files as `[name](</Users/.../note.md>)` whose renderer collapses
// the markdown into a plain `$HOME`-relative path like
// `Nutstore Files/Nutstore/00 Temp/note.md`. We anchor on a filename extension, then
// walk left across whitespace-delimited word starts and ask the injected resolver
// whether the candidate (absolute / $HOME-relative / vault-relative) maps to a real
// openable vault file. The longest candidate that resolves wins, which also settles
// the "where does a space-containing path start" ambiguity and keeps noise low: only
// strings that point at an actual vault file get underlined.

export interface TerminalVaultPathLink {
  absolutePath: string;
  line?: number;
  startIndex: number;
  endIndex: number;
}

// Given a candidate path (line suffix already stripped), return the canonical absolute
// filesystem path when it resolves to a real, openable vault file; otherwise null.
export type VaultPathResolver = (candidatePath: string) => string | null;

// A filename tail: `.ext` optionally followed by `:line`. The trailing negative
// lookahead only requires the extension not to continue into another alphanumeric run,
// so any punctuation (ASCII or CJK), whitespace, or end-of-string ends it. The line
// group is greedy so `.md:12` captures the line rather than stopping at `.md`.
const PATH_TAIL_ANCHOR_REGEX = /\.[A-Za-z0-9]{1,16}(?::(\d+))?(?![A-Za-z0-9])/gu;

// Characters that can never sit inside a cited path token; the leftward scan stops at
// the nearest one of these (or the start of the window).
const HARD_LEFT_DELIMITERS = new Set([
  '"', "'", '`', '<', '>', '(', ')', '[', ']', '{', '}', '=', '|', '\n', '\r', '\t',
]);

const WHITESPACE_REGEX = /\s/;

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function parseTerminalVaultPathLinks(
  text: string,
  resolve: VaultPathResolver,
): TerminalVaultPathLink[] {
  const links: TerminalVaultPathLink[] = [];

  for (const match of text.matchAll(PATH_TAIL_ANCHOR_REGEX)) {
    const anchorStart = match.index ?? 0;
    const anchorEnd = anchorStart + match[0].length;
    const lineDigits = match[1];
    // End of the path proper (before any `:line` suffix the anchor swallowed).
    const pathEnd = lineDigits === undefined
      ? anchorEnd
      : anchorStart + match[0].indexOf(`:${lineDigits}`);

    // Scan left to the nearest hard delimiter / window start; that bounds how far a
    // space-containing path could reach back.
    let leftBound = anchorStart;
    while (leftBound > 0 && !HARD_LEFT_DELIMITERS.has(text[leftBound - 1])) {
      leftBound -= 1;
    }
    while (leftBound < pathEnd && WHITESPACE_REGEX.test(text[leftBound])) {
      leftBound += 1;
    }

    // Candidate start positions: the left bound plus every word start (whitespace →
    // non-whitespace transition) up to the filename. Leftmost first = longest path.
    const starts: number[] = [leftBound];
    for (let i = leftBound; i < pathEnd - 1; i += 1) {
      if (WHITESPACE_REGEX.test(text[i]) && !WHITESPACE_REGEX.test(text[i + 1])) {
        starts.push(i + 1);
      }
    }

    for (const start of starts) {
      if (start >= pathEnd) {
        continue;
      }
      const candidate = text.slice(start, pathEnd);
      const absolutePath = resolve(candidate);
      if (!absolutePath) {
        continue;
      }
      // Only the longest resolving candidate matters; if it overlaps a link we already
      // recorded (e.g. two extensions in one filename), this anchor is already covered.
      if (links.some((link) => rangesOverlap(start, anchorEnd, link.startIndex, link.endIndex))) {
        break;
      }
      const parsedLine = lineDigits === undefined ? undefined : Number.parseInt(lineDigits, 10);
      links.push({
        absolutePath,
        line: parsedLine !== undefined && Number.isInteger(parsedLine) && parsedLine > 0
          ? parsedLine
          : undefined,
        startIndex: start,
        endIndex: anchorEnd,
      });
      break;
    }
  }

  return links;
}
