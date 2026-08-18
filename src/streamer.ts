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
  /** Show a transient inline marker for each tool the agent calls, streamed in-band. Default on. */
  toolMarkers?: boolean;
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
  private toolMarkers: boolean;

  private lastFinalizedTs: string | null = null;

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
    this.toolMarkers = options.toolMarkers ?? true;
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

    if (!finalMrkdwn.trim()) return this.lastFinalizedTs;

    if (this.flat) {
      return this._postMessage(finalMrkdwn);
    }

    if (this.startPromise) await this.startPromise;

    if (!this.ts) {
      return this._postMessage(finalMrkdwn);
    }

    return this._finalizeCurrent(finalMrkdwn);
  }

  /**
   * Close the message in flight and start a fresh one for whatever follows. Call this before the
   * host posts its OWN message mid-turn (e.g. an interactive question form): otherwise the rest of
   * the reply keeps appending to the earlier message, i.e. ABOVE that form, which reads as the
   * agent answering before it asked. No-op when nothing has been streamed yet.
   */
  async cut(): Promise<void> {
    if (this.aborted || this.flat) return;
    this._clearTimer();
    if (this.startPromise) await this.startPromise;
    if (!this.ts) return;
    const text = this.finalTransform ? await this.finalTransform(this.fullText) : this.fullText;
    await this._finalizeCurrent(this.transform(text));
    this.ts = null;
    this.started = false;
    this.startPromise = null;
    this.buffer = '';
    this.fullText = '';
    this.afterTool = false;
  }

  /** stopStream + chat.update the in-flight message with its final text. Assumes this.ts is set. */
  private async _finalizeCurrent(finalMrkdwn: string): Promise<string | null> {
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
    this.lastFinalizedTs = this.ts;
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
    if (!this.ts || this.aborted || !this.toolMarkers) return;

    // Tool progress is streamed IN-BAND as a `markdown_text` append — the SAME stream mode as the
    // text chunks. Do NOT use `task_update`/`plan_update` structured chunks here: Slack treats a stream
    // as single-mode, so a chunk append after markdown_text is rejected with `streaming_mode_mismatch`,
    // which drops the message out of streaming state and breaks every later append. The marker is
    // transient — `finish()` replaces the whole message with the clean transformed text via chat.update.
    const title = tool.length > 200 ? tool.slice(0, 200) + '…' : tool;
    const res = await slackApi(this.botToken, 'chat.appendStream', {
      channel: this.channel,
      ts: this.ts,
      markdown_text: `\n\n_🔧 ${title}_\n\n`,
    });
    if (!res.ok) console.error('[slack-streamer] tool marker failed:', (res as any).error);
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
