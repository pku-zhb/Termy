/**
 * Newline-delimited JSON-RPC framing.
 *
 * The Agent Client Protocol does not mandate a specific framing on
 * the wire; the official Rust SDK and OpenCode's TypeScript SDK
 * both use **NDJSON** (one JSON value per line). Termy follows the
 * same convention so it interoperates with the existing ACP agent
 * ecosystem out of the box.
 *
 * The decoder is a small streaming state machine that:
 *
 *   - Buffers chunks until a newline boundary appears.
 *   - Skips blank lines (some agents emit a leading boundary line).
 *   - Surfaces JSON parse failures as a synthetic `parse-error`
 *     envelope so the calling client can log and recover instead of
 *     taking down the whole stream.
 *
 * Returned messages are typed as `unknown` because they have not
 * been validated against any schema yet — the ACP client validates
 * them downstream when it dispatches them.
 *
 * The encoder is a one-liner kept here for symmetry. Unlike the
 * decoder it can throw if `JSON.stringify` fails (e.g., a circular
 * reference), but production callers always pass plain objects so
 * this is unreachable.
 */

/** Result yielded by the decoder. */
export type DecodedFrame =
  | { kind: 'message'; payload: unknown }
  | { kind: 'parse-error'; reason: string; rawPayload?: string };

/**
 * Encode a JSON-RPC message as an NDJSON-framed buffer ready to be
 * written to a writable stream.
 */
export function encodeJsonRpcFrame(message: unknown): Buffer {
  return Buffer.from(JSON.stringify(message) + '\n', 'utf8');
}

export class JsonRpcLineDecoder {
  /**
   * Internal accumulator. We rebuild a fresh buffer on each `feed`
   * call because Node Buffers are immutable in practice once shared
   * with another consumer; the cost is one extra copy per chunk
   * which is negligible for ACP traffic (a few KB/s at most).
   */
  private buffer: Buffer = Buffer.alloc(0);

  feed(chunk: Buffer | Uint8Array | string): DecodedFrame[] {
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    this.buffer = this.buffer.byteLength > 0
      ? Buffer.concat([this.buffer, incoming])
      : incoming;

    const out: DecodedFrame[] = [];
    while (true) {
      const newlineIndex = this.buffer.indexOf(0x0a /* `\n` */);
      if (newlineIndex < 0) break;

      const line = this.buffer.subarray(0, newlineIndex).toString('utf8').replace(/\r$/, '');
      this.buffer = this.buffer.subarray(newlineIndex + 1);

      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      try {
        const payload = JSON.parse(trimmed) as unknown;
        out.push({ kind: 'message', payload });
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'JSON parse failed';
        out.push({ kind: 'parse-error', reason, rawPayload: trimmed });
      }
    }
    return out;
  }

  /** Drop accumulated bytes. Used on transport reset. */
  reset(): void {
    this.buffer = Buffer.alloc(0);
  }

  /** Bytes still buffered, exposed for tests. */
  get pendingByteLength(): number {
    return this.buffer.byteLength;
  }
}
