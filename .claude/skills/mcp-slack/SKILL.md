---
name: mcp-slack
description: >-
  Guides development and use of this Bun Slack Web API MCP: bot token, ids vs names,
  DM flow, search limitations, and spooled large responses. Use when editing this repo,
  configuring MCP/HTTP, or troubleshooting Slack API errors.
when_to_use: >-
  mcp-slack, SLACK_BOT_TOKEN, xoxb, chat.postMessage, conversations, Slack MCP,
  DM open, lookupByEmail, spool, MCP_SLACK_CACHE_DIR.
paths: "src/**/*.ts,package.json"
---

# mcp-slack

## Architecture

- **Entry**: `src/mcp/cli.ts` — `--stdio` (default in `package.json` `start`) or HTTP (`--http`, default port **3840**). MCP: `POST /mcp`; REST includes `/health`, `/slack/*`.
- **App factory**: `createSlackMcp()` in `src/app.ts`; DM/user routes in `src/routes-dm.ts`.
- **API**: `slackApi()` + `requireToken()` in `src/slack-api.ts` — **requires `SLACK_BOT_TOKEN`** with prefix **`xoxb-`** (bot). User tokens (`xoxp-`) behave as that user; comments in code describe scope needs.
- **Large JSON**: `inlineOrSpool()` (`src/spool.ts`) — over **`MCP_SLACK_SPOOL_THRESHOLD`** (default 12_000 chars), JSON is written to **`MCP_SLACK_CACHE_DIR`** (default `.mcp-slack/cache`) and the handler returns **`{ spooled: true, file, sizeBytes, summary, hint, ok }`**; otherwise the payload is returned inline.

## MCP tool names (method + path)

Router base `''`; examples:

- `get_slack_channels`, `get_slack_history_by_channel` (path `/slack/history/:channel`; pass channel id in the path)
- `get_slack_search` — query param **`q`** (not `query`)
- `post_slack_message` — body: `channel`, `text`, optional `thread_ts`, `blocks`
- `post_slack_dm_open` — body `{ "user": "U…" }`
- `get_slack_user_by_email` — query `email`

Verify with `tools/list` if names drift.

## Best practices

1. **Channels**: Posting needs real **C… / G… / D…** ids. Raw channel names or emails in `channel` **fail** — resolve via list channels or DM flow.
2. **DM flow**: `get_slack_user_by_email` (if email known) → `post_slack_dm_open` with **U…** → `post_slack_message` with returned **D…** `channel_id`.
3. **Search**: `search.messages` often needs `search:*` scopes; many bot tokens return `not_allowed_token_type` — prefer history + DMs when search is blocked.
4. **`full=true`**: Default responses use **slim** shapes from `src/slim.ts`; `full` returns raw Slack objects and may **spool** to disk.
5. **Invite bot** to private channels where you need `conversations.history`.

## Pitfalls

- Missing or wrong token type — `requireToken()` enforces **xoxb-** for documented bot behavior.
- **Path** for history: **`/slack/history/:channel`** — id must be the conversation id, not an arbitrary label.
- Spooled responses: when **`spooled: true`**, read **`file`** for full JSON (`hint` explains).
