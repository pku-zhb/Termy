/**
 * Minimal ACP (Agent Client Protocol) client.
 *
 * Spawns an agent subprocess, frames JSON-RPC over its stdio with
 * `Content-Length` headers, performs the `initialize` →
 * `session/new` handshake, and exposes a small typed surface for
 * sending prompts / cancelling / closing.
 *
 * Design constraints worth highlighting:
 *
 * - **No external dependency on `vscode-jsonrpc`.** The framing layer
 *   is one small file ({@link JsonRpcLineDecoder}) — pulling in the
 *   full vscode-jsonrpc module would balloon `main.js` for a one-page
 *   feature. Tests exercise the framing exhaustively.
 *
 * - **The transport is abstracted behind {@link AcpTransport}.** In
 *   production we plug in {@link createChildProcessAcpTransport}; in
 *   tests we plug in an in-memory transport with hand-fed frames so
 *   we never touch a real shell.
 *
 * - **Termy advertises a tiny client capability surface for now.**
 *   No `fs`, no `terminal`. The agent is expected to use its own
 *   filesystem and process APIs. We can opt in once the vault-as-cwd
 *   semantics is settled.
 *
 * - **`session/request_permission` is auto-allowed in this iteration.**
 *   This is a deliberate, narrow trade-off: the alternative is
 *   blocking the prompt indefinitely until UI lands. The choice is
 *   logged via a permission-request event so the user *sees* what the
 *   agent did. A future iteration will turn this into a real modal.
 *
 * - **All inbound messages are validated permissively.** We never
 *   crash on a missing or malformed field; we either log via the
 *   provided `onError` hook or return early. This keeps the agent
 *   panel resilient when an experimental agent build ships a slightly
 *   off-spec frame.
 */

import { JsonRpcLineDecoder, encodeJsonRpcFrame } from './jsonRpcLine.ts';
import {
  ACP_LATEST_PROTOCOL_VERSION,
  ACP_METHODS,
  type AcpInitializeResult,
  type AcpNewSessionResult,
  type AcpPermissionRequestParams,
  type AcpPermissionResult,
  type AcpPromptResult,
  type AcpSessionUpdateNotification,
  type AcpStopReason,
} from './acpProtocol.ts';

/* -----------------------------------------------------------------
 * Transport abstraction
 * ---------------------------------------------------------------*/

export interface AcpTransport {
  /** Start the transport. Resolves once stdin/stdout are ready. */
  start(): Promise<void>;
  /** Send a serialized frame. */
  send(frame: Buffer): void;
  /** Subscribe to inbound bytes from the agent. */
  onData(listener: (chunk: Buffer) => void): () => void;
  /** Subscribe to lifecycle events (stderr lines, transport close). */
  onLog(listener: (text: string) => void): () => void;
  /** Subscribe to transport-level errors / unexpected exit. */
  onClose(listener: (reason: string) => void): () => void;
  /** Stop the transport, signalling the agent to exit. */
  stop(): Promise<void>;
}

/* -----------------------------------------------------------------
 * Client surface
 * ---------------------------------------------------------------*/

export interface AcpClientCallbacks {
  /** Invoked once per `session/update` notification. */
  onSessionUpdate?: (notification: AcpSessionUpdateNotification) => void;
  /**
   * Invoked when the agent requests permission for a tool call. The
   * default implementation auto-allows the first option — see the
   * design notes at the top of the file for why.
   */
  onPermissionRequest?: (
    params: AcpPermissionRequestParams,
  ) => Promise<AcpPermissionResult> | AcpPermissionResult;
  /** Invoked for diagnostic / stderr text that should reach the user. */
  onLog?: (text: string) => void;
  /** Invoked on transport / protocol errors that the client could not recover from. */
  onError?: (error: Error) => void;
  /** Invoked when the agent process exits or the transport closes. */
  onClose?: (reason: string) => void;
}

export interface AcpClientOptions {
  transport: AcpTransport;
  /**
   * Implementation info we send in `initialize`. Defaults are plumbed
   * by the caller because this module does not import the plugin
   * manifest directly.
   */
  clientInfo: {
    name: string;
    version: string;
    title?: string;
  };
  callbacks?: AcpClientCallbacks;
  /**
   * Wall-clock used for the request timeout countdown. Tests inject a
   * deterministic clock; production passes `Date.now`.
   */
  now?: () => number;
  /** Default request timeout in milliseconds. Defaults to 30 s. */
  requestTimeoutMs?: number;
  /** Function used to schedule timeouts. Defaults to `setTimeout`. */
  scheduleTimeout?: (callback: () => void, ms: number) => unknown;
  cancelTimeout?: (handle: unknown) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeoutHandle: unknown;
}

