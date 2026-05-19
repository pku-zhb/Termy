/**
 * Glue between {@link AcpClient} and the agent panel's
 * {@link AgentEventBus}.
 *
 * Wires four things together:
 *
 *  1. **Lifecycle**: when the source starts, spawn the agent, run
 *     `initialize` + `session/new`, and emit a session-state event
 *     so the panel shows a "running" header. On stop, send
 *     `session/cancel` and tear the transport down.
 *  2. **`session/update` notifications**: pipe through
 *     {@link adaptAcpUpdate} into {@link AgentEvent}s.
 *  3. **Permissions**: emit an `permission-request` event for the
 *     panel to surface; the actual decision is auto-allow for now
 *     (configurable when the modal lands).
 *  4. **Errors / process exit**: emit `error` and `session-state`
 *     events so the user always sees something happened.
 *
 * `submitPrompt` is exposed for the host to call when the user types
 * a message into the panel input. The bus stays read-only; control
 * flow goes the other direction through this source.
 */

import type { AgentEventPublisher, AgentEventSource } from '../agentEventSource.ts';
import type { AgentSessionId } from '../agentEventTypes.ts';
import { adaptAcpUpdate, adaptStopReason } from './acpEventAdapter.ts';
import {
  AcpClient,
  type AcpClientOptions,
  type AcpTransport,
} from './acpClient.ts';
import type { AcpPermissionRequestParams, AcpPermissionResult } from './acpProtocol.ts';

export interface AcpAgentSourceOptions {
  /** Stable name used by the bus. Pick something readable, e.g. `acp:opencode`. */
  name: string;
  /** Agent display label rendered in the panel header. */
  agentLabel: string;
  /** Working directory passed to the agent's `session/new` request. */
  cwd: string;
  /**
   * Transport factory. We accept a factory rather than an instance
   * so the source can be re-started with a fresh subprocess.
   */
  transportFactory: () => AcpTransport;
  /**
   * Termy plugin info forwarded as `clientInfo` during the
   * `initialize` handshake.
   */
  clientInfo: AcpClientOptions['clientInfo'];
}

export class AcpAgentSource implements AgentEventSource {
  readonly name: string;
  private readonly agentLabel: string;
  private readonly cwd: string;
  private readonly transportFactory: () => AcpTransport;
  private readonly clientInfo: AcpClientOptions['clientInfo'];

  private client: AcpClient | null = null;
  private publish: AgentEventPublisher | null = null;
  private sessionId: AgentSessionId | null = null;
  private nextPermissionRequestId = 1;

  constructor(options: AcpAgentSourceOptions) {
    this.name = options.name;
    this.agentLabel = options.agentLabel;
    this.cwd = options.cwd;
    this.transportFactory = options.transportFactory;
    this.clientInfo = options.clientInfo;
  }

  async start(publish: AgentEventPublisher): Promise<void> {
    if (this.client) {
      // Idempotent. The bus would have stopped any previous source
      // before re-adding under the same name; this branch only fires
      // for direct callers.
      return;
    }
    this.publish = publish;
    // Allocate a stable session id immediately so any error /
    // stderr / close event emitted before `session/new` succeeds
    // still has somewhere to land in the agent panel. We deliberately
    // keep this id stable across the source's lifetime — the
    // server-assigned session id is tracked separately on the client
    // and used only for outgoing requests.
    this.sessionId = `acp:${this.name}`;

    this.publish({
      kind: 'session-state',
      sessionId: this.sessionId,
      state: 'running',
      detail: `Connecting to ${this.agentLabel}…`,
    });

    const transport = this.transportFactory();
    const client = new AcpClient({
      transport,
      clientInfo: this.clientInfo,
      callbacks: {
        onSessionUpdate: (notification) => {
          if (!this.publish || !this.sessionId) return;
          const events = adaptAcpUpdate({
            sessionId: this.sessionId,
            update: notification.update,
          });
          for (const event of events) {
            this.publish(event);
          }
        },
        onPermissionRequest: (params) => this.handlePermissionRequest(params),
        onLog: (text) => this.emitLog(text),
        onError: (error) => this.emitError(error.message),
        onClose: (reason) => this.emitClose(reason),
      },
    });
    this.client = client;

    try {
      await client.start();
    } catch (error) {
      this.emitError(`Failed to start agent: ${describe(error)}`);
      throw error;
    }

    try {
      await client.newSession(this.cwd);
    } catch (error) {
      this.emitError(`Failed to open session: ${describe(error)}`);
      throw error;
    }

    this.publish({
      kind: 'session-state',
      sessionId: this.sessionId,
      state: 'awaiting-input',
      detail: `${this.agentLabel} ready`,
    });
  }

