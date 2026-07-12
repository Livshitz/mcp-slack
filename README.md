# mcp-slack

MCP server for the Slack API — channels, messages, search, DMs, and reactions.

## Changelog

- **0.6.0** — Additive host-app surface (outbound MCP tool contract unchanged):
  - `src/client.ts` — unified Slack Web API for host apps (one bot-vs-user token-resolution
    path): `slackPost` / `postMessage` / reactions / thread + history reads / channel + user
    lookups / file hydrate (`getFileInfo`) + download (`downloadSlackFileBuffer`) / identity
    (`getBotUserId` / `getBotId` / `getAgentUserId`). Re-exports `buildPollBlocks` and the file
    helpers from `slack-api.ts`. Contact/mention resolution stays in the host.
  - `src/ingress.ts` — inbound Slack protocol: `registerSlackIngress(app, { onMessage,
    onInteraction, shouldRespond?, onReplied?, finalTransform? })` owning
    `/api/slack/events` + `/api/slack/interactivity`, rawBody + HMAC verify, url_verification,
    bot-echo skip, dedupe, DM identity → `useUserToken`, file hydrate, per-thread FIFO queue,
    hourglass reaction lifecycle, and SlackStreamer wiring. `onMessage` returns
    `AsyncIterable<AgentEvent>` (`text_delta` / `tool_use` / `tool_result` / `done` / `error`);
    the package pipes it through its own `SlackStreamer`. Also exports `pipeAgentReply` (reuse
    the streamer wiring from a host recovery path) and `mdToMrkdwn`.

## Usage

```bash
bun run src/mcp/cli.ts --stdio     # stdio mode (for MCP integration)
bun run src/mcp/cli.ts --port 3840 # HTTP mode
```

## Add to your MCP host

Wire the server into an MCP host (Claude Code, Cursor, …) by adding it to your `.mcp.json` (or run `claude mcp add`):

```json
{ "mcpServers": { "slack": { "command": "bunx", "args": ["mcp-slack", "--stdio"], "env": { "SLACK_BOT_TOKEN": "xoxb-..." } } } }
```

## Env Vars

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Bot token (`xoxb-...`) for posting, history, threads |
| `SLACK_USER_TOKEN` | No | User token (`xoxp-...`) for `search.messages` (user-token-only endpoint) |
| `MCP_SLACK_SPOOL_THRESHOLD` | No | Chars before spooling to disk (default: 12000) |
| `MCP_SLACK_CACHE_DIR` | No | Cache directory (default: `.mcp-slack/cache`) |

## Tools

| Tool | Method | Description |
|------|--------|-------------|
| `/slack/message` | POST | Post message to channel/DM (C/G/D id) |
| `/slack/channels` | GET | List channels (public, private, DMs) |
| `/slack/history/:channel` | GET | Get channel message history |
| `/slack/search` | GET | Search messages (prefers user token) |
| `/slack/users` | GET | List workspace users |
| `/slack/user/by-email` | GET | Find user by email |
| `/slack/dm/open` | POST | Open DM with a user (returns D... channel id) |

## DM Flow

1. `GET /slack/users` or `GET /slack/user/by-email` → get user ID (`U...`)
2. `POST /slack/dm/open` with user ID → get DM channel ID (`D...`)
3. `POST /slack/message` with `channel: "D..."` and `text`

## Notes

- All Slack API calls use `application/x-www-form-urlencoded` (not JSON)
- Large results spool to `.mcp-slack/cache/` with file path in response
- Default responses use slim payloads; pass `full=true` for raw Slack JSON
- Search auto-prefers user token when `SLACK_USER_TOKEN` is set

## Architecture

Built on `edge.libx.js` RouterWrapper + `describeMCP`. Dual-mode: stdio or HTTP. Includes channel caching (5min TTL) and result spooling.
