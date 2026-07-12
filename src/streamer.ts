/**
 * SlackStreamer — progressive message streaming via chat.startStream/appendStream/stopStream.
 * Falls back to chat.postMessage for flat messages (no thread_ts) or user-token sessions.
 * Note: startStream only works with bot tokens — user tokens get not_allowed_token_type.
 */
import { slackApi, requireToken, optionalUserToken } from './slack-api.ts';

let cachedAuthInfo: { teamId: string; botUserId: string } | null = null;

async function getAuthInfo(token: string): Promise<{ teamId: string; botUserId: string }> {
  if (cachedAuthInfo) return cachedAuthInfo;
  const res = await slackApi<{ team_id?: string; user_id?: string }>(token, 'auth.test', {});
  if (!res.ok) throw new Error(`auth.test failed: ${(res as any).error}`);
  cachedAuthInfo = { teamId: (res as any).team_id, botUserId: (res as any).user_id };
  return cachedAuthInfo;
}

export interface SlackStreamerOptions {
  channel: string;
  threadTs?: string;
  recipientUserId?: string;
  useUserToken?: boolean;
  transform?: (text: string) => string;
  finalTransform?: (text: string) => Promise<string>;
  flushInterval?: number;
  flushThreshold?: number;
  /** Opt in to `task_update` tool-progress chunks. Off by default — see `taskUpdatesDisabled`. */
  taskUpdates?: boolean;
}

export class SlackStreamer {
  private channel: string;
  private threadTs?: string;
  private recipientUserId?: string;
  private botToken: string;
  private postToken: string;
  private transform: (t: string) => string;
  private finalTransform?: (t: string) => Promise<string>;
  private flushInterval: number;
  private flushThreshold: number;

  private buffer = '';
  private fullText = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private aborted = false;
  private startPromise: Promise<void> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private afterTool = false;
  private taskSeq = 0;
  // Disabled by default: interleaving `task_update` chunks with `markdown_text` appends on the same
  // stream makes Slack reject the mode switch (`streaming_mode_mismatch`), which drops the message out
  // of streaming state → every subsequent `appendStream` fails `message_not_in_streaming_state`. Keep
  // the stream pure-text until per-stream mode handling exists. Opt back in via `taskUpdates: true`.
  private taskUpdatesDisabled: boolean;

  public ts: string | null = null;
  public readonly flat: boolean;

  constructor(options: SlackStreamerOptions) {
    this.channel = options.channel;
    this.threadTs = options.threadTs;
    this.recipientUserId = options.recipientUserId;
    this.botToken = requireToken();
    this.postToken = options.useUserToken
      ? (optionalUserToken() ?? this.botToken)
      : this.botToken;
    this.transform = options.transform ?? ((t) => t);
    this.finalTransform = options.finalTransform;
    this.flushInterval = options.flushInterval ?? 300;
    this.flushThreshold = options.flushThreshold ?? 30;
    this.taskUpdatesDisabled = !options.taskUpdates;
    this.flat = !options.threadTs;
  }

  feed(ev: { type: string; text?: string; tool?: string }): void {
    if (this.aborted) return;

    if (ev.type === 'text_delta' && ev.text) {
      if (this.afterTool) {
        this.buffer += '\n';
        this.fullText += '\n';
        this.afterTool = false;
      }
      this.buffer += ev.text;
      this.fullText += ev.text;
      if (this.flat) return;

      if (!this.started) {
        this.started = true;
        this.startPromise = this._start();
      }
      if (this.buffer.length >= this.flushThreshold) {
        this._enqueueFlush();
      } else {
        this._scheduleTimer();
      }
    } else if (ev.type === 'tool_use' && ev.tool) {
      this.afterTool = true;
      if (this.flat) return;
      this._enqueueFlush();
      this._enqueueToolUpdate(ev.tool);
    }
  }

  async finish(): Promise<string | null> {
    if (this.aborted) return null;
    this._clearTimer();

    const resolvedText = this.finalTransform
      ? await this.finalTransform(this.fullText)
      : this.fullText;
    const finalMrkdwn = this.transform(resolvedText);

    if (!finalMrkdwn.trim()) return null;

    if (this.flat) {
      return this._postMessage(finalMrkdwn);
    }

    if (this.startPromise) await this.startPromise;

    if (!this.ts) {
      return this._postMessage(finalMrkdwn);
    }

    // Flush remaining buffer and wait for all sends to complete
    this._flushRemaining();
    await this.flushChain;

    // Stop the stream first (without markdown_text — it appends, not replaces)
    const stopRes = await slackApi<{ ok: boolean }>(this.botToken, 'chat.stopStream', {
      channel: this.channel,
      ts: this.ts,
    });
    if (!stopRes.ok) {
      console.error('[slack-streamer] stopStream failed:', (stopRes as any).error);
    }

    // Then update the message with the final transformed text
    const updateRes = await slackApi<{ ok: boolean }>(this.postToken, 'chat.update', {
      channel: this.channel,
      ts: this.ts,
      text: finalMrkdwn,
    });
    if (!updateRes.ok) {
      console.error('[slack-streamer] chat.update failed:', (updateRes as any).error);
    }
    return this.ts;
  }

