// Team-mode smoke: prove the dispatcher selects TEAM mode when TEAMKB_API_URL is
// set, that brain_search proxies to the brain API over HTTP, returns the same
// cited shape as local mode, and forwards the per-user bearer token. Uses a tiny
// stub API on loopback — no real brain, no native module, no ~/.teamkb.
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let seenAuth = null;
let seenBody = null;

// 1. Stub brain API: answer POST /api/search with one cited hit.
const api = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/api/search') {
      seenAuth = req.headers['authorization'] ?? null;
      seenBody = raw;
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

// 3. Team mode exposes exactly the unified read tool, brain_search.
const tools = (await client.listTools()).tools.map((t) => t.name).sort();
console.log('TOOLS:', tools.join(', '));
if (!tools.includes('brain_search')) fail('team mode did not expose brain_search');
if (tools.includes('brain_capture')) fail('team mode unexpectedly exposed a local write tool');

// 4. brain_search must proxy and return the cited shape.
const text = (r) => r.content?.[0]?.text ?? JSON.stringify(r);
const out = JSON.parse(
  text(await client.callTool({ name: 'brain_search', arguments: { query: 'doctrine' } })),
);
console.log('SEARCH:', JSON.stringify(out, null, 2));
if (out.source !== 'brain-api') fail(`expected source=brain-api, got ${out.source}`);
if (out.count !== 1) fail(`expected count=1, got ${out.count}`);
if (!out.results?.[0]?.citation?.startsWith('qmd://')) fail('missing qmd:// citation in proxied result');

// 5. The per-user bearer token must reach the API.
if (seenAuth !== 'Bearer smoke-token') fail(`token not forwarded (saw: ${seenAuth})`);
if (!seenBody?.includes('"query":"doctrine"')) fail('query not forwarded to the API');

await client.close();
api.close();
console.log('\n✓ team-mode smoke complete (dispatch → proxy → qmd:// citation → bearer forwarded)');