export class AcpClient {
  private readonly transport: AcpTransport;
  private readonly callbacks: AcpClientCallbacks;
  private readonly clientInfo: AcpClientOptions['clientInfo'];
  private readonly decoder = new JsonRpcLineDecoder();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private readonly scheduleTimeout: (callback: () => void, ms: number) => unknown;
  private readonly cancelTimeout: (handle: unknown) => void;

  private nextRequestId = 1;
  private detachData: (() => void) | null = null;
  private detachLog: (() => void) | null = null;
  private detachClose: (() => void) | null = null;
  private started = false;
  private closed = false;
  private initializeResult: AcpInitializeResult | null = null;
  private activeSessionId: string | null = null;

  constructor(options: AcpClientOptions) {
    this.transport = options.transport;
    this.callbacks = options.callbacks ?? {};
    this.clientInfo = options.clientInfo;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const defaultSchedule = (cb: () => void, ms: number): unknown => window.setTimeout(cb, ms);
    const defaultCancel = (handle: unknown): void => {
      if (handle !== null && handle !== undefined) {
        window.clearTimeout(handle as ReturnType<typeof window.setTimeout>);
      }
    };
    this.scheduleTimeout = options.scheduleTimeout ?? defaultSchedule;
    this.cancelTimeout = options.cancelTimeout ?? defaultCancel;
  }

  /** Start transport, decode loop, and complete initialization. */
  async start(): Promise<AcpInitializeResult> {
    if (this.started) {
      if (!this.initializeResult) {
        throw new Error('ACP client started but never finished initialization');
      }
      return this.initializeResult;
    }
    this.started = true;

    this.detachData = this.transport.onData((chunk) => this.handleIncoming(chunk));
    this.detachLog = this.transport.onLog((text) => {
      this.callbacks.onLog?.(text);
    });
    this.detachClose = this.transport.onClose((reason) => {
      this.handleClose(reason);
    });

    await this.transport.start();

    const result = await this.request<AcpInitializeResult>(ACP_METHODS.initialize, {
      protocolVersion: ACP_LATEST_PROTOCOL_VERSION,
      clientCapabilities: {
        // Conservative defaults; see the file header for rationale.
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: this.clientInfo,
    });
    this.initializeResult = result;
    return result;
  }

  /** Open a new session in the agent and remember its id. */
  async newSession(cwd: string): Promise<string> {
    const result = await this.request<AcpNewSessionResult>(ACP_METHODS.newSession, {
      cwd,
      mcpServers: [],
    });
    if (typeof result.sessionId !== 'string' || result.sessionId.length === 0) {
      throw new Error('ACP server returned an empty sessionId');
    }
    this.activeSessionId = result.sessionId;
    return result.sessionId;
  }

  /**
   * Send a prompt and wait for the turn to complete. Promise resolves
   * to the stop reason; streaming updates are delivered through
   * `callbacks.onSessionUpdate` while the prompt is in flight.
   */
  async prompt(sessionId: string, text: string): Promise<AcpStopReason> {
    const result = await this.request<AcpPromptResult>(ACP_METHODS.prompt, {
      sessionId,
      prompt: [{ type: 'text', text }],
    });
    return result.stopReason;
  }

  /** Send a `session/cancel` notification (no response expected). */
  cancel(sessionId: string): void {
    this.notify(ACP_METHODS.cancel, { sessionId });
  }

  /** Convenience accessor for callers that lost the session id. */
  get sessionId(): string | null {
    return this.activeSessionId;
  }

  /** Close the transport and reject every pending request. */
  async stop(reason = 'client requested stop'): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    for (const [, pending] of this.pending) {
      this.cancelTimeout(pending.timeoutHandle);
      pending.reject(new Error(`ACP transport closing: ${reason}`));
    }
    this.pending.clear();

    this.detachData?.();
    this.detachLog?.();
    this.detachClose?.();
    this.detachData = null;
    this.detachLog = null;
    this.detachClose = null;

    await this.transport.stop();
  }

  /* -----------------------------------------------------------------
   * Internals
   * ---------------------------------------------------------------*/

