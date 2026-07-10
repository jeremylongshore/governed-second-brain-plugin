/**
 * R4 unit tests — team-mode read tools SURFACE failures (never a silent count:0).
 *
 * The module reads TEAMKB_API_URL / TEAMKB_API_TOKEN once at import time, so each
 * scenario stubs env, resets the module registry, and re-imports fresh. `fetch`
 * is a global the functions call at invocation time, so it is stubbed per test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const API_URL = 'http://team-brain.test:3847';

/** jsonResult wraps the payload as MCP text content — unwrap it back to an object. */
function parse(result: { content: Array<{ type: string; text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

/** Reset the module registry and re-import with the given env captured at load. */
async function loadFresh(env: { url?: string; token?: string }) {
  vi.resetModules();
  vi.stubEnv('TEAMKB_API_URL', env.url ?? '');
  vi.stubEnv('TEAMKB_API_TOKEN', env.token ?? '');
  return import('../src/remote-server.ts');
}

/** A minimal Response-shaped stub good enough for search()/status(). */
function fakeResponse(opts: { ok: boolean; status: number; body?: unknown; text?: string }): Response {
  return {
    ok: opts.ok,
    status: opts.status,
    json: async () => opts.body,
    text: async () => opts.text ?? JSON.stringify(opts.body ?? {}),
  } as unknown as Response;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('brain_search — errors are surfaced, never swallowed to count:0', () => {
  it('returns a DISTINCT error (not an empty hit set) when the token is rejected (401)', async () => {
    const mod = await loadFresh({ url: API_URL, token: 'bad-token' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse({ ok: false, status: 401, text: '{"error":"invalid or unknown token"}' }),
      ),
    );

    const out = parse(await mod.search('anything', 'curated', 10));

    expect(out['ok']).toBe(false);
    expect(out['status']).toBe(401);
    expect(String(out['error'])).toContain('team token rejected');
    // The failure must NOT masquerade as a successful empty search.
    expect(out['count']).toBeUndefined();
    expect(out['results']).toBeUndefined();
  });

  it('returns a DISTINCT error when fetch throws (dead API / off-tailnet)', async () => {
    const mod = await loadFresh({ url: API_URL, token: 'good-token' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND team-brain.test');
      }),
    );

    const out = parse(await mod.search('anything', 'curated', 10));

    expect(out['ok']).toBe(false);
    expect(String(out['error'])).toContain('could not reach the brain API');
    expect(String(out['error'])).toContain('ENOTFOUND');
    expect(out['count']).toBeUndefined();
  });

  it('still returns cited hits on the happy path (success unchanged)', async () => {
    const mod = await loadFresh({ url: API_URL, token: 'good-token' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse({
          ok: true,
          status: 200,
          body: { hits: [{ citation: 'qmd://doc#1', snippet: 'hello', score: 0.9 }] },
        }),
      ),
    );

    const out = parse(await mod.search('hello', 'curated', 10));

    expect(out['source']).toBe('brain-api');
    expect(out['count']).toBe(1);
    expect(Array.isArray(out['results'])).toBe(true);
  });
});

describe('brain_status — connectivity probe reports healthy vs unhealthy', () => {
  it('reports healthy:true + version when /api/health returns 200', async () => {
    const mod = await loadFresh({ url: API_URL, token: 'good-token' });
    const fetchMock = vi.fn(async () =>
      fakeResponse({
        ok: true,
        status: 200,
        body: { status: 'healthy', uptime: 12, dbConnected: true, version: '0.4.0' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = parse(await mod.status());

    expect(out['mode']).toBe('team');
    expect(out['apiUrl']).toBe(API_URL);
    expect(out['tokenSet']).toBe(true);
    expect(out['healthy']).toBe(true);
    expect(out['version']).toBe('0.4.0');
    // no-auth probe: the health call must hit /api/health.
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/health');
  });

  it('reports healthy:false when /api/health returns 503 (degraded)', async () => {
    const mod = await loadFresh({ url: API_URL, token: 'good-token' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse({ ok: false, status: 503, body: { status: 'degraded', version: '0.4.0' } }),
      ),
    );

    const out = parse(await mod.status());

    expect(out['mode']).toBe('team');
    expect(out['healthy']).toBe(false);
    expect(out['version']).toBe('0.4.0');
  });

  it('reports healthy:false (and no token) when the brain is unreachable', async () => {
    const mod = await loadFresh({ url: API_URL }); // no token
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    );

    const out = parse(await mod.status());

    expect(out['healthy']).toBe(false);
    expect(out['tokenSet']).toBe(false);
    expect(out['version']).toBeNull();
    expect(String(out['error'])).toContain('could not reach the brain API');
  });
});