  abort(): void {
    this.aborted = true;
    this._clearTimer();
    if (this.started && this.ts) {
      slackApi(this.botToken, 'chat.stopStream', {
        channel: this.channel,
        ts: this.ts,
        markdown_text: '⚠️ Aborted',
      }).catch((err) => console.error('[slack-streamer] abort stopStream failed:', err));
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async _start(): Promise<void> {
    const auth = await getAuthInfo(this.botToken);
    const res = await slackApi<{ ts?: string }>(this.botToken, 'chat.startStream', {
      channel: this.channel,
      thread_ts: this.threadTs,
      recipient_team_id: auth.teamId,
      recipient_user_id: this.recipientUserId ?? auth.botUserId,
    });
    if (!res.ok) {
      console.error('[slack-streamer] startStream failed:', (res as any).error);
      return;
    }
    this.ts = (res as any).ts ?? null;
  }

  /** Snapshot the buffer now, enqueue the actual HTTP send onto the chain.
   *  Chunks are sent as raw text — transform runs only on the final stopStream. */
  private _enqueueFlush(): void {
    this._clearTimer();
    if (!this.buffer) return;
    const snapshot = this.buffer;
    this.buffer = '';
    this.flushChain = this.flushChain
      .then(() => this._sendChunk(snapshot))
      .catch((err) => console.error('[slack-streamer] flush error:', err));
  }

  private _enqueueToolUpdate(tool: string): void {
    this.flushChain = this.flushChain
      .then(() => this._doToolUpdate(tool))
      .catch((err) => console.error('[slack-streamer] tool update error:', err));
  }

  private _scheduleTimer(): void {
    this._clearTimer();
    this.timer = setTimeout(() => this._enqueueFlush(), this.flushInterval);
  }

  private async _sendChunk(chunk: string): Promise<void> {
    if (!chunk || this.aborted) return;
    if (this.startPromise) await this.startPromise;
    if (!this.ts) return;

    const res = await slackApi(this.botToken, 'chat.appendStream', {
      channel: this.channel,
      ts: this.ts,
      markdown_text: chunk,
    });
    if (!res.ok) console.error('[slack-streamer] appendStream failed:', (res as any).error);
  }

  private _flushRemaining(): void {
    if (!this.buffer) return;
    const snapshot = this.buffer;
    this.buffer = '';
    this.flushChain = this.flushChain
      .then(() => this._sendChunk(snapshot))
      .catch((err) => console.error('[slack-streamer] flush error:', err));
  }

  private async _doToolUpdate(tool: string): Promise<void> {
    if (this.startPromise) await this.startPromise;
    if (!this.ts || this.aborted || this.taskUpdatesDisabled) return;

    // Slack's task_update chunk schema is { type, id, title, status, details?, output? } — NOT { text }.
    // The 256-char cap applies to task_update/plan_update chunks.
    // https://docs.slack.dev/reference/methods/chat.appendStream/
    const title = tool.length > 250 ? tool.slice(0, 250) + '…' : tool;
    const res = await slackApi(this.botToken, 'chat.appendStream', {
      channel: this.channel,
      ts: this.ts,
      chunks: [{ type: 'task_update', id: `t${++this.taskSeq}`, title, status: 'in_progress' }],
    });
    if (!res.ok) {
      const err = (res as any).error;
      // Feature-detect: a schema/param rejection means this stream will never accept task_update
      // chunks — disable it so we don't log the same error on every tool call (the stream itself keeps
      // working via text appends). Transient errors (rate limits, 5xx) are left to retry next tool.
      if (err === 'invalid_arguments' || err === 'invalid_blocks') {
        this.taskUpdatesDisabled = true;
        console.error('[slack-streamer] task_update unsupported for this stream, disabling:', err);
      } else {
        console.error('[slack-streamer] task_update failed:', err);
      }
    }
  }

  private async _postMessage(text: string): Promise<string | null> {
    const payload: Record<string, unknown> = { channel: this.channel, text };
    if (this.threadTs) payload.thread_ts = this.threadTs;
    const res = await slackApi<{ ts?: string }>(this.postToken, 'chat.postMessage', payload);
    if (!res.ok) {
      console.error('[slack-streamer] postMessage fallback failed:', (res as any).error);
      return null;
    }
    this.ts = (res as any).ts ?? null;
    return this.ts;
  }

  private _clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
