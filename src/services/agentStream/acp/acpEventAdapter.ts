/**
 * Pure adapter that maps ACP `session/update` notifications into
 * Termy {@link AgentEvent}s.
 *
 * Centralising the wire-format → UI-model translation here keeps the
 * client transport (`acpClient.ts`) and the UI source
 * (`acpAgentSource.ts`) testable in isolation: this file knows
 * nothing about child processes or buses, only about JSON shapes.
 *
 * Mapping rationale by `sessionUpdate` discriminator:
 *
 * - **agent_message_chunk** → `text` (channel: 'final'). Streamed
 *   token-by-token; the session model concatenates chunks into one
 *   block until something else interrupts.
 * - **agent_thought_chunk** → `text` (channel: 'thought'). Renders
 *   dimmed in the panel.
 * - **user_message_chunk** → ignored. The user's own input is
 *   rendered by Termy itself when it sends `session/prompt`; echoing
 *   the agent's view back would create duplicates.
 * - **tool_call** → `tool-call`. Title, status, optional content/diff
 *   are translated into the panel's tool card model.
 * - **tool_call_update** → `tool-call-update` patching the same id.
 * - **plan** → `plan` with the steps mapped 1:1.
 * - **available_commands_update**, **current_mode_update**, and
 *   anything unrecognised → ignored. We surface no card for these
 *   because they are slash-command discovery / mode UI primarily, and
 *   Termy does not yet have UI for them. They simply do not show up.
 *
 * Stop reasons (from the prompt response, not a `session/update`)
 * map to `session-state` events through {@link adaptStopReason}.
 */

import type { AgentEvent } from '../agentEventTypes.ts';
import type {
  AcpContentBlock,
  AcpPlanEntry,
  AcpSessionUpdate,
  AcpStopReason,
  AcpToolCallContent,
  AcpToolCallUpdate,
  AcpToolCallProgressUpdate,
  AcpToolKind,
  AcpToolStatus,
} from './acpProtocol.ts';
import type { AgentSessionId, AgentToolKind, AgentToolStatus } from '../agentEventTypes.ts';

export interface AdaptUpdateInput {
  sessionId: AgentSessionId;
  update: AcpSessionUpdate;
}

/**
 * Map a single `session/update` notification to zero or more
 * {@link AgentEvent}s.
 */
export function adaptAcpUpdate(input: AdaptUpdateInput): AgentEvent[] {
  const { sessionId, update } = input;
  const updateRecord = update as unknown as Record<string, unknown>;

  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return adaptTextChunk(sessionId, 'final', updateRecord.content as AcpContentBlock);

    case 'agent_thought_chunk':
      return adaptTextChunk(sessionId, 'thought', updateRecord.content as AcpContentBlock);

    case 'user_message_chunk':
      // Termy renders the user's input itself; do not echo.
      return [];

    case 'tool_call':
      return adaptToolCall(sessionId, update as AcpToolCallUpdate);

    case 'tool_call_update':
      return adaptToolCallProgress(sessionId, update as AcpToolCallProgressUpdate);

    case 'plan':
      return adaptPlan(sessionId, (updateRecord.entries ?? []) as AcpPlanEntry[]);

    case 'available_commands_update':
    case 'current_mode_update':
      return [];

    default:
      // Unknown discriminators are silently ignored. The protocol is
      // still evolving and Termy must not crash on a future variant.
      return [];
  }
}

/**
 * Map a `session/prompt` response stop reason to a session-state
 * transition. Used by the client when the agent finishes a turn.
 */
export function adaptStopReason(
  sessionId: AgentSessionId,
  stopReason: AcpStopReason,
): AgentEvent {
  switch (stopReason) {
    case 'end_turn':
      return { kind: 'session-state', sessionId, state: 'awaiting-input', detail: 'Turn complete' };
    case 'cancelled':
      return { kind: 'session-state', sessionId, state: 'awaiting-input', detail: 'Cancelled' };
    case 'refusal':
      return { kind: 'session-state', sessionId, state: 'errored', detail: 'Agent refused the request' };
    case 'max_tokens':
      return { kind: 'session-state', sessionId, state: 'errored', detail: 'Max tokens reached' };
    case 'max_turn_requests':
      return { kind: 'session-state', sessionId, state: 'errored', detail: 'Max turn requests reached' };
    default: {
      // Forward-compatible: render as a generic awaiting-input.
      const _exhaustive: never = stopReason;
      return { kind: 'session-state', sessionId, state: 'awaiting-input', detail: String(_exhaustive) };
    }
  }
}

function adaptTextChunk(
  sessionId: AgentSessionId,
  channel: 'final' | 'thought',
  content: AcpContentBlock,
): AgentEvent[] {
  const text = extractTextFromContentBlock(content);
  if (text.length === 0) {
    return [];
  }
  return [{ kind: 'text', sessionId, channel, delta: text }];
}

function adaptToolCall(
  sessionId: AgentSessionId,
  update: AcpToolCallUpdate,
): AgentEvent[] {
  const events: AgentEvent[] = [
    {
      kind: 'tool-call',
      sessionId,
      toolCallId: update.toolCallId,
      toolName: update.title,
      toolKind: mapToolKind(update.kind),
      title: update.title,
      status: mapToolStatus(update.status, 'pending'),
    },
  ];
  // The announcement itself already carries status. Only emit a
  // follow-up `tool-call-update` when the announcement also brought
  // body / diff / output content — otherwise the panel would render
  // a redundant card update.
  if (update.content && update.content.length > 0) {
    const progress = synthesizeProgressUpdate(sessionId, update.toolCallId, update.status, update.content);
    if (progress) {
      events.push(progress);
    }
  }
  return events;
}

