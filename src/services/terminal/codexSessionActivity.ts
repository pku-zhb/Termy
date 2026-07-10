export type CodexSessionActivityState = 'idle' | 'running' | 'complete' | 'aborted';

export type CodexSessionActivityUpdateKind = 'progress' | 'reasoning-summary';

export interface CodexSessionActivityUpdate {
  kind: CodexSessionActivityUpdateKind;
  text: string;
  timestampMs: number | null;
}

export interface CodexSessionActivity {
  state: CodexSessionActivityState;
  prompt: string | null;
  updates: CodexSessionActivityUpdate[];
  updatedAtMs: number | null;
}

const MAX_ACTIVITY_UPDATES = 8;
const IMAGE_MARKUP_PATTERN = /<image\b[^>]*>|<\/image>/gi;
const MEMORY_CITATION_PATTERN = /\n*<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>\s*$/gi;

const EMPTY_CODEX_SESSION_ACTIVITY: CodexSessionActivity = {
  state: 'idle',
  prompt: null,
  updates: [],
  updatedAtMs: null,
};

interface TranscriptEnvelope {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
}

interface TranscriptPayload {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  summary?: unknown;
  message?: unknown;
  phase?: unknown;
  last_agent_message?: unknown;
}

/**
 * Incrementally reduces a Codex JSONL transcript to the active turn's user
 * prompt and user-visible progress. Tool calls/results and encrypted reasoning
 * are intentionally ignored.
 */
export class CodexSessionActivityParser {
  private pendingLine = '';
  private activity: CodexSessionActivity = cloneActivity(EMPTY_CODEX_SESSION_ACTIVITY);

  reset(): void {
    this.pendingLine = '';
    this.activity = cloneActivity(EMPTY_CODEX_SESSION_ACTIVITY);
  }

  push(chunk: string, discardLeadingPartialLine = false): CodexSessionActivity {
    let nextChunk = chunk;
    if (discardLeadingPartialLine && this.pendingLine.length === 0) {
      const firstNewline = nextChunk.indexOf('\n');
      if (firstNewline === -1) {
        return this.getActivity();
      }
      nextChunk = nextChunk.slice(firstNewline + 1);
    }

    const lines = `${this.pendingLine}${nextChunk}`.split('\n');
    this.pendingLine = lines.pop() ?? '';
    for (const line of lines) {
      this.consumeLine(line);
    }
    return this.getActivity();
  }

  getActivity(): CodexSessionActivity {
    return cloneActivity(this.activity);
  }

  private consumeLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) {
      return;
    }
    const header = line.slice(0, 512);
    if (header.includes('"type":"response_item","payload":{"type":"custom_tool_call')
      || header.includes('"type":"response_item","payload":{"type":"function_call')
      || header.includes('"type":"response_item","payload":{"type":"local_shell_call')) {
      return;
    }

    let envelope: TranscriptEnvelope;
    try {
      envelope = JSON.parse(line) as TranscriptEnvelope;
    } catch {
      return;
    }

    const payload = isRecord(envelope.payload) ? envelope.payload as TranscriptPayload : null;
    if (!payload || typeof payload.type !== 'string') {
      return;
    }

    const timestampMs = timestampToMilliseconds(envelope.timestamp);
    if (envelope.type === 'event_msg') {
      this.consumeEvent(payload, timestampMs);
      return;
    }
    if (envelope.type !== 'response_item') {
      return;
    }

    if (payload.type === 'message') {
      this.consumeMessage(payload, timestampMs);
      return;
    }
    if (payload.type === 'reasoning') {
      const summary = textFromContent(payload.summary);
      if (summary) {
        this.appendUpdate('reasoning-summary', summary, timestampMs);
      }
    }
  }

  private consumeEvent(payload: TranscriptPayload, timestampMs: number | null): void {
    if (payload.type === 'task_started') {
      this.activity = {
        state: 'running',
        prompt: null,
        updates: [],
        updatedAtMs: timestampMs,
      };
      return;
    }
    if (payload.type === 'user_message') {
      const prompt = normalizeDisplayText(payload.message);
      if (prompt) {
        this.activity.prompt = prompt;
        this.activity.updatedAtMs = timestampMs ?? this.activity.updatedAtMs;
      }
      return;
    }
    if (payload.type === 'agent_message') {
      if (payload.phase === 'commentary') {
        const progress = normalizeDisplayText(payload.message);
        if (progress) {
          this.appendUpdate('progress', progress, timestampMs);
        }
      }
      return;
    }
    if (payload.type === 'task_complete') {
      const finalMessage = normalizeDisplayText(payload.last_agent_message);
      if (finalMessage) {
        const finalUpdateIndex = this.activity.updates.findLastIndex(
          (update) => update.text === finalMessage,
        );
        if (finalUpdateIndex >= 0) {
          this.activity.updates.splice(finalUpdateIndex, 1);
        }
      }
      this.activity.state = 'complete';
      this.activity.updatedAtMs = timestampMs ?? this.activity.updatedAtMs;
      return;
    }
    if (payload.type === 'turn_aborted') {
      this.activity.state = 'aborted';
      this.activity.updatedAtMs = timestampMs ?? this.activity.updatedAtMs;
    }
  }

  private consumeMessage(payload: TranscriptPayload, timestampMs: number | null): void {
    const text = normalizeDisplayText(textFromContent(payload.content));
    if (!text) {
      return;
    }
    if (payload.role === 'user') {
      this.activity.prompt = text;
      this.activity.updatedAtMs = timestampMs ?? this.activity.updatedAtMs;
      return;
    }
    if (payload.role === 'assistant' && payload.phase === 'commentary') {
      this.appendUpdate('progress', text, timestampMs);
    }
  }

  private appendUpdate(
    kind: CodexSessionActivityUpdateKind,
    text: string,
    timestampMs: number | null,
  ): void {
    const normalized = normalizeDisplayText(text);
    if (!normalized) {
      return;
    }
    const previous = this.activity.updates[this.activity.updates.length - 1];
    if (previous?.text === normalized) {
      previous.timestampMs = timestampMs ?? previous.timestampMs;
      this.activity.updatedAtMs = timestampMs ?? this.activity.updatedAtMs;
      return;
    }

    this.activity.updates.push({ kind, text: normalized, timestampMs });
    if (this.activity.updates.length > MAX_ACTIVITY_UPDATES) {
      this.activity.updates.splice(0, this.activity.updates.length - MAX_ACTIVITY_UPDATES);
    }
    this.activity.updatedAtMs = timestampMs ?? this.activity.updatedAtMs;
  }
}

function textFromContent(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    return null;
  }

  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    if (!isRecord(item)) {
      continue;
    }
    for (const key of ['text', 'input_text', 'output_text'] as const) {
      if (typeof item[key] === 'string') {
        parts.push(item[key]);
        break;
      }
    }
  }
  return parts.join('\n');
}

function normalizeDisplayText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value
    .replace(IMAGE_MARKUP_PATTERN, '')
    .replace(MEMORY_CITATION_PATTERN, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return normalized || null;
}

function timestampToMilliseconds(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function cloneActivity(activity: CodexSessionActivity): CodexSessionActivity {
  return {
    ...activity,
    updates: activity.updates.map((update) => ({ ...update })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function isTerminalViewportAtScrollableBottom(viewportY: number, baseY: number): boolean {
  return baseY > 0 && viewportY >= baseY;
}
