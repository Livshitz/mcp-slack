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
  useUserToken?: boolean;
  transform?: (text: string) => string;
  finalTransform?: (text: string) => Promise<string>;
  flushInterval?: number;
  flushThreshold?: number;
}

export class SlackStreamer {
  private channel: string;
  private threadTs?: string;
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

  public ts: string | null = null;
  public readonly flat: boolean;

  constructor(private options: SlackStreamerOptions) {
    this.channel = options.channel;
    this.threadTs = options.threadTs;
    this.botToken = requireToken();
    this.postToken = options.useUserToken
      ? (optionalUserToken() ?? this.botToken)
      : this.botToken;
    this.transform = options.transform ?? ((t) => t);
    this.finalTransform = options.finalTransform;
    this.flushInterval = options.flushInterval ?? 300;
    this.flushThreshold = options.flushThreshold ?? 30;
    this.flat = !options.threadTs;
  }

  feed(ev: { type: string; text?: string; tool?: string }): void {
    if (this.aborted) return;

    if (ev.type === 'text_delta' && ev.text) {
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

    const stopPayload: Record<string, unknown> = { channel: this.channel, ts: this.ts };
    if (resolvedText !== this.fullText) {
      stopPayload.markdown_text = finalMrkdwn;
    }
    const res = await slackApi<{ ok: boolean }>(this.botToken, 'chat.stopStream', stopPayload);
    if (!res.ok) {
      console.error('[slack-streamer] stopStream failed:', (res as any).error);
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
      recipient_user_id: auth.botUserId,
    });
    if (!res.ok) {
      console.error('[slack-streamer] startStream failed:', (res as any).error);
      return;
    }
    this.ts = (res as any).ts ?? null;
  }

  /** Snapshot the buffer now, enqueue the actual HTTP send onto the chain. */
  private _enqueueFlush(): void {
    this._clearTimer();
    if (!this.buffer) return;
    const snapshot = this.transform(this.buffer);
    this.buffer = '';
    this.flushChain = this.flushChain.then(() => this._sendChunk(snapshot));
  }

  private _enqueueToolUpdate(tool: string): void {
    this.flushChain = this.flushChain.then(() => this._doToolUpdate(tool));
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

  /** Flush any remaining buffer (used by finish). */
  private _flushRemaining(): void {
    if (!this.buffer) return;
    const snapshot = this.transform(this.buffer);
    this.buffer = '';
    this.flushChain = this.flushChain.then(() => this._sendChunk(snapshot));
  }

  private async _doToolUpdate(tool: string): Promise<void> {
    if (this.startPromise) await this.startPromise;
    if (!this.ts || this.aborted) return;

    const label = tool.length > 250 ? tool.slice(0, 250) + '…' : tool;
    const res = await slackApi(this.botToken, 'chat.appendStream', {
      channel: this.channel,
      ts: this.ts,
      chunks: [{ type: 'task_update', text: label }],
    });
    if (!res.ok) console.error('[slack-streamer] task_update failed:', (res as any).error);
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
