/**
 * Slack Web API via fetch. Dual-token model:
 * - SLACK_BOT_TOKEN (xoxb-): posting, channel history, thread replies, users, DMs
 * - SLACK_USER_TOKEN (xoxp-): search.messages and other user-only endpoints
 */
export type SlackOk<T> = T & { ok: true };
export type SlackErr = { ok: false; error: string };
export type SlackResult<T> = SlackOk<T> | SlackErr;

export async function slackApi<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<SlackResult<T>> {
  /** Slack accepts JSON or form bodies; form is required for some args (e.g. conversations.list `limit`) to apply. */
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    params.set(k, typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));
  }
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    },
    body: params.toString(),
  });
  return res.json() as Promise<SlackResult<T>>;
}

export function requireToken(): string {
  const t = process.env.SLACK_BOT_TOKEN?.trim();
  if (!t) throw new Error('SLACK_BOT_TOKEN is not set');
  if (!t.startsWith('xoxb-'))
    throw new Error(
      'SLACK_BOT_TOKEN must be the Bot User OAuth Token (prefix xoxb-). A User token (xoxp-) posts as that human, not the app bot.',
    );
  return t;
}

export function optionalUserToken(): string | undefined {
  const t = process.env.SLACK_USER_TOKEN?.trim();
  if (!t) return undefined;
  if (!t.startsWith('xoxp-'))
    throw new Error('SLACK_USER_TOKEN must be a User OAuth Token (prefix xoxp-).');
  return t;
}

export function requireUserToken(): string {
  const t = optionalUserToken();
  if (!t) throw new Error('SLACK_USER_TOKEN is not set');
  return t;
}

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const DOC_MIMES = new Set(['application/pdf']);
// Audio (voice messages, recordings). Downloaded + passed by path — the agent transcribes
// via mcp-audio rather than inlining (the model can't ingest audio directly).
const AUDIO_MIMES = new Set(['audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/ogg', 'audio/flac']);
export const SUPPORTED_FILE_MIMES = new Set([...IMAGE_MIMES, ...DOC_MIMES, ...AUDIO_MIMES]);
export const MAX_FILE_SIZE = 5 * 1024 * 1024;
// Groq/OpenAI whisper accept up to 25MB — allow larger audio than inline image/doc.
export const MAX_AUDIO_SIZE = 25 * 1024 * 1024;

export function isAudioFile(f: { mimetype: string }): boolean {
  return AUDIO_MIMES.has(f.mimetype);
}

export interface SlackFile {
  url_private: string;
  mimetype: string;
  name: string;
  size: number;
}

export function isSupportedFile(f: SlackFile): boolean {
  if (!SUPPORTED_FILE_MIMES.has(f.mimetype)) return false;
  return f.size <= (isAudioFile(f) ? MAX_AUDIO_SIZE : MAX_FILE_SIZE);
}

export async function downloadFileBuffer(url: string, botToken: string, userToken?: string): Promise<Buffer> {
  const tokens = [botToken, ...(userToken ? [userToken] : [])];
  for (const token of tokens) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { console.warn(`[mcp-slack] File download failed (${res.status}): ${url}`); continue; }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/html')) { console.warn(`[mcp-slack] File download returned HTML (auth redirect?), retrying with next token`); continue; }
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error(`Failed to download Slack file after ${tokens.length} token attempts: ${url}`);
}

export async function downloadFile(url: string, mimeType: string, botToken: string, userToken?: string): Promise<string> {
  const buf = await downloadFileBuffer(url, botToken, userToken);
  return `data:${mimeType};base64,${buf.toString('base64')}`;
}
