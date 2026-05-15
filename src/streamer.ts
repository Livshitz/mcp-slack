/**
 * SlackStreamer — progressive message streaming via chat.startStream/appendStream/stopStream.
 * Falls back to chat.postMessage for flat messages (no thread_ts).
 */
import { slackApi, requireToken, optionalUserToken } from './slack-api.ts';

export interface SlackStreamerOptions {
  channel: string;
  threadTs?: string;
  useUserToken?: boolean;
  recipientUserId?: string;
  recipientTeamId?: string;
  /** Transform text before sending to Slack (e.g. markdown → mrkdwn). Applied per-flush and on final stop. */
  transform?: (text: string) => string;
  /** Async transform on final text (e.g. resolve user mentions). Runs on finish(). */
  finalTransform?: (text: string) => Promise<string>;
  /** Buffer flush interval in ms (default 600) */
  flushInterval?: number;
  /** Buffer size threshold in chars before auto-flush (default 200) */
  flushThreshold?: number;
}

export class SlackStreamer {
  private channel: string;
  private threadTs?: string;
  private token: string;
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
  private recipientUserId?: string;
  private recipientTeamId?: string;

  /** Message timestamp — available after first text is fed (and startStream resolves). */
  public ts: string | null = null;

  /** True when streaming isn't possible (no thread_ts) — falls back to postMessage. */
  public readonly flat: boolean;

  constructor(private options: SlackStreamerOptions) {
    this.channel = options.channel;
    this.threadTs = options.threadTs;
    this.token = options.useUserToken
      ? (optionalUserToken() ?? requireToken())
      : requireToken();
    this.transform = options.transform ?? ((t) => t);
    this.finalTransform = options.finalTransform;
    this.flushInterval = options.flushInterval ?? 600;
    this.flushThreshold = options.flushThreshold ?? 200;
    this.recipientUserId = options.recipientUserId;
    this.recipientTeamId = options.recipientTeamId;
    this.flat = !options.threadTs;
  }

  /** Feed a streaming event. Call for each text_delta or tool_use. */
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
        this._scheduleFlush(0);
      } else {
        this._scheduleFlush(this.flushInterval);
      }
    } else if (ev.type === 'tool_use' && ev.tool) {
      if (this.flat) return;
      this._scheduleFlush(0);
      this._appendToolUpdate(ev.tool);
    }
  }

  /** Finalize the stream. Returns the message ts, or null if nothing was sent. */
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

    // Streaming failed (e.g. bot tokens can't use startStream) — fall back to postMessage
    if (!this.ts) {
      return this._postMessage(finalMrkdwn);
    }

    // Flush remaining buffer
    await this._flush();

    const res = await slackApi<{ ok: boolean }>(this.token, 'chat.stopStream', {
      channel: this.channel,
      ts: this.ts,
      markdown_text: finalMrkdwn,
    });
    if (!res.ok) {
      console.error('[slack-streamer] stopStream failed:', (res as any).error);
    }
    return this.ts;
  }

  /** Abort the stream without finalizing. */
  abort(): void {
    this.aborted = true;
    this._clearTimer();
    if (this.started && this.ts) {
      slackApi(this.token, 'chat.stopStream', {
        channel: this.channel,
        ts: this.ts,
        markdown_text: '⚠️ Aborted',
      }).catch((err) => console.error('[slack-streamer] abort stopStream failed:', err));
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async _start(): Promise<void> {
    const payload: Record<string, unknown> = {
      channel: this.channel,
      thread_ts: this.threadTs,
    };
    if (this.recipientUserId) payload.recipient_user_id = this.recipientUserId;
    if (this.recipientTeamId) payload.recipient_team_id = this.recipientTeamId;

    const res = await slackApi<{ ts?: string }>(this.token, 'chat.startStream', payload);
    if (!res.ok) {
      console.error('[slack-streamer] startStream failed:', (res as any).error);
      return;
    }
    this.ts = (res as any).ts ?? null;
  }

  private _scheduleFlush(delay: number): void {
    this._clearTimer();
    if (delay === 0) {
      this._flush();
      return;
    }
    this.timer = setTimeout(() => this._flush(), delay);
  }

  private async _flush(): Promise<void> {
    this._clearTimer();
    if (!this.buffer || this.aborted) return;
    if (this.startPromise) await this.startPromise;
    if (!this.ts) return;

    const chunk = this.transform(this.buffer);
    this.buffer = '';

    await slackApi(this.token, 'chat.appendStream', {
      channel: this.channel,
      ts: this.ts,
      markdown_text: chunk,
    }).catch((err) => console.error('[slack-streamer] appendStream failed:', err));
  }

  private async _appendToolUpdate(tool: string): Promise<void> {
    if (this.startPromise) await this.startPromise;
    if (!this.ts || this.aborted) return;

    const label = tool.length > 250 ? tool.slice(0, 250) + '…' : tool;
    await slackApi(this.token, 'chat.appendStream', {
      channel: this.channel,
      ts: this.ts,
      chunks: [{ type: 'task_update', text: label }],
    }).catch((err) => console.error('[slack-streamer] task_update failed:', err));
  }

  private async _postMessage(text: string): Promise<string | null> {
    const payload: Record<string, unknown> = { channel: this.channel, text };
    if (this.threadTs) payload.thread_ts = this.threadTs;
    const res = await slackApi<{ ts?: string }>(this.token, 'chat.postMessage', payload);
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
