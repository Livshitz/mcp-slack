import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number;
  method: string;
  params?: unknown;
};

// Loose on purpose: adapters pass extra args (e.g. a progress-notification sink)
// that the wrapper must forward untouched.
export type McpAdapterLike = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleJsonRpc: (message: any, ...rest: any[]) => Promise<any>;
};

/**
 * edge.libx MCPAdapter only exposes tools. Register bundled SKILL.md as MCP resources (list + read).
 * Canonical URI: skill://<serverName>/workflow
 */
export function augmentMcpWithSkillResource(adapter: McpAdapterLike, opts: {
  serverName: string;
  repoRootAbs: string;
  skillRelativePath: string;
}): void {
  const canonicalUri = `skill://${opts.serverName}/workflow`;
  const skillAbsPath = resolve(opts.repoRootAbs, opts.skillRelativePath);
  const orig = adapter.handleJsonRpc.bind(adapter);

  adapter.handleJsonRpc = async (message: JsonRpcRequest, ...rest: unknown[]): Promise<unknown> => {
    const { method, id, params } = message;

    if (method === 'resources/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          resources: [
            {
              uri: canonicalUri,
              name: `${opts.serverName}-skill`,
              description: 'Markdown workflow guidance for this MCP — read via resources/read.',
              mimeType: 'text/markdown',
            },
          ],
        },
      };
    }

    if (method === 'resources/read') {
      const uri =
        typeof params === 'object' && params !== null ? (params as { uri?: string }).uri : undefined;
      if (uri !== canonicalUri) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32602,
            message: `Unknown resource URI: ${uri}`,
          },
        };
      }
      if (!existsSync(skillAbsPath)) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: `Skill file missing at ${skillAbsPath}`,
          },
        };
      }
      const text = readFileSync(skillAbsPath, 'utf-8');
      return {
        jsonrpc: '2.0',
        id,
        result: {
          contents: [
            {
              uri: canonicalUri,
              mimeType: 'text/markdown',
              text,
            },
          ],
        },
      };
    }

    const res = (await orig(message, ...rest)) as {
      jsonrpc?: string;
      id?: unknown;
      result?: {
        capabilities?: Record<string, unknown>;
        instructions?: unknown;
      };
    } | null;

    if (
      method === 'initialize' &&
      res?.result?.capabilities &&
      typeof res.result.capabilities === 'object'
    ) {
      const cap = res.result.capabilities as Record<string, unknown>;
      cap.resources = { subscribe: false, ...(typeof cap.resources === 'object' ? cap.resources : {}) };
    }
    return res;
  };
}
