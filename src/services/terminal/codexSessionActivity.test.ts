import test from 'node:test';
import assert from 'node:assert/strict';

import { CodexSessionActivityParser } from './codexSessionActivity.ts';

test('captures the current Codex prompt and visible progress while ignoring tools', () => {
  const parser = new CodexSessionActivityParser();
  parser.push([
    line('event_msg', { type: 'task_started' }, '2026-07-10T08:00:00.000Z'),
    line('response_item', {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: '<image name=[Image #1] path="/tmp/example.png">' },
        { type: 'input_image', image_url: 'data:image/png;base64,ignored' },
        { type: 'input_text', text: '</image>' },
        { type: 'input_text', text: '帮我检查这个 session' },
      ],
    }),
    line('event_msg', {
      type: 'user_message',
      message: '帮我检查这个 session',
      local_images: ['/tmp/example.png'],
    }),
    line('event_msg', {
      type: 'agent_message',
      phase: 'commentary',
      message: '我先检查 transcript。',
    }),
    line('response_item', { type: 'custom_tool_call', name: 'exec', arguments: '{"cmd":"rg"}' }),
    line('response_item', { type: 'custom_tool_call_output', output: 'very noisy output' }),
  ].join('\n') + '\n');

  const activity = parser.getActivity();
  assert.equal(activity.state, 'running');
  assert.equal(activity.prompt, '帮我检查这个 session');
  assert.deepEqual(activity.updates.map((update) => update.text), ['我先检查 transcript。']);
});

test('recovers the prompt from the compact user event when the image response item is absent', () => {
  const parser = new CodexSessionActivityParser();
  parser.push([
    line('event_msg', { type: 'task_started' }),
    line('event_msg', {
      type: 'user_message',
      message: '只读取这段 prompt',
      local_images: ['/tmp/large-image.png'],
    }),
  ].join('\n') + '\n');

  assert.equal(parser.getActivity().prompt, '只读取这段 prompt');
});

test('keeps public reasoning summaries but never encrypted reasoning', () => {
  const parser = new CodexSessionActivityParser();
  parser.push([
    line('event_msg', { type: 'task_started' }),
    line('response_item', {
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: '已确认问题来自 session 映射。' }],
      encrypted_content: 'secret-ciphertext',
    }),
    line('response_item', {
      type: 'reasoning',
      summary: [],
      encrypted_content: 'another-secret-ciphertext',
    }),
  ].join('\n') + '\n');

  const activity = parser.getActivity();
  assert.deepEqual(activity.updates.map((update) => update.text), ['已确认问题来自 session 映射。']);
  assert.equal(JSON.stringify(activity).includes('secret-ciphertext'), false);
});

test('ignores final answers before the task-complete event arrives', () => {
  const parser = new CodexSessionActivityParser();
  parser.push([
    line('event_msg', { type: 'task_started' }),
    line('event_msg', {
      type: 'agent_message',
      phase: 'final_answer',
      message: '这是最终回复，不应展示。',
    }),
    line('response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '这是最终回复，不应展示。' }],
    }),
  ].join('\n') + '\n');

  assert.deepEqual(parser.getActivity().updates, []);
  assert.equal(parser.getActivity().finalAnswer, null);
});

test('tracks completion, avoids duplicate final text, and resets for a new turn', () => {
  const parser = new CodexSessionActivityParser();
  parser.push([
    line('event_msg', { type: 'task_started' }),
    line('response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '第一个任务' }],
    }),
    line('event_msg', {
      type: 'agent_message',
      phase: 'commentary',
      message: '已经完成检查，正在整理结果。',
    }),
    line('response_item', {
      type: 'message',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: '已经完成。\n\n<oai-mem-citation>internal metadata</oai-mem-citation>',
      }],
    }),
    line('event_msg', {
      type: 'agent_message',
      phase: 'final_answer',
      message: '已经完成。',
    }),
    line('event_msg', { type: 'task_complete', last_agent_message: '已经完成。' }),
  ].join('\n') + '\n');

  assert.equal(parser.getActivity().state, 'complete');
  assert.equal(parser.getActivity().finalAnswer, '已经完成。');
  assert.equal(parser.getActivity().updates.length, 1);
  assert.equal(parser.getActivity().updates[0]?.text, '已经完成检查，正在整理结果。');

  parser.push([
    line('event_msg', { type: 'task_started' }),
    line('response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '第二个任务' }],
    }),
  ].join('\n') + '\n');

  assert.deepEqual(parser.getActivity(), {
    state: 'running',
    prompt: '第二个任务',
    finalAnswer: null,
    updates: [],
    updatedAtMs: null,
  });
});

test('handles chunk boundaries and a tail that starts inside a JSONL record', () => {
  const parser = new CodexSessionActivityParser();
  const promptLine = line('response_item', {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: '保留这一条' }],
  });
  const progressLine = line('event_msg', {
    type: 'agent_message',
    phase: 'commentary',
    message: '正在检查。',
  });
  const chunk = `partial old record\n${line('event_msg', { type: 'task_started' })}\n${promptLine}\n${progressLine}\n`;
  parser.push(chunk.slice(0, 60), true);
  parser.push(chunk.slice(60));

  assert.equal(parser.getActivity().prompt, '保留这一条');
  assert.deepEqual(parser.getActivity().updates.map((update) => update.text), ['正在检查。']);
});

function line(type: string, payload: Record<string, unknown>, timestamp?: string): string {
  return JSON.stringify({ timestamp, type, payload });
}
