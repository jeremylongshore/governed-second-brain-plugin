import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

describe('search — proxy to the team brain (errors are SURFACED, never swallowed)', () => {
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
    // search now returns the MCP jsonResult wrapper — unwrap the happy-path payload.
    const out = payload(await search('q', 'curated', 10));
    expect(out['source']).toBe('brain-api');
    expect(out['count']).toBe(2);
    const results = out['results'] as Array<Record<string, unknown>>;
    expect(results[0]).toEqual({
      citation: 'qmd://a',
      snippet: 'A',
      score: 0.9,
      title: 'T',
      collection: 'c',
    });
    // The sparse hit keeps its citation and gets safe defaults for the rest.
    expect(results[1]).toMatchObject({ citation: 'qmd://b', snippet: '', score: 0 });
  });

  // R4 fix (was a characterization gate for the old swallow): search now SURFACES
  // the unconfigured / transport / non-OK cases as a distinct, visible error
  // instead of a silent count:0 that reads like "the brain has nothing for you".
  it('surfaces a visible error (not source=unconfigured) when TEAMKB_API_URL is unset', async () => {
    const { search } = await load({ TEAMKB_API_URL: undefined });
    const out = payload(await search('q', 'curated', 10));
    expect(out['ok']).toBe(false);
    expect(String(out['error'])).toContain('unconfigured');
    // The failure must NOT masquerade as a successful empty search.
    expect(out['count']).toBeUndefined();
    expect(out['results']).toBeUndefined();
  });

  it('surfaces a network error (dead API / off-tailnet), never a silent empty result', async () => {
    const { search } = await load({ TEAMKB_API_URL: 'http://brain:3847' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const out = payload(await search('q', 'all', 5));
    expect(out['ok']).toBe(false);
    expect(String(out['error'])).toContain('could not reach the brain API');
    expect(String(out['error'])).toContain('ECONNREFUSED');
    expect(out['count']).toBeUndefined();
    expect(out['results']).toBeUndefined();
  });

  it('surfaces a non-OK (500) response as a role-aware error, never a silent empty result', async () => {
    const { search } = await load({ TEAMKB_API_URL: 'http://brain:3847' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('err', { status: 500 })));
    const out = payload(await search('q', 'curated', 10));
    expect(out['ok']).toBe(false);
    expect(out['status']).toBe(500);
    expect(String(out['error'])).toBe('request failed (500): err');
    expect(out['count']).toBeUndefined();
    expect(out['results']).toBeUndefined();
  });
});

