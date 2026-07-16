import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DEFAULT_DIR = '.mcp-slack-use/cache';

export function spoolThreshold(): number {
  // MCP_SLACK_SPOOL_THRESHOLD is the back-compat alias for the pre-rename var.
  const raw = process.env.MCP_SLACK_USE_SPOOL_THRESHOLD ?? process.env.MCP_SLACK_SPOOL_THRESHOLD;
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 12_000;
}

export function cacheDir(): string {
  // MCP_SLACK_CACHE_DIR is the back-compat alias for the pre-rename var.
  const d = (process.env.MCP_SLACK_USE_CACHE_DIR ?? process.env.MCP_SLACK_CACHE_DIR)?.trim();
  return resolve(d || DEFAULT_DIR);
}

function summarize(p: unknown): Record<string, unknown> {
  if (!p || typeof p !== 'object') return { type: typeof p };
  const o = p as Record<string, unknown>;
  if (Array.isArray(o.channels)) {
    const ch = o.channels as { name?: string }[];
    return {
      channelCount: ch.length,
      sampleNames: ch.slice(0, 8).map((c) => c.name).filter(Boolean),
    };
  }
  if (Array.isArray(o.messages)) {
    return { messageCount: o.messages.length };
  }
  const messages = o.messages as { matches?: unknown[] } | undefined;
  if (messages && Array.isArray(messages.matches)) {
    return { matchCount: messages.matches.length };
  }
  return { keys: Object.keys(o).slice(0, 12) };
}

/**
 * If serialized JSON exceeds threshold, write to MCP_SLACK_USE_CACHE_DIR and return a pointer
 * (same idea as mcp-firebase FileCache for large RTDB reads).
 */
export function inlineOrSpool(toolSlug: string, payload: unknown): unknown {
  const json = JSON.stringify(payload);
  if (json.length <= spoolThreshold()) {
    return payload;
  }
  const dir = cacheDir();
  mkdirSync(dir, { recursive: true });
  const safe = toolSlug.replace(/[^a-z0-9_-]/gi, '_');
  const file = join(dir, `${safe}_${Date.now()}.json`);
  writeFileSync(file, json, 'utf-8');
  const ok = typeof payload === 'object' && payload !== null && (payload as { ok?: boolean }).ok !== false;
  return {
    ok,
    spooled: true,
    file,
    sizeBytes: Buffer.byteLength(json, 'utf8'),
    summary: summarize(payload),
    hint: 'Large Slack result written to disk. Read `file` with the Read tool or jq; content is not inlined.',
  };
}
