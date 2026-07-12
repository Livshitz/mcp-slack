/**
 * mcp-slack `client` — the unified Slack Web API for host apps (additive; wraps slack-api.ts).
 *
 * ONE token-resolution path (mirrors streamer.ts): bot token by default, user token when
 * `useUserToken` is set (falling back to the bot token when no xoxp- user token exists).
 * Absorbs what host apps previously re-implemented (postMessage / reactions / thread reads /
 * channel + user lookups / file hydrate + download). Contact/mention resolution stays in the
 * host (it owns the contacts store) — this layer is Slack-protocol only.
 *
 * Additive: does NOT modify the outbound MCP tool contract (app.ts/routes-dm.ts). New file.
 */
import { slackApi, requireToken, optionalUserToken, downloadFileBuffer } from './slack-api.ts';

export {
  isSupportedFile, isTextFile, isAudioFile, SUPPORTED_FILE_MIMES, MAX_FILE_SIZE, MAX_AUDIO_SIZE,
  downloadFileBuffer, downloadFile, type SlackFile,
} from './slack-api.ts';
export { buildPollBlocks, type PollSpec, type PollKind, type PollOption } from './poll-blocks.ts';

/** Resolve the token to use for a call. Single source of truth for bot-vs-user selection. */
function resolveToken(useUserToken?: boolean): string {
  if (useUserToken) return optionalUserToken() ?? requireToken();
  return requireToken();
}

/** Low-level form-encoded Slack call with host-side token resolution. Errors log unless quiet. */
export async function slackPost(method: string, body: Record<string, unknown>, useUserToken?: boolean, quiet?: boolean): Promise<any> {
  const data = await slackApi<any>(resolveToken(useUserToken), method, body);
  if (!data.ok && !quiet) console.error(`[mcp-slack] ${method} failed:`, (data as any).error);
  return data;
}

export async function postMessage(channel: string, text: string, threadTs?: string, useUserToken?: boolean): Promise<string | null> {
  const body: Record<string, unknown> = { channel, text };
  if (threadTs) body.thread_ts = threadTs;
  const data = await slackPost('chat.postMessage', body, useUserToken);
  return data.ok ? data.ts : null;
}

export async function getMessage(channel: string, ts: string, useUserToken?: boolean): Promise<string | null> {
  const data = await slackPost('conversations.replies', { channel, ts, limit: 1, inclusive: true }, useUserToken);
  return data.ok ? data.messages?.[0]?.text ?? null : null;
}

export async function getThreadMessages(channel: string, ts: string, useUserToken?: boolean): Promise<{ ts?: string; user?: string; bot_id?: string; text: string }[]> {
  const data = await slackPost('conversations.replies', { channel, ts, limit: 50, inclusive: true }, useUserToken);
  return data.ok ? (data.messages ?? []) : [];
}

export async function getChannelHistory(channel: string, limit = 20, useUserToken?: boolean): Promise<{ user?: string; bot_id?: string; text: string }[]> {
  const data = await slackPost('conversations.history', { channel, limit }, useUserToken);
  return data.ok ? (data.messages ?? []).reverse() : [];
}

// ── Reactions (user-token first with bot-token fallback) ─────────────────────
const REACTION_NO_RETRY = new Set(['already_reacted', 'no_reaction', 'too_many_reactions']);

async function reactionWithFallback(method: string, params: Record<string, unknown>, useUserToken?: boolean): Promise<void> {
  const res = await slackPost(method, params, useUserToken);
  if (!res.ok && useUserToken && !REACTION_NO_RETRY.has(res.error)) {
    await slackPost(method, params, false);
  }
}

export async function addReaction(channel: string, timestamp: string, name: string, useUserToken?: boolean): Promise<void> {
  await reactionWithFallback('reactions.add', { channel, timestamp, name }, useUserToken);
}

export async function removeReaction(channel: string, timestamp: string, name: string, useUserToken?: boolean): Promise<void> {
  await reactionWithFallback('reactions.remove', { channel, timestamp, name }, useUserToken);
}

// ── Access checks (which token can see a channel/DM) ─────────────────────────
const accessCache = new Map<string, boolean>();
function makeAccessChecker(useUserToken: boolean) {
  return async (channel: string): Promise<boolean> => {
    const key = `${useUserToken ? 'u' : 'b'}:${channel}`;
    const cached = accessCache.get(key);
    if (cached !== undefined) return cached;
    const data = await slackPost('conversations.info', { channel }, useUserToken, true);
    accessCache.set(key, !!data.ok);
    return !!data.ok;
  };
}
export const canBotAccess = makeAccessChecker(false);
export const canAgentAccess = makeAccessChecker(true);

// ── Identity ─────────────────────────────────────────────────────────────────
let cachedBotUserId: string | null = null;
let cachedBotId: string | null = null;
let cachedAgentUserId: string | null = null;

