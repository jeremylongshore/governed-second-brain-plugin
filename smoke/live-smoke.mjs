#!/usr/bin/env node
/**
 * Pack B — live team-brain smoke for Governed Second Brain.
 *
 * Proves the real team API is reachable and (optionally) that a token works.
 * Never prints the full token. Safe defaults: health-only when no token.
 *
 * Env:
 *   TEAMKB_API_URL     default http://100.109.119.103:3847
 *   TEAMKB_API_TOKEN   optional bearer (or TEAMKB_SMOKE_TOKEN)
 *   TEAMKB_TENANT_ID   default intent-solutions
 *   LIVE_SMOKE_REQUIRE_TOKEN=1  fail if no token (for scheduled dogfood)
 *
 *   node smoke/live-smoke.mjs
 */
const API = (process.env.TEAMKB_API_URL || 'http://100.109.119.103:3847').replace(/\/$/, '');
const TOKEN = process.env.TEAMKB_API_TOKEN || process.env.TEAMKB_SMOKE_TOKEN || '';
const TENANT = process.env.TEAMKB_TENANT_ID || 'intent-solutions';
const REQUIRE_TOKEN = process.env.LIVE_SMOKE_REQUIRE_TOKEN === '1';

let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m, d) => {
  failed += 1;
  console.error(`  ✗ ${m}${d ? ` — ${d}` : ''}`);
};
const mask = (t) => (t ? `${t.slice(0, 4)}…(${t.length} chars)` : '(none)');

async function getJson(path, { method = 'GET', token, body } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-json */
  }
  return { res, text, json };
}

console.log('=== live-smoke (Governed Second Brain · team API) ===');
console.log(`  API:    ${API}`);
console.log(`  token:  ${mask(TOKEN)}`);
console.log(`  tenant: ${TENANT}\n`);

console.log('Health');
try {
  const { res, json } = await getJson('/api/health');
  if (res.ok && (json?.status === 'healthy' || json?.status === 'ok')) {
    ok(`GET /api/health → ${json.status} (v${json.version ?? '?'})`);
  } else {
    fail('GET /api/health', `HTTP ${res.status} ${JSON.stringify(json)}`);
  }
} catch (e) {
  fail('GET /api/health (unreachable — on Tailscale?)', e.message);
}

if (!TOKEN) {
  if (REQUIRE_TOKEN) {
    fail('TEAMKB_API_TOKEN required (LIVE_SMOKE_REQUIRE_TOKEN=1)');
  } else {
    console.log('\n  · no TEAMKB_API_TOKEN — skipping auth/search checks');
    console.log('  · set TEAMKB_API_TOKEN to exercise bearer + tenant search\n');
  }
} else {
  console.log('\nAuth + search');
  // Bad token should 401
  try {
    const bad = await getJson('/api/search', {
      method: 'POST',
      token: 'definitely-not-a-real-token',
      body: { query: 'backup', tenantId: TENANT, limit: 3 },
    });
    if (bad.res.status === 401 || bad.res.status === 403) {
      ok(`garbage token → HTTP ${bad.res.status} (auth works)`);
    } else {
      // some APIs return empty on bad auth — still record
      console.log(`  · garbage token → HTTP ${bad.res.status} (expected 401/403; note actual)`);
    }
  } catch (e) {
    fail('garbage-token probe', e.message);
  }

  // Good token + tenant
  try {
    const good = await getJson('/api/search', {
      method: 'POST',
      token: TOKEN,
      body: { query: 'backup', tenantId: TENANT, limit: 5 },
    });
    if (good.res.status === 401 || good.res.status === 403) {
      fail('valid token rejected', `HTTP ${good.res.status} — rotated or wrong token?`);
    } else if (!good.res.ok) {
      fail('search with token', `HTTP ${good.res.status} ${good.text?.slice(0, 120)}`);
    } else {
      ok(`search with token → HTTP ${good.res.status}`);
      const hits = good.json?.hits ?? good.json?.results ?? [];
      const n = Array.isArray(hits) ? hits.length : good.json?.count ?? 0;
      if (n > 0) {
        const cite = hits[0]?.citation || hits[0]?.uri || '';
        ok(`keyword "backup" returned ${n} hit(s)${cite ? ` e.g. ${String(cite).slice(0, 60)}` : ''}`);
      } else {
        console.log('  · 0 hits for "backup" — may be empty corpus or different API shape; not a hard fail');
      }
    }
  } catch (e) {
    fail('search with token', e.message);
  }

  // Missing tenantId — document behavior (empty vs error)
  try {
    const noTenant = await getJson('/api/search', {
      method: 'POST',
      token: TOKEN,
      body: { query: 'backup', limit: 3 },
    });
    const hits = noTenant.json?.hits ?? noTenant.json?.results ?? [];
    const n = Array.isArray(hits) ? hits.length : noTenant.json?.count ?? 0;
    console.log(
      `  · search WITHOUT tenantId → HTTP ${noTenant.res.status}, hits=${n} (dogfood: missing tenantId often yields empty results)`,
    );
  } catch (e) {
    console.log(`  · no-tenant probe error: ${e.message}`);
  }
}

console.log('');
if (failed) {
  console.error(`✗ live-smoke: ${failed} failure(s)`);
  process.exit(1);
}
console.log('✓ live-smoke complete');
