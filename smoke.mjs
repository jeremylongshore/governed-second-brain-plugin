// Phase A smoke: drive the bundled server over the real MCP protocol through
// the full daemon-free loop. Uses an isolated base path (NOT the live ~/.teamkb).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const BASE = `${process.env.HOME}/.gsb-smoke`;
const transport = new StdioClientTransport({
  command: 'node',
  args: ['plugin-runtime/governed-brain.cjs'],
  env: { ...process.env, TEAMKB_TENANT_ID: 'local', TEAMKB_BASE_PATH: BASE },
});
const client = new Client({ name: 'smoke', version: '0.0.0' }, { capabilities: {} });
await client.connect(transport);

const tools = await client.listTools();
console.log('TOOLS:', tools.tools.map((t) => t.name).sort().join(', '));

const text = (r) => r.content?.[0]?.text ?? JSON.stringify(r);

console.log('\nCAPTURE:\n' + text(await client.callTool({
  name: 'brain_capture',
  arguments: {
    title: 'Governed brain runs in-process',
    content: 'The Governed Second Brain runs fully in-process via a local stdio MCP server with no daemon and no network — capture, govern, and search all happen on the local machine.',
    category: 'architecture',
  },
})));

console.log('\nGOVERN:\n' + text(await client.callTool({ name: 'brain_govern', arguments: {} })));
console.log('\nSTATUS:\n' + text(await client.callTool({ name: 'brain_status', arguments: {} })));
console.log('\nSEARCH:\n' + text(await client.callTool({
  name: 'brain_search',
  arguments: { query: 'governed brain daemon network local' },
})));

await client.close();
console.log('\n✓ smoke complete');