export async function getBotUserId(): Promise<string> {
  if (cachedBotUserId) return cachedBotUserId;
  const data = await slackPost('auth.test', {});
  cachedBotUserId = data.user_id;
  if (data.bot_id) cachedBotId = data.bot_id;
  return cachedBotUserId!;
}

export async function getBotId(): Promise<string | null> {
  if (cachedBotId) return cachedBotId;
  await getBotUserId();
  return cachedBotId;
}

export async function getAgentUserId(): Promise<string | null> {
  if (cachedAgentUserId) return cachedAgentUserId;
  if (!optionalUserToken()) return null;
  const data = await slackPost('auth.test', {}, true);
  if (!data.ok) { console.warn('[mcp-slack] auth.test failed for user token:', data.error); return null; }
  cachedAgentUserId = data.user_id;
  console.log(`[mcp-slack] Agent user ID: ${cachedAgentUserId}`);
  return cachedAgentUserId;
}

// ── Files ──────────────────────────────────────────────────────────────────
/**
 * Hydrate a Slack file stub. The Events API delivers { id, file_access:'check_file_info' }
 * with no name/mimetype/size/url_private — the full metadata comes from files.info. Returns
 * the original object if already complete, or null if it can't be resolved. files:read may
 * live on only one token, so try the primary then fall back.
 */
export async function getFileInfo(fileId: string, useUserToken?: boolean): Promise<any | null> {
  for (const asUser of useUserToken ? [true, false] : [false, true]) {
    const data = await slackPost('files.info', { file: fileId }, asUser, true);
    if (data.ok) return data.file;
    if (data.error !== 'missing_scope' && data.error !== 'not_authed') {
      console.warn(`[mcp-slack] files.info failed for ${fileId}:`, data.error);
      return null;
    }
  }
  console.warn(`[mcp-slack] files.info failed for ${fileId}: no token has files:read`);
  return null;
}

export async function downloadSlackFileBuffer(url: string, useUserToken?: boolean, allowHtml?: boolean): Promise<Buffer> {
  const bot = requireToken();
  const user = optionalUserToken();
  const primary = useUserToken ? (user ?? bot) : bot;
  const fallback = useUserToken ? bot : user;
  return downloadFileBuffer(url, primary, fallback && fallback !== primary ? fallback : undefined, allowHtml);
}

// ── Channel names (single lookup + lazy full-list warm) ──────────────────────
const channelNameCache = new Map<string, string>();
let warmPromise: Promise<void> | null = null;
let warmTs = 0;
const WARM_TTL = 30 * 60 * 1000;

function warmChannelCache(): Promise<void> {
  if (warmPromise && Date.now() - warmTs < WARM_TTL) return warmPromise;
  warmTs = Date.now();
  warmPromise = (async () => {
    let cursor: string | undefined;
    do {
      const data = await slackPost('conversations.list', {
        types: 'public_channel,private_channel', limit: 200, ...(cursor ? { cursor } : {}),
      });
      if (!data.ok) { console.warn('[mcp-slack] conversations.list failed during cache warm:', data.error); break; }
      for (const ch of data.channels ?? []) if (ch.id && ch.name) channelNameCache.set(ch.id, ch.name);
      cursor = data.response_metadata?.next_cursor || undefined;
    } while (cursor);
  })();
  return warmPromise;
}

export async function getChannelName(channelId: string): Promise<string | null> {
  const cached = channelNameCache.get(channelId);
  if (cached) return cached;
  const data = await slackPost('conversations.info', { channel: channelId });
  const name = data.channel?.name ?? null;
  if (name) { channelNameCache.set(channelId, name); return name; }
  await warmChannelCache();
  return channelNameCache.get(channelId) ?? null;
}

// ── User profiles ────────────────────────────────────────────────────────────
export interface SlackUserProfile { name: string | null; email: string | null; title: string | null }
const userProfileCache = new Map<string, SlackUserProfile>();

export async function getUserProfile(userId: string): Promise<SlackUserProfile> {
  const cached = userProfileCache.get(userId);
  if (cached) return cached;
  const data = await slackPost('users.info', { user: userId });
  if (!data.ok) {
    console.warn(`[mcp-slack] users.info failed for ${userId}: ${data.error}`);
    return { name: null, email: null, title: null };
  }
  const profile: SlackUserProfile = {
    name: data.user?.profile?.display_name || data.user?.real_name || data.user?.name || null,
    email: data.user?.profile?.email || null,
    title: data.user?.profile?.title || null,
  };
  if (profile.name) userProfileCache.set(userId, profile);
  else console.warn(`[mcp-slack] users.info OK for ${userId} but no name found in profile`);
  return profile;
}

export async function getUserName(userId: string): Promise<string | null> {
  return (await getUserProfile(userId)).name;
}
