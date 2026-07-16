---
name: mcp-slack-use
description: >-
  Guides development and use of this Bun Slack Web API MCP: bot token, ids vs names,
  DM flow, search limitations, and spooled large responses. Use when editing this repo,
  configuring MCP/HTTP, or troubleshooting Slack API errors.
when_to_use: >-
  mcp-slack-use, SLACK_BOT_TOKEN, xoxb, chat.postMessage, conversations, Slack MCP,
  DM open, lookupByEmail, spool, MCP_SLACK_CACHE_DIR.
paths: "src/**/*.ts,package.json"
---

# mcp-slack-use

## Architecture

- **Entry**: `src/mcp/cli.ts` — `--stdio` (default in `package.json` `start`) or HTTP (`--http`, default port **3840**). MCP: `POST /mcp`; REST includes `/health`, `/slack/*`.
- **App factory**: `createSlackMcp()` in `src/app.ts`; DM/user routes in `src/routes-dm.ts`. When embedding in short-lived Bun scripts with `SLACK_USER_TOKEN`, call `await mcp.close()` when done so the internal presence ping interval cannot keep the process alive.
- **API**: `slackApi()` in `src/slack-api.ts` — dual-token: `requireToken()` for bot (`SLACK_BOT_TOKEN`, `xoxb-`), `optionalUserToken()` for user (`SLACK_USER_TOKEN`, `xoxp-`). Search auto-prefers user token when set.
- **Large JSON**: `inlineOrSpool()` (`src/spool.ts`) — over **`MCP_SLACK_SPOOL_THRESHOLD`** (default 12_000 chars), JSON is written to **`MCP_SLACK_CACHE_DIR`** (default `.mcp-slack/cache`) and the handler returns **`{ spooled: true, file, sizeBytes, summary, hint, ok }`**; otherwise the payload is returned inline.

## MCP tool names (method + path)

Router base `''`; examples:

- `get_slack_channels`, `get_slack_history_by_channel` (path `/slack/history/:channel`; pass channel id in the path)
- `get_slack_thread` — path `/slack/thread/:channel/:ts`; fetches thread replies
- `get_slack_search` — query param **`q`** (not `query`); uses `SLACK_USER_TOKEN` when available
- `post_slack_message` — body: `channel`, `text`, optional `thread_ts`, `blocks`. Returns `{ channel, ts }` — keep `ts` to later edit/delete.
- `post_slack_update` — **edit a message this app posted** (`chat.update`). Body: `{ channel, ts, text?, blocks?, as_user? }` (at least one of text/blocks). Works for messages authored by **either** the bot (xoxb) **or** the agent's user account (xoxp) — it auto-tries both tokens, so `as_user` is rarely needed. Cannot edit other people's messages. Prefer editing over posting a "Correction:" follow-up.
- `post_slack_delete` — delete a message this app posted (`chat.delete`). Body: `{ channel, ts, as_user? }`. Same dual-token auto-fallback as update.
- `post_slack_files` — upload local files to a channel/thread. Body: `{ channel, files: [{path, filename?}], thread_ts?, initial_comment? }`. Requires `files:write` bot scope.
- `post_slack_poll` — post an interactive poll or directed question (clickable option buttons + live tally + Close button). Body: `{ channel, title, options: [{label, description?}] (2-10), kind?: "poll"|"question", multi?, target_user? (U…, question only), deadline_minutes?, quorum?, thread_ts? }`. Returns `{ pollId, ts, channel, … }`. **Requires a host that owns vote state + a Slack interactivity Request URL** (in unclaw: votes are tracked server-side and the creating agent is woken with the tally on close — deadline/quorum/manual for polls, first answer for questions). Posting it standalone (no host) renders buttons but clicks won't be recorded.
- `post_slack_dm_open` — body `{ "user": "U…" }`
- `get_slack_user_by_email` — query `email`

Verify with `tools/list` if names drift.

## Best practices

1. **Channels**: Posting needs real **C… / G… / D…** ids. Raw channel names or emails in `channel` **fail** — resolve via list channels or DM flow.
2. **DM flow**: `get_slack_user_by_email` (if email known) → `post_slack_dm_open` with **U…** → `post_slack_message` with returned **D…** `channel_id`.
3. **Search**: requires `SLACK_USER_TOKEN` (`xoxp-`); bot tokens return `not_allowed_token_type`. Falls back to bot token when user token is not set.
4. **`full=true`**: Default responses use **slim** shapes from `src/slim.ts`; `full` returns raw Slack objects and may **spool** to disk.
5. **Invite bot** to private channels where you need `conversations.history`.

## Pitfalls

- Missing or wrong token type — `requireToken()` enforces **xoxb-** for bot; `optionalUserToken()` enforces **xoxp-** for user token when set.
- **Path** for history: **`/slack/history/:channel`** — id must be the conversation id, not an arbitrary label.
- Spooled responses: when **`spooled: true`**, read **`file`** for full JSON (`hint` explains).
