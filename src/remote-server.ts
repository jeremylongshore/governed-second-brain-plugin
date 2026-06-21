#!/usr/bin/env node
/**
 * Governed Second Brain — team mode (remote proxy).
 *
 * The same plugin, in TEAM mode: a self-contained stdio server that proxies the
 * read tool (`brain_search`) to your team's governed brain API over the tailnet.
 * Selected automatically by the dispatcher (src/index.ts) when TEAMKB_API_URL is
 * set; otherwise the plugin runs the local in-process brain instead.
 *
 * Deliberately minimal: no database, no qmd-adapter, no native modules — so team
 * mode runs from a marketplace clone with zero install/build and never touches
 * better-sqlite3. Capture/govern/promote stay server-side (governed centrally);
 * a teammate reads + proposes, the server disposes. The tool surface is unified
 * with local mode (`brain_search`) so the /brain and /brain-save skills work in
 * either mode.
 *
 * Env:
 *   TEAMKB_API_URL    — brain API base (e.g. http://team-server:3847). Required for results.
 *   TEAMKB_API_TOKEN  — per-user bearer token (sent as Authorization: Bearer).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const VERSION = '1.0.0';
const API_URL = process.env['TEAMKB_API_URL'];
const API_TOKEN = process.env['TEAMKB_API_TOKEN'];

interface CitedHit {
  citation: string;
  snippet: string;
  score: number;
  title?: string;
  collection?: string;
}

async function search(
  query: string,
  scope: string,
  limit: number,
): Promise<{ source: string; query: string; scope: string; count: number; results: CitedHit[] }> {
  const empty = { source: 'brain-api', query, scope, count: 0, results: [] as CitedHit[] };
  if (API_URL === undefined || API_URL === '') {
    return { ...empty, source: 'unconfigured' };
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (API_TOKEN !== undefined && API_TOKEN !== '') {
    headers['authorization'] = `Bearer ${API_TOKEN}`;
  }
  const url = `${API_URL.replace(/\/+$/, '')}/api/search`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, scope, pagination: { page: 1, pageSize: limit } }),
    });
    if (!res.ok) return empty;
    const body = (await res.json()) as {
      hits?: Array<{
        citation?: string;
        snippet?: string;
        score?: number;
        title?: string;
        collection?: string;
      }>;
    };
    const results: CitedHit[] = (body.hits ?? [])
      .filter((h) => typeof h.citation === 'string' && h.citation.length > 0)
      .map((h) => ({
        citation: h.citation as string,
        snippet: typeof h.snippet === 'string' ? h.snippet : '',
        score: typeof h.score === 'number' ? h.score : 0,
        title: h.title,
        collection: h.collection,
      }));
    return { source: 'brain-api', query, scope, count: results.length, results };
  } catch {
    return empty;
  }
}

const server = new McpServer({ name: 'governed-brain', version: VERSION });

server.tool(
  'brain_search',
  'Search your team\'s governed knowledge brain and return qmd:// citations. Every hit is anchored to a verifiable source — receipts, not recall. Read-only; curated scope by default. Proxies to the governed brain over the tailnet (team mode).',
  {
    query: z.string().min(1).describe('Natural-language search query'),
    scope: z
      .enum(['curated', 'all', 'inbox', 'archived'])
      .optional()
      .describe('Search scope: curated (default), all, inbox, or archived'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of cited hits to return (default 10)'),
  },
  async (params) => {
    const result = await search(params.query, params.scope ?? 'curated', params.limit ?? 10);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

/**
 * Boot team mode: connect the stdio transport. Exported so the dispatcher
 * (src/index.ts) can start it, and invoked directly when this module is the
 * entry point (e.g. running the bundle standalone).
 */
export async function startRemoteServer(): Promise<void> {
  const transport = new StdioServerTransport();
  const shutdown = async (sig: string): Promise<void> => {
    process.stderr.write(`[governed-brain:team] ${sig}, shutting down\n`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await server.connect(transport);
  process.stderr.write(
    `[governed-brain:team] started — brain=${API_URL ?? '(TEAMKB_API_URL unset)'} token=${API_TOKEN ? 'set' : 'none'}\n`,
  );
}
