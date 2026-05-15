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