describe('brain_inbox / brain_approve / brain_reject — the admin review surface (jfv.8)', () => {
  it('brain_inbox lists the quarantined queue, compacted + limited, id-less rows dropped', async () => {
    const { listInbox } = await load({
      TEAMKB_API_URL: 'http://brain:3847',
      TEAMKB_API_TOKEN: 'admin-tok',
    });
    const capturedUrl: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        capturedUrl.push(url);
        return new Response(
          JSON.stringify([
            {
              id: 'c1',
              title: 'T1',
              category: 'decision',
              author: { type: 'ai', id: 'ope' },
              capturedAt: '2026-07-11T00:00:00.000Z',
            },
            { title: 'no id — must be dropped' },
            { id: 'c2', title: 'T2', category: 'pattern', author: 'max' },
          ]),
          { status: 200 },
        );
      }),
    );
    const out = payload(await listInbox(undefined, 1));
    // Hits the quarantined filter on the default team tenant.
    expect(capturedUrl[0]).toContain('status=quarantined');
    expect(capturedUrl[0]).toContain('tenantId=intent-solutions');
    // limit=1 → only the first valid row; the id-less row is dropped.
    expect(out['ok']).toBe(true);
    expect(out['count']).toBe(1);
    const candidates = out['candidates'] as Array<Record<string, unknown>>;
    expect(candidates[0]).toEqual({
      id: 'c1',
      title: 'T1',
      category: 'decision',
      author: 'ope',
      capturedAt: '2026-07-11T00:00:00.000Z',
    });
  });

  it('brain_inbox surfaces a 403 for a member token (admin-only), never a silent empty list', async () => {
    const { listInbox } = await load({ TEAMKB_API_URL: 'http://brain:3847' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    const out = payload(await listInbox('intent-solutions', 50));
    expect(out['ok']).toBe(false);
    expect(out['status']).toBe(403);
    expect(String(out['error'])).toMatch(/ADMIN token/);
    expect(out['candidates']).toBeUndefined();
  });

  it('brain_approve POSTs to /promote with actorType:ai + reason, returns the new memory id', async () => {
    const { approveCandidate } = await load({
      TEAMKB_API_URL: 'http://brain:3847',
      TEAMKB_API_TOKEN: 'admin-tok',
    });
    let sentBody: Record<string, unknown> = {};
    let sentUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string }) => {
        sentUrl = url;
        sentBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ id: 'mem-99' }), { status: 200 });
      }),
    );
    const out = payload(await approveCandidate('cand-1', 'team-alpha', 'durable + useful'));
    expect(sentUrl).toContain('/api/candidates/cand-1/promote');
    expect(sentUrl).toContain('tenantId=team-alpha');
    // The agent proxy hints AI; the server owns the actor id (not sent here).
    expect(sentBody).toEqual({ reason: 'durable + useful', actorType: 'ai' });
    expect(out['ok']).toBe(true);
    expect(out['memoryId']).toBe('mem-99');
  });

  it('brain_approve surfaces the server 422 (secret/duplicate refused at the govern gate), nothing applied', async () => {
    const { approveCandidate } = await load({
      TEAMKB_API_URL: 'http://brain:3847',
      TEAMKB_API_TOKEN: 'admin-tok',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'disclosure gate' }), { status: 422 })),
    );
    const out = payload(await approveCandidate('cand-1', 'team-alpha', 'try to launder a secret'));
    expect(out['ok']).toBe(false);
    expect(out['status']).toBe(422);
    expect(String(out['error'])).toMatch(/disclosure gate/);
    expect(out['memoryId']).toBeUndefined();
  });

  it('brain_reject POSTs to /reject and reports the retirement, never deletes', async () => {
    const { rejectCandidate } = await load({
      TEAMKB_API_URL: 'http://brain:3847',
      TEAMKB_API_TOKEN: 'admin-tok',
    });
    let sentUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        sentUrl = url;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    const out = payload(await rejectCandidate('cand-2', 'team-alpha', 'noise'));
    expect(sentUrl).toContain('/api/candidates/cand-2/reject');
    expect(out['ok']).toBe(true);
    expect(String(out['message'])).toMatch(/rejected/i);
  });

  it('all three surface an unconfigured error when TEAMKB_API_URL is unset', async () => {
    const { listInbox, approveCandidate, rejectCandidate } = await load({
      TEAMKB_API_URL: undefined,
    });
    for (const out of [
      payload(await listInbox(undefined, 50)),
      payload(await approveCandidate('x', undefined, 'r')),
      payload(await rejectCandidate('x', undefined, 'r')),
    ]) {
      expect(out['ok']).toBe(false);
      expect(String(out['error'])).toContain('unconfigured');
    }
  });

  it('brain_approve surfaces a network error (dead API / off-tailnet), never a silent success', async () => {
    const { approveCandidate } = await load({ TEAMKB_API_URL: 'http://brain:3847' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const out = payload(await approveCandidate('cand-1', 'team-alpha', 'r'));
    expect(out['ok']).toBe(false);
    expect(String(out['error'])).toContain('could not reach the brain API');
  });

  it('brain_inbox surfaces (not crashes) an unreadable non-JSON 2xx body', async () => {
    const { listInbox } = await load({ TEAMKB_API_URL: 'http://brain:3847', TEAMKB_API_TOKEN: 'admin-tok' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>not json</html>', { status: 200 })));
    const out = payload(await listInbox(undefined, 50));
    expect(out['ok']).toBe(false);
    expect(String(out['error'])).toMatch(/unreadable/i);
    expect(out['candidates']).toBeUndefined();
  });

  it('brain_approve keeps a SUCCEEDED promotion ok even if the 2xx body is unreadable', async () => {
    const { approveCandidate } = await load({ TEAMKB_API_URL: 'http://brain:3847', TEAMKB_API_TOKEN: 'admin-tok' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
    const out = payload(await approveCandidate('cand-1', 'team-alpha', 'ok'));
    // The 2xx means it was promoted — don't turn that into an error over a bad body.
    expect(out['ok']).toBe(true);
    expect(out['memoryId']).toBeUndefined();
  });
});

describe('capture — idempotency + durable outbox (jfv.9)', () => {
  const boxes = [];
  const mkbox = () => {
    const d = mkdtempSync(join(tmpdir(), 'gsb-outbox-'));
    boxes.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of boxes.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('deriveCandidateId is a deterministic, valid UUIDv5 — same input → same id, different content → different', async () => {
    const { deriveCandidateId } = await load();
    const a = deriveCandidateId('t', 'Title', 'the body');
    const b = deriveCandidateId('t', 'Title', 'the body');
    const c = deriveCandidateId('t', 'Title', 'a different body');
    expect(a).toBe(b); // idempotent
    expect(a).not.toBe(c); // content-sensitive
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('capture derives the SAME candidateId for the same proposal (no duplicate rows on retry)', async () => {
    const { capture } = await load({ TEAMKB_API_URL: 'http://brain:3847', TEAMKB_TENANT_ID: 't1' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 201 })));
    const one = payload(await capture('T', 'same content here', undefined, undefined));
    const two = payload(await capture('T', 'same content here', undefined, undefined));
    expect(one['candidateId']).toBe(two['candidateId']);
  });

  it('queues to the durable outbox on a network throw (never drops), reports queued not error', async () => {
    const box = mkbox();
    const { capture } = await load({ TEAMKB_API_URL: 'http://brain:3847', TEAMKB_OUTBOX_DIR: box });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const out = payload(await capture('Title', 'a proposal made while offline', undefined, undefined));
    expect(out['ok']).toBe(true);
    expect(out['queued']).toBe(true);
    // A file was written to the outbox, named by the (deterministic) candidate id.
    const files = readdirSync(box);
    expect(files).toEqual([`${out['candidateId']}.json`]);
  });

  it('queues on a 5xx (transient) but NOT on a 4xx (real rejection surfaces)', async () => {
    const box = mkbox();
    const { capture } = await load({ TEAMKB_API_URL: 'http://brain:3847', TEAMKB_OUTBOX_DIR: box });
    // 5xx → queued.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })));
    const q = payload(await capture('T', 'server was down', undefined, undefined));
    expect(q['queued']).toBe(true);
    expect(readdirSync(box).length).toBe(1);
    // 4xx → surfaced, nothing queued.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'bad' }), { status: 422 })));
    const r = payload(await capture('T', 'invalid proposal', undefined, undefined));
    expect(r['ok']).toBe(false);
    expect(r['status']).toBe(422);
    expect(readdirSync(box).length).toBe(1); // unchanged — the 422 was not queued
  });

  it('drains previously-queued proposals on the next successful capture', async () => {
    const box = mkbox();
    // Seed one already-queued candidate file (as if a prior offline capture).
    writeFileSync(join(box, 'queued-1.json'), JSON.stringify({ id: 'queued-1', content: 'earlier', tenantId: 't1' }));
    const { capture } = await load({ TEAMKB_API_URL: 'http://brain:3847', TEAMKB_OUTBOX_DIR: box });
    const calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        calls.push(JSON.parse(init.body));
        return new Response('{}', { status: 201 });
      }),
    );
    const out = payload(await capture('New', 'a fresh online proposal', undefined, undefined));
    expect(out['ok']).toBe(true);
    expect(out['outboxDrained']).toBe(1); // the queued one was delivered
    expect(readdirSync(box).length).toBe(0); // outbox is now empty
    // Both the new capture AND the drained backlog hit the API.
    expect(calls.some((c) => c.id === 'queued-1')).toBe(true);
  });

  it('drainOutbox stops (keeps the backlog) while the API is still down', async () => {
    const box = mkbox();
    writeFileSync(join(box, 'q1.json'), JSON.stringify({ id: 'q1', content: 'x' }));
    const { drainOutbox } = await load({ TEAMKB_API_URL: 'http://brain:3847', TEAMKB_OUTBOX_DIR: box });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('still down');
      }),
    );
    const n = await drainOutbox();
    expect(n).toBe(0);
    expect(readdirSync(box).length).toBe(1); // kept for a later drain
  });

  it('drainOutbox KEEPS a queued item on a transient 429 (rate-limited), drops on a permanent 4xx', async () => {
    const box = mkbox();
    writeFileSync(join(box, 'q1.json'), JSON.stringify({ id: 'q1', content: 'x' }));
    const { drainOutbox } = await load({ TEAMKB_API_URL: 'http://brain:3847', TEAMKB_OUTBOX_DIR: box });
    // 429 = transient → keep it queued (a rate-limit is not a permanent reject).
    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429 })));
    expect(await drainOutbox()).toBe(0);
    expect(readdirSync(box).length).toBe(1);
    // 422 = permanent reject → drop it (it will never succeed).
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 422 })));
    expect(await drainOutbox()).toBe(1);
    expect(readdirSync(box).length).toBe(0);
  });
});
