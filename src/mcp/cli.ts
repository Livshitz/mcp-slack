#!/usr/bin/env bun
import { createSlackMcp } from '../app.ts';

const argv = process.argv.slice(2);
const isStdio = argv.includes('--stdio');
const portIdx = argv.indexOf('--port');
const port =
  portIdx >= 0 ? parseInt(argv[portIdx + 1] ?? '3840', 10) || 3840 : 3840;

const { mcp, httpFetch } = createSlackMcp();

if (isStdio) {
  await mcp.serveStdio();
} else {
  const server = Bun.serve({ port, fetch: httpFetch });
  console.error(`[mcp-slack] http+mcp listening on http://127.0.0.1:${server.port}`);
  console.error(`[mcp-slack] MCP JSON-RPC: POST http://127.0.0.1:${server.port}/mcp`);
  console.error(`[mcp-slack] REST: GET /health, /slack/channels, …`);
}
