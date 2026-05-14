import { json } from 'itty-router';
import { RouterWrapper } from 'edge.libx.js/build/main.js';
import { requireToken, slackApi } from './slack-api.ts';
import { slimUsers } from './slim.ts';
import { inlineOrSpool } from './spool.ts';

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** DM open + email lookup (scopes: im:write, users:read.email). */
export function registerDmUserRoutes(base: RouterWrapper) {
  const { router } = base;

  base.describeMCP('/slack/dm/open', 'POST', {
    description:
      'Open or resume a 1:1 DM. Body.user must be member ID U…. Returns channel_id (D…); use it as channel in post_slack_message. Needs im:write.',
    params: {
      body: {
        description: '{ "user": "U0123ABCD" }',
        type: 'object',
      },
    },
  });
  router.post('/slack/dm/open', async (req) => {
    try {
      const token = requireToken();
      const body = (await req.json()) as Record<string, unknown>;
      const user = body.user;
      if (typeof user !== 'string' || !user.startsWith('U'))
        return json(
          { ok: false, error: 'body.user must be a Slack member id (U…)' },
          { status: 400 },
        );
      const data = await slackApi<{ channel?: { id?: string } }>(
        token,
        'conversations.open',
        { users: user },
      );
      if (!data.ok) return json(data, { status: 400 });
      return json({
        ok: true,
        channel_id: data.channel?.id,
        _hint: 'post_slack_message with channel = channel_id',
      });
    } catch (e) {
      return json({ ok: false, error: errMessage(e) }, { status: 500 });
    }
  });

  base.describeMCP('/slack/user/by-email', 'GET', {
    description:
      'Resolve U… from work email (users.lookupByEmail). Needs users:read.email. Then call post_slack_dm_open with user.',
    params: {
      email: { description: 'Email', type: 'string', required: true },
    },
    annotations: { readOnlyHint: true },
  });
  router.get('/slack/user/by-email', async (req) => {
    try {
      const token = requireToken();
      const email =
        (() => {
          const q = req.query?.email;
          if (q !== undefined && q !== null && String(q) !== '') return String(q).trim();
          try {
            return new URL(req.url, 'http://_').searchParams.get('email')?.trim();
          } catch {
            return undefined;
          }
        })();
      if (!email) return json({ ok: false, error: 'email is required' }, { status: 400 });
      const data = await slackApi<{ user?: { id?: string; name?: string; profile?: { email?: string } } }>(
        token,
        'users.lookupByEmail',
        { email },
      );
      if (!data.ok) return json(data, { status: 400 });
      return json({
        ok: true,
        user_id: data.user?.id,
        name: data.user?.name,
        _hint: 'post /slack/dm/open with body { user: user_id }, then post_slack_message',
      });
    } catch (e) {
      return json({ ok: false, error: errMessage(e) }, { status: 500 });
    }
  });

  base.describeMCP('/slack/users', 'GET', {
    description:
      'List workspace members (users.list). Search by name/display_name with q param (case-insensitive substring match). Use this when you don\'t know a user\'s email. Needs users:read scope.',
    params: {
      q: { description: 'Filter by name/display_name (substring, case-insensitive)', type: 'string' },
      limit: { description: 'Max users per page (default 100, max 200)', type: 'string' },
      cursor: { description: 'Pagination cursor', type: 'string' },
    },
    annotations: { readOnlyHint: true },
  });
  router.get('/slack/users', async (req) => {
    try {
      const token = requireToken();
      const q = (() => {
        const v = req.query?.q;
        if (v !== undefined && v !== null && String(v) !== '') return String(v).trim().toLowerCase();
        try { return new URL(req.url, 'http://_').searchParams.get('q')?.trim().toLowerCase() || undefined; } catch { return undefined; }
      })();
      const limit = Math.min(200, Math.max(1, parseInt((() => {
        const v = req.query?.limit;
        if (v !== undefined && v !== null && String(v) !== '') return String(v);
        try { return new URL(req.url, 'http://_').searchParams.get('limit') ?? '100'; } catch { return '100'; }
      })(), 10) || 100));
      const cursor = (() => {
        const v = req.query?.cursor;
        if (v !== undefined && v !== null && String(v) !== '') return String(v);
        try { return new URL(req.url, 'http://_').searchParams.get('cursor') ?? undefined; } catch { return undefined; }
      })();

      const data = await slackApi<{
        members?: Record<string, unknown>[];
        response_metadata?: { next_cursor?: string };
      }>(token, 'users.list', { limit, ...(cursor ? { cursor } : {}) });
      if (!data.ok) return json(data, { status: 400 });

      let users = slimUsers(data.members ?? []);
      if (q) {
        users = users.filter((u) => {
          const fields = [u.name, u.real_name, u.display_name, u.email].filter(Boolean).map((s) => String(s).toLowerCase());
          return fields.some((f) => f.includes(q));
        });
      }

      const result = {
        ok: true,
        users,
        response_metadata: data.response_metadata,
      };
      return json(inlineOrSpool('get_slack_users', result));
    } catch (e) {
      return json({ ok: false, error: errMessage(e) }, { status: 500 });
    }
  });
}
