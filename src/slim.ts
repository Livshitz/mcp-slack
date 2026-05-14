/** Trim Slack API payloads so defaults stay small in the model context. */

export function slimChannels(data: {
  ok: boolean;
  channels?: Record<string, unknown>[];
  response_metadata?: unknown;
}) {
  return {
    ok: data.ok,
    channels: (data.channels ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      is_private: !!c.is_private,
      is_member: c.is_member,
      num_members: c.num_members,
    })),
    response_metadata: data.response_metadata,
  };
}

export function slimHistory(data: {
  ok: boolean;
  messages?: Record<string, unknown>[];
  has_more?: boolean;
  response_metadata?: unknown;
}) {
  return {
    ok: data.ok,
    messages: (data.messages ?? []).map((m) => ({
      ts: m.ts,
      user: m.user,
      text: m.text,
      subtype: m.subtype,
      thread_ts: m.thread_ts,
      type: m.type,
    })),
    has_more: data.has_more,
    response_metadata: data.response_metadata,
  };
}

export function slimUsers(members: Record<string, unknown>[]) {
  return members.map((u) => {
    const profile = (u.profile ?? {}) as Record<string, unknown>;
    return {
      id: u.id,
      name: u.name,
      real_name: u.real_name || profile.real_name,
      display_name: profile.display_name || undefined,
      email: profile.email || undefined,
      is_bot: !!u.is_bot,
      deleted: !!u.deleted,
    };
  }).filter((u) => !u.is_bot && !u.deleted);
}

export function slimSearch(data: {
  ok: boolean;
  messages?: { matches?: Record<string, unknown>[]; pagination?: unknown };
}) {
  const matches = data.messages?.matches ?? [];
  return {
    ok: data.ok,
    messages: {
      matches: matches.map((m) => ({
        channel: m.channel,
        ts: m.ts,
        text: m.text,
        user: m.user,
        permalink: m.permalink,
      })),
      pagination: data.messages?.pagination,
    },
  };
}
