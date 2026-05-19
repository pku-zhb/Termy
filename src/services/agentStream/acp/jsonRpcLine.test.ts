import assert from 'node:assert/strict';
import test from 'node:test';

import { JsonRpcLineDecoder, encodeJsonRpcFrame } from './jsonRpcLine.ts';

function frame(payload: unknown): Buffer {
  return encodeJsonRpcFrame(payload);
}

test('encodeJsonRpcFrame emits a newline-terminated JSON value', () => {
  const buf = encodeJsonRpcFrame({ jsonrpc: '2.0', id: 1, method: 'ping' });
  const text = buf.toString('utf8');
  assert.match(text, /^\{.*\}\n$/);
  assert.ok(text.includes('"method":"ping"'));
});

test('JsonRpcLineDecoder yields messages from a clean stream', () => {
  const decoder = new JsonRpcLineDecoder();
  const a = frame({ jsonrpc: '2.0', method: 'a' });
  const b = frame({ jsonrpc: '2.0', method: 'b' });
  const frames = decoder.feed(Buffer.concat([a, b]));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].kind, 'message');
  assert.equal(frames[1].kind, 'message');
  if (frames[0].kind === 'message' && frames[1].kind === 'message') {
    assert.deepEqual(frames[0].payload, { jsonrpc: '2.0', method: 'a' });
    assert.deepEqual(frames[1].payload, { jsonrpc: '2.0', method: 'b' });
  }
});

test('JsonRpcLineDecoder buffers partial frames across feeds', () => {
  const decoder = new JsonRpcLineDecoder();
  const buf = frame({ jsonrpc: '2.0', method: 'partial' });

  // Feed in 7-byte chunks to force the decoder to buffer.
  let yielded = 0;
  for (let i = 0; i < buf.byteLength; i += 7) {
    const slice = buf.subarray(i, Math.min(i + 7, buf.byteLength));
    yielded += decoder.feed(slice).length;
  }
  assert.equal(yielded, 1);
  assert.equal(decoder.pendingByteLength, 0);
});

test('JsonRpcLineDecoder handles UTF-8 multi-byte payloads correctly', () => {
  const decoder = new JsonRpcLineDecoder();
  const message = { jsonrpc: '2.0', method: 'echo', params: { text: '世界🚀 hello' } };
  const buf = frame(message);
  const frames = decoder.feed(buf);
  assert.equal(frames.length, 1);
  if (frames[0].kind === 'message') {
    assert.deepEqual(frames[0].payload, message);
  }
});

test('JsonRpcLineDecoder accepts CRLF line endings as well as LF', () => {
  const decoder = new JsonRpcLineDecoder();
  const json = '{"jsonrpc":"2.0","method":"crlf"}\r\n';
  const frames = decoder.feed(json);
  assert.equal(frames.length, 1);
  if (frames[0].kind === 'message') {
    assert.deepEqual(frames[0].payload, { jsonrpc: '2.0', method: 'crlf' });
  }
});

test('JsonRpcLineDecoder skips blank lines between frames', () => {
  const decoder = new JsonRpcLineDecoder();
  const buf = Buffer.from('\n\n{"a":1}\n\n{"b":2}\n', 'utf8');
  const frames = decoder.feed(buf);
  assert.equal(frames.length, 2);
});

test('JsonRpcLineDecoder reports parse-error for malformed JSON without throwing', () => {
  const decoder = new JsonRpcLineDecoder();
  const frames = decoder.feed('not-json\n{"valid":true}\n');
  assert.equal(frames.length, 2);
  assert.equal(frames[0].kind, 'parse-error');
  assert.equal(frames[1].kind, 'message');
});

test('JsonRpcLineDecoder.reset clears the internal buffer', () => {
  const decoder = new JsonRpcLineDecoder();
  decoder.feed('partial without newline');
  assert.ok(decoder.pendingByteLength > 0);
  decoder.reset();
  assert.equal(decoder.pendingByteLength, 0);
});
