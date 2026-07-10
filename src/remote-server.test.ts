import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Team-mode remote proxy — the error-surfacing the 6-engineer review flagged.
 *
 * remote-server.ts reads TEAMKB_API_URL / TEAMKB_API_TOKEN into module-level
 * consts at import time, so every scenario that depends on them re-imports a
 * FRESH module copy after stubbing env. `fetch` is stubbed as a dependency — the
 * function under test (errorResult / authHeaders / search) is always the real one.
 */
async function load(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import('./remote-server.js');
}

/** Unwrap the `{ content: [{ text }] }` MCP tool payload back into an object. */
function payload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('errorResult — non-OK brain responses surface a clear, role-aware message', () => {
  it('401 → token-rejected, never a silent success', async () => {
    const { errorResult } = await load();
    const out = payload(await errorResult(new Response('nope', { status: 401 })));
    expect(out).toMatchObject({ ok: false, status: 401 });
    expect(String(out['error'])).toMatch(/token rejected/i);
  });

  it('403 → member-cannot-promote, nothing applied', async () => {
    const { errorResult } = await load();
    const out = payload(await errorResult(new Response('', { status: 403 })));
    expect(out['status']).toBe(403);
    expect(String(out['error'])).toMatch(/ADMIN token/);
    expect(String(out['error'])).toMatch(/nothing was applied/);
  });

  it('422 → surfaces the brain’s JSON {error} detail', async () => {
    const { errorResult } = await load();
    const body = JSON.stringify({ error: 'duplicate candidate' });
    const out = payload(await errorResult(new Response(body, { status: 422 })));
    expect(out['error']).toBe('the brain declined it: duplicate candidate');
  });

  it('422 → falls back to the raw text body when it is not JSON', async () => {
    const { errorResult } = await load();
    const out = payload(await errorResult(new Response('plain text reason', { status: 422 })));
    expect(out['error']).toBe('the brain declined it: plain text reason');
  });

  it('500 → generic failure carrying the status and detail', async () => {
    const { errorResult } = await load();
    const out = payload(await errorResult(new Response('boom', { status: 500 })));
    expect(out['error']).toBe('request failed (500): boom');
  });
});

describe('authHeaders — the one auth surface', () => {
  it('includes a Bearer token when TEAMKB_API_TOKEN is set', async () => {
    const { authHeaders } = await load({ TEAMKB_API_TOKEN: 'secret-tok' });
    expect(authHeaders()).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer secret-tok',
    });
  });

  it('omits authorization when no token is configured', async () => {
    const { authHeaders } = await load({ TEAMKB_API_TOKEN: undefined });
    const headers = authHeaders();
    expect(headers['content-type']).toBe('application/json');
    expect(headers['authorization']).toBeUndefined();
  });
});

describe('search — proxy to the team brain', () => {
  it('returns cited hits and drops citation-less entries', async () => {
    const { search } = await load({ TEAMKB_API_URL: 'http://brain:3847' });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              hits: [
                { citation: 'qmd://a', snippet: 'A', score: 0.9, title: 'T', collection: 'c' },
                { snippet: 'no citation — must be dropped' },
                { citation: 'qmd://b' },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    const out = await search('q', 'curated', 10);
    expect(out.source).toBe('brain-api');
    expect(out.count).toBe(2);
    expect(out.results[0]).toEqual({
      citation: 'qmd://a',
      snippet: 'A',
      score: 0.9,
      title: 'T',
      collection: 'c',
    });
    // The sparse hit keeps its citation and gets safe defaults for the rest.
    expect(out.results[1]).toMatchObject({ citation: 'qmd://b', snippet: '', score: 0 });
  });

  it('reports source=unconfigured (not an error) when TEAMKB_API_URL is unset', async () => {
    const { search } = await load({ TEAMKB_API_URL: undefined });
    const out = await search('q', 'curated', 10);
    expect(out.source).toBe('unconfigured');
    expect(out.count).toBe(0);
  });

  // Characterization gate: search currently SWALLOWS transport + non-OK errors
  // into an empty result — the R4/R8 gap the review flagged (a failed search is
  // indistinguishable from "no hits"). Pinned here so that when brain_search grows
  // real error-surfacing, the behaviour change is a visible, reviewed diff.
  it('swallows a network error into an empty result (documents the R4/R8 gap)', async () => {
    const { search } = await load({ TEAMKB_API_URL: 'http://brain:3847' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const out = await search('q', 'all', 5);
    expect(out).toEqual({ source: 'brain-api', query: 'q', scope: 'all', count: 0, results: [] });
  });

  it('swallows a non-OK (500) response into an empty result (documents the R4/R8 gap)', async () => {
    const { search } = await load({ TEAMKB_API_URL: 'http://brain:3847' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('err', { status: 500 })));
    const out = await search('q', 'curated', 10);
    expect(out.count).toBe(0);
    expect(out.results).toEqual([]);
  });
});
