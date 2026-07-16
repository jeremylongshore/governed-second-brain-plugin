// Team-mode smoke: prove the dispatcher selects TEAM mode when TEAMKB_API_URL is
// set; that the team tool surface includes the read-only status probe plus search,
// capture, and transition (brain_audit_verify / brain_govern remain local-only); that each tool
// proxies to the brain API with the per-user bearer token and the correct body; and
// that an admin-gated 403 on transition surfaces a clear member-facing message. Uses
// a tiny stub API on loopback — no real brain, no native module, no ~/.teamkb.
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let seenSearchAuth = null;
let seenSearchBody = null;
let seenStatusAuth = null;
let seenCaptureAuth = null;
let seenCaptureBody = null;
let seenTransitionBody = null;

// 1. Stub brain API: search → one cited hit (200); candidates → 201; transition → 403 (admin-gated).
const api = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/api/health') {
      seenStatusAuth = req.headers['authorization'] ?? null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', version: 'smoke-1.0.0' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/search') {
      seenSearchAuth = req.headers['authorization'] ?? null;
      seenSearchBody = raw;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          hits: [
            {
              citation: 'qmd://intent-os/doctrine/doctrine-v1.md#L1',
              snippet: 'The doctrine is the internal register approved by Jeremy.',
              score: 0.91,
              title: 'Doctrine v1',
              collection: 'curated',
            },
          ],
        }),
      );
      return;
    }
    if (req.method === 'POST' && req.url === '/api/candidates') {
      seenCaptureAuth = req.headers['authorization'] ?? null;
      seenCaptureBody = raw;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'inbox' }));
      return;
    }
    if (req.method === 'POST' && /^\/api\/memories\/[^/]+\/transition$/.test(req.url ?? '')) {
      seenTransitionBody = raw;
      // Admin-gated: a member token is refused 403 (proves the member-clarity message).
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'admin role required' }));
      return;
    }
    res.writeHead(404).end();
  });
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
const { port } = api.address();
const API_URL = `http://127.0.0.1:${port}`;

const fail = (msg) => {
  console.error('✗ ' + msg);
  api.close();
  process.exit(1);
};

// 2. Spawn the bundled plugin in TEAM mode (TEAMKB_API_URL set).
const transport = new StdioClientTransport({
  command: 'node',
  args: ['plugin-runtime/governed-brain.cjs'],
  env: { ...process.env, TEAMKB_API_URL: API_URL, TEAMKB_API_TOKEN: 'smoke-token' },
});
const client = new Client({ name: 'smoke-team', version: '0.0.0' }, { capabilities: {} });
await client.connect(transport);
const text = (r) => r.content?.[0]?.text ?? JSON.stringify(r);

// 3. Team surface: status + search + capture + transition present; local-only tools absent.
const tools = (await client.listTools()).tools.map((t) => t.name).sort();
console.log('TOOLS:', tools.join(', '));
for (const t of ['brain_status', 'brain_search', 'brain_capture', 'brain_transition']) {
  if (!tools.includes(t)) fail(`team mode did not expose ${t}`);
}
for (const t of ['brain_audit_verify', 'brain_govern']) {
  if (tools.includes(t)) fail(`team mode unexpectedly exposed local-only tool ${t}`);
}

// 4. brain_status performs the auth-free read-only health probe.
const status = JSON.parse(text(await client.callTool({ name: 'brain_status', arguments: {} })));
console.log('STATUS:', JSON.stringify(status, null, 2));
if (status.mode !== 'team' || status.healthy !== true) fail(`status not healthy team mode: ${JSON.stringify(status)}`);
if (status.version !== 'smoke-1.0.0') fail(`status version not forwarded: ${status.version}`);
if (seenStatusAuth !== null) fail('status health probe must not send the bearer token');

// 5. brain_search proxies, returns the cited shape, forwards the bearer + query.
const out = JSON.parse(text(await client.callTool({ name: 'brain_search', arguments: { query: 'doctrine' } })));
console.log('SEARCH:', JSON.stringify(out, null, 2));
if (out.source !== 'brain-api') fail(`expected source=brain-api, got ${out.source}`);
if (out.count !== 1) fail(`expected count=1, got ${out.count}`);
if (!out.results?.[0]?.citation?.startsWith('qmd://')) fail('missing qmd:// citation in proxied result');
if (seenSearchAuth !== 'Bearer smoke-token') fail(`search token not forwarded (saw: ${seenSearchAuth})`);
if (!seenSearchBody?.includes('"query":"doctrine"')) fail('query not forwarded to the API');

// 6. brain_capture POSTs a full candidate to /api/candidates: tenant=intent-solutions, status=inbox, source=mcp, default category, bearer forwarded.
const cap = JSON.parse(
  text(await client.callTool({ name: 'brain_capture', arguments: { title: 'Smoke fact', content: 'A captured proposal from the team smoke.' } })),
);
console.log('CAPTURE:', JSON.stringify(cap, null, 2));
if (cap.ok !== true) fail(`capture not ok: ${JSON.stringify(cap)}`);
if (cap.tenantId !== 'intent-solutions') fail(`capture result tenantId expected intent-solutions, got ${cap.tenantId}`);
if (seenCaptureAuth !== 'Bearer smoke-token') fail(`capture token not forwarded (saw: ${seenCaptureAuth})`);
const capBody = JSON.parse(seenCaptureBody ?? '{}');
if (capBody.tenantId !== 'intent-solutions') fail(`capture body tenantId expected intent-solutions, got ${capBody.tenantId}`);
if (capBody.status !== 'inbox') fail(`capture status expected inbox, got ${capBody.status}`);
if (capBody.source !== 'mcp') fail(`capture source expected mcp, got ${capBody.source}`);
if (capBody.category !== 'reference') fail(`capture default category expected reference, got ${capBody.category}`);

// 7. brain_transition is admin-gated: a member token gets a clear 403, nothing applied, and the body carries an Author OBJECT (not a string).
const tr = JSON.parse(
  text(await client.callTool({ name: 'brain_transition', arguments: { memoryId: '00000000-0000-0000-0000-000000000000', to: 'archived', reason: 'smoke retire' } })),
);
console.log('TRANSITION:', JSON.stringify(tr, null, 2));
if (tr.ok !== false || tr.status !== 403) fail(`transition expected ok:false status:403, got ${JSON.stringify(tr)}`);
if (!/ADMIN/i.test(tr.error ?? '')) fail(`transition 403 message should mention ADMIN, got: ${tr.error}`);
const trBody = JSON.parse(seenTransitionBody ?? '{}');
if (typeof trBody.actor !== 'object' || trBody.actor?.type !== 'human') fail(`transition actor must be an Author object, got ${JSON.stringify(trBody.actor)}`);

await client.close();
api.close();
console.log('\n✓ team-mode smoke complete (dispatch → status/search/capture/transition → proxy → bearer + tenant + author-object → admin-gated 403 message)');