  /**
   * Send a user prompt to the agent. Resolves when the turn ends.
   * Throws if the source has not been started.
   */
  async submitPrompt(text: string): Promise<void> {
    if (!this.client || !this.sessionId) {
      throw new Error('ACP agent source has not been started yet');
    }
    const sessionId = this.sessionId;
    const serverSessionId = this.client.sessionId;
    if (!serverSessionId) {
      throw new Error('ACP agent source has no active session');
    }

    if (this.publish) {
      this.publish({
        kind: 'session-state',
        sessionId,
        state: 'running',
        detail: 'Working',
      });
      // Echo the user's message so the transcript captures both
      // sides of the conversation.
      this.publish({
        kind: 'text',
        sessionId,
        channel: 'final',
        delta: `\n\n**You:** ${text}\n\n`,
      });
      this.publish({
        kind: 'text-done',
        sessionId,
        channel: 'final',
      });
    }

    let stopReason;
    try {
      stopReason = await this.client.prompt(serverSessionId, text);
    } catch (error) {
      this.emitError(describe(error));
      return;
    }

    if (this.publish) {
      this.publish(adaptStopReason(sessionId, stopReason));
    }
  }

  /** Send a `session/cancel` notification to the agent. */
  cancelTurn(): void {
    if (!this.client || !this.client.sessionId) return;
    this.client.cancel(this.client.sessionId);
  }

  async stop(): Promise<void> {
    if (this.client) {
      try {
        await this.client.stop('source stop');
      } catch {
        // The transport is best-effort during teardown; do not throw.
      }
    }
    if (this.publish && this.sessionId) {
      this.publish({
        kind: 'session-state',
        sessionId: this.sessionId,
        state: 'finished',
        detail: 'Disconnected',
      });
    }
    this.client = null;
    this.publish = null;
    this.sessionId = null;
  }

  /* -----------------------------------------------------------------
   * Internals
   * ---------------------------------------------------------------*/

  private handlePermissionRequest(
    params: AcpPermissionRequestParams,
  ): AcpPermissionResult {
    if (this.publish && this.sessionId) {
      const requestId = `${this.sessionId}:perm:${this.nextPermissionRequestId++}`;
      this.publish({
        kind: 'permission-request',
        sessionId: this.sessionId,
        requestId,
        toolCallId: params.toolCall?.toolCallId,
        message: params.toolCall?.title ?? 'Agent is requesting permission',
        options: (params.options ?? []).map((option) => ({
          id: option.optionId,
          label: option.name,
          kind: option.kind === 'allow_once' || option.kind === 'allow_always'
            ? 'allow-once'
            : option.kind === 'reject_once'
              ? 'deny'
              : option.kind === 'reject_always'
                ? 'deny'
                : 'allow',
        })),
      });
    }
    const allow = params.options?.find(
      (option) => option.kind === 'allow_once' || option.kind === 'allow_always',
    );
    if (allow) {
      return { outcome: { kind: 'selected', optionId: allow.optionId } };
    }
    return { outcome: { kind: 'cancelled' } };
  }

  private emitError(message: string): void {
    if (!this.publish || !this.sessionId) return;
    this.publish({
      kind: 'error',
      sessionId: this.sessionId,
      message,
    });
  }

  private emitLog(text: string): void {
    if (!this.publish || !this.sessionId) return;
    // Stderr lines feel like background diagnostics; we render them
    // as low-importance text in the thought channel so they do not
    // crowd the main reply but remain inspectable.
    this.publish({
      kind: 'text',
      sessionId: this.sessionId,
      channel: 'thought',
      delta: `${text}\n`,
    });
  }

  private emitClose(reason: string): void {
    if (!this.publish || !this.sessionId) return;
    this.publish({
      kind: 'session-state',
      sessionId: this.sessionId,
      state: 'finished',
      detail: reason,
    });
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