  private async request<TResult>(method: string, params: unknown): Promise<TResult> {
    if (this.closed) {
      throw new Error('ACP client is closed');
    }
    const id = this.nextRequestId++;
    return new Promise<TResult>((resolve, reject) => {
      const timeoutHandle = this.scheduleTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        reject(new Error(`ACP request \`${method}\` timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
        timeoutHandle,
      });

      try {
        this.transport.send(encodeJsonRpcFrame({
          jsonrpc: '2.0',
          id,
          method,
          params,
        }));
      } catch (error) {
        this.pending.delete(id);
        this.cancelTimeout(timeoutHandle);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.transport.send(encodeJsonRpcFrame({
      jsonrpc: '2.0',
      method,
      params,
    }));
  }

  private handleIncoming(chunk: Buffer): void {
    const frames = this.decoder.feed(chunk);
    for (const frame of frames) {
      if (frame.kind === 'parse-error') {
        this.callbacks.onError?.(new Error(`ACP parse error: ${frame.reason}`));
        continue;
      }
      this.dispatch(frame.payload);
    }
  }

  private dispatch(payload: unknown): void {
    if (typeof payload !== 'object' || payload === null) {
      return;
    }
    const message = payload as Record<string, unknown>;
    if (typeof message.id === 'number' && (message.result !== undefined || message.error !== undefined)) {
      this.handleResponse(message as { id: number; result?: unknown; error?: { code?: number; message?: string } });
      return;
    }
    if (typeof message.method === 'string') {
      this.handleIncomingRequest(message as {
        id?: number | string | null;
        method: string;
        params?: unknown;
      });
      return;
    }
    // Otherwise ignore.
  }

  private handleResponse(message: { id: number; result?: unknown; error?: { code?: number; message?: string } }): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    this.cancelTimeout(pending.timeoutHandle);

    if (message.error) {
      const reason = message.error.message ?? 'Agent returned an error';
      pending.reject(new Error(`ACP error (${message.error.code ?? '?'}): ${reason}`));
      return;
    }
    pending.resolve(message.result ?? {});
  }

  private handleIncomingRequest(message: {
    id?: number | string | null;
    method: string;
    params?: unknown;
  }): void {
    if (message.method === ACP_METHODS.sessionUpdate) {
      const params = message.params;
      if (typeof params === 'object' && params !== null) {
        this.callbacks.onSessionUpdate?.(params as AcpSessionUpdateNotification);
      }
      return;
    }
    if (message.method === ACP_METHODS.requestPermission && message.id !== undefined && message.id !== null) {
      const params = (message.params ?? {}) as AcpPermissionRequestParams;
      void this.respondToPermission(message.id, params);
      return;
    }
    // Unknown methods get a method-not-found response if they expect one.
    if (message.id !== undefined && message.id !== null) {
      this.transport.send(encodeJsonRpcFrame({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      }));
    }
  }

  private async respondToPermission(
    id: number | string,
    params: AcpPermissionRequestParams,
  ): Promise<void> {
    let result: AcpPermissionResult;
    try {
      const handler = this.callbacks.onPermissionRequest;
      if (handler) {
        result = await handler(params);
      } else {
        result = defaultPermissionDecision(params);
      }
    } catch (error) {
      this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      result = { outcome: { kind: 'cancelled' } };
    }
    this.transport.send(encodeJsonRpcFrame({
      jsonrpc: '2.0',
      id,
      result,
    }));
  }

  private handleClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, pending] of this.pending) {
      this.cancelTimeout(pending.timeoutHandle);
      pending.reject(new Error(`ACP transport closed: ${reason}`));
    }
    this.pending.clear();
    this.callbacks.onClose?.(reason);
  }
}

/**
 * Default permission decision used when the host has not supplied
 * UI yet: pick the first `allow_*` option, or fall back to cancel
 * if no allow option is on offer. The decision is conservative on
 * the *upstream* side of the call — the agent panel surfaces a
 * permission-request card so the user always sees what was decided.
 */
function defaultPermissionDecision(params: AcpPermissionRequestParams): AcpPermissionResult {
  const allow = params.options?.find((option) => option.kind === 'allow_once' || option.kind === 'allow_always');
  if (allow) {
    return { outcome: { kind: 'selected', optionId: allow.optionId } };
  }
  return { outcome: { kind: 'cancelled' } };
}
