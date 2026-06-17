// Bundle the local governed-brain MCP server into a single self-contained .cjs.
//
// Everything is inlined EXCEPT the one native module (better-sqlite3, which
// ships a compiled .node addon and cannot be bundled) and its 'bindings' loader.
// ajv/ajv-formats (pulled in transitively by the MCP SDK and used to validate
// every tool call at runtime) MUST stay bundled — externalizing them makes the
// runtime inert. zod is aliased to a single copy so the MCP SDK and our tool
// schemas share one zod instance (cross-instance `instanceof` checks otherwise
// fail and break tool registration/validation).
import esbuild from 'esbuild';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);

let zodAlias;
try {
  zodAlias = dirname(require.resolve('zod/package.json'));
} catch {
  zodAlias = require.resolve('zod');
}

await esbuild.build({
  entryPoints: ['src/local-server.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'plugin-runtime/governed-brain.cjs',
  external: ['better-sqlite3', 'bindings'],
  alias: { zod: zodAlias },
  logLevel: 'info',
});

console.error('✓ bundled → plugin-runtime/governed-brain.cjs');
