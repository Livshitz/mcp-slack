/**
 * Block Kit builder for interactive polls / directed questions. Single source of
 * truth shared by the `/slack/poll` MCP tool (initial post) and the host app that
 * owns vote state (re-render on each vote / on close via chat.update).
 *
 * Action-id contract (host parses these): `poll:vote:<pollId>:<optIdx>` on each
 * option button, `poll:close:<pollId>` on the Close button.
 */
export type PollOption = { label: string; description?: string };
export type PollKind = 'poll' | 'question';

export interface PollSpec {
  pollId: string;
  title: string;
  options: PollOption[];
  kind: PollKind;
  multi?: boolean;        // poll: allow each user to pick multiple options
  targetUser?: string;    // question: the Slack user id (U…) being asked
}

const trunc = (s: string, n = 75) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/**
 * @param tallies per-option vote counts (index-aligned with spec.options)
 * @param voterCount number of distinct users who voted
 * @param closed render the final, button-less results view
 */
export function buildPollBlocks(
  spec: PollSpec,
  tallies: number[] = [],
  voterCount = 0,
  closed = false,
): unknown[] {
  const blocks: unknown[] = [];
  const heading =
    spec.kind === 'question'
      ? `❓ *${spec.title}*${spec.targetUser ? ` — for <@${spec.targetUser}>` : ''}`
      : `📊 *${spec.title}*`;
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: heading } });

  const total = tallies.reduce((a, b) => a + (b || 0), 0);

  if (closed) {
    const lines = spec.options.map((o, i) => {
      const c = tallies[i] || 0;
      const pct = total ? Math.round((c / total) * 100) : 0;
      return `${i + 1}. *${o.label}* — ${c} vote${c === 1 ? '' : 's'} (${pct}%)`;
    });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') || '_no options_' } });
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `🔒 Closed · ${voterCount} participant${voterCount === 1 ? '' : 's'}` }] });
    return blocks;
  }

  // Open: option buttons (chunked into rows of 5 — Slack's actions-block limit).
  const buttons = spec.options.map((o, i) => {
    const c = tallies[i] || 0;
    return {
      type: 'button',
      action_id: `poll:vote:${spec.pollId}:${i}`,
      value: String(i),
      text: { type: 'plain_text', text: trunc(c > 0 ? `${o.label} · ${c}` : o.label) },
    };
  });
  for (let i = 0; i < buttons.length; i += 5) {
    blocks.push({ type: 'actions', block_id: `pollrow:${spec.pollId}:${i}`, elements: buttons.slice(i, i + 5) });
  }

  const hint = spec.kind === 'question'
    ? '_First answer closes this._'
    : spec.multi ? '_Pick one or more. Click again to undo._' : '_Pick one. Click again to undo._';
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${hint}  ·  ${voterCount} voted` }] });

  blocks.push({
    type: 'actions',
    block_id: `pollclose:${spec.pollId}`,
    elements: [{ type: 'button', action_id: `poll:close:${spec.pollId}`, value: spec.pollId, style: 'danger', text: { type: 'plain_text', text: 'Close poll' } }],
  });
  return blocks;
}
