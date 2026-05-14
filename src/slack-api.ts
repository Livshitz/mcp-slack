/**
 * Slack Web API via fetch. Must be Bot User OAuth Token (xoxb-…). User tokens (xoxp-…) act as that user.
 * Typical scopes: chat:write, channels:history, channels:read, groups:history, groups:read,
 * im:history, im:write (conversations.open for DMs), mpim:history,
 * users:read.email (users.lookupByEmail), search:* (search.messages; often restricted on bot tokens).
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