function adaptToolCallProgress(
  sessionId: AgentSessionId,
  update: AcpToolCallProgressUpdate,
): AgentEvent[] {
  const progress = synthesizeProgressUpdate(sessionId, update.toolCallId, update.status, update.content);
  return progress ? [progress] : [];
}

function synthesizeProgressUpdate(
  sessionId: AgentSessionId,
  toolCallId: string,
  status: AcpToolStatus | undefined,
  content: AcpToolCallContent[] | undefined,
): AgentEvent | null {
  if (status === undefined && (!content || content.length === 0)) {
    return null;
  }

  const event: AgentEvent = {
    kind: 'tool-call-update',
    sessionId,
    toolCallId,
  };
  if (status !== undefined) {
    event.status = mapToolStatus(status, 'pending');
  }

  const folded = foldToolCallContent(content);
  if (folded.body !== undefined) {
    event.body = folded.body;
  }
  if (folded.output !== undefined) {
    event.output = folded.output;
  }
  if (folded.diff !== undefined) {
    event.diff = folded.diff;
  }
  return event;
}

function adaptPlan(sessionId: AgentSessionId, entries: AcpPlanEntry[]): AgentEvent[] {
  return [
    {
      kind: 'plan',
      sessionId,
      steps: entries.map((entry, index) => ({
        id: `${sessionId}:plan:${index}`,
        title: entry.content,
        status: mapPlanStatus(entry.status),
      })),
    },
  ];
}

interface FoldedToolContent {
  body?: string;
  output?: string;
  diff?: { unified: string; path?: string };
}

function foldToolCallContent(content: AcpToolCallContent[] | undefined): FoldedToolContent {
  if (!content || content.length === 0) {
    return {};
  }

  const bodyParts: string[] = [];
  let output: string | undefined;
  let diff: { unified: string; path?: string } | undefined;

  for (const entry of content) {
    if (entry.type === 'content') {
      const block = (entry as { content?: unknown }).content;
      if (block !== undefined) {
        const text = extractTextFromContentBlock(block as AcpContentBlock);
        if (text) bodyParts.push(text);
      }
    } else if (entry.type === 'diff' && typeof (entry as { path?: unknown }).path === 'string' && typeof (entry as { newText?: unknown }).newText === 'string') {
      const diffEntry = entry as { path: string; oldText?: unknown; newText: string };
      const oldText = typeof diffEntry.oldText === 'string' ? diffEntry.oldText : '';
      diff = {
        path: diffEntry.path,
        unified: buildUnifiedDiff(diffEntry.path, oldText, diffEntry.newText),
      };
    } else if (entry.type === 'terminal') {
      // Terminal-content entries reference a terminal lifecycle that
      // Termy does not yet host; reflect the reference in the body.
      bodyParts.push(`_(terminal output id: ${'terminalId' in entry ? String(entry.terminalId) : '?'})_`);
    }
  }

  const folded: FoldedToolContent = {};
  if (bodyParts.length > 0) {
    folded.body = bodyParts.join('\n\n');
  }
  if (output !== undefined) folded.output = output;
  if (diff) folded.diff = diff;
  return folded;
}

function buildUnifiedDiff(path: string, oldText: string, newText: string): string {
  // Minimal unified diff — Termy's renderer just needs the textual
  // payload inside a fenced ```diff block. A full diff library is
  // overkill; render the before/after as fenced sections.
  const oldLines = oldText.split('\n').map((line) => `-${line}`);
  const newLines = newText.split('\n').map((line) => `+${line}`);
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@',
    ...oldLines,
    ...newLines,
  ].join('\n');
}

function extractTextFromContentBlock(block: AcpContentBlock): string {
  if (typeof block !== 'object' || block === null) {
    return '';
  }
  const type = (block as { type?: unknown }).type;
  if (type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
    return (block as { text: string }).text;
  }
  if (type === 'resource_link') {
    const rl = block as { uri?: string; name?: string };
    return rl.name ? `[${rl.name}](${rl.uri ?? ''})` : rl.uri ?? '';
  }
  if (type === 'resource') {
    const r = block as { resource?: { uri?: string; text?: string } };
    return r.resource?.text ?? r.resource?.uri ?? '';
  }
  return '';
}

function mapToolKind(kind: AcpToolKind | undefined): AgentToolKind {
  switch (kind) {
    case 'read': return 'read_file';
    case 'edit': return 'edit_file';
    case 'delete': return 'delete_file';
    case 'search': return 'search';
    case 'execute': return 'terminal';
    case 'fetch': return 'fetch';
    case 'move':
    case 'think':
    case 'other':
    case undefined:
    default:
      return 'other';
  }
}

function mapToolStatus(
  status: AcpToolStatus | undefined,
  fallback: AgentToolStatus,
): AgentToolStatus {
  switch (status) {
    case 'pending': return 'pending';
    case 'in_progress': return 'running';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case undefined:
    default:
      return fallback;
  }
}

function mapPlanStatus(
  status: AcpPlanEntry['status'] | undefined,
): 'pending' | 'in-progress' | 'completed' | 'failed' {
  switch (status) {
    case 'in_progress': return 'in-progress';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'pending':
    case undefined:
    default:
      return 'pending';
  }
}
