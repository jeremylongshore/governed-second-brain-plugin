// Bundle the unified governed-brain MCP server into a single self-contained .cjs.
//
// The entry is the mode dispatcher (src/index.ts): it dynamic-imports the local
// in-process server OR the remote (team) proxy by TEAMKB_API_URL. esbuild inlines
// both modules (CJS, no splitting) into ONE file, lazily — at runtime only the
// selected mode's module initializes, so team mode never touches better-sqlite3.
//
// Everything is inlined EXCEPT the native modules (better-sqlite3, which ships a
// compiled .node addon and cannot be bundled, and fs-ext, the flock(2) wrapper the
// local-mode write lock uses to serialize against the cron's /usr/bin/flock) plus
// better-sqlite3's 'bindings' loader.
// ajv/ajv-formats (pulled in transitively by the MCP SDK and used to validate
// every tool call at runtime) MUST stay bundled — externalizing them makes the
// runtime inert. zod is aliased to a single copy so the MCP SDK and our tool
// schemas share one zod instance (cross-instance `instanceof` checks otherwise
// fail and break tool registration/validation).
import esbuild from 'esbuild';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);

let zodAlias;
try {
  zodAlias = dirname(require.resolve('zod/package.json'));
} catch {
  zodAlias = require.resolve('zod');
}

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'plugin-runtime/governed-brain.cjs',
  external: ['better-sqlite3', 'bindings', 'fs-ext'],
  alias: { zod: zodAlias },
  logLevel: 'info',
});

console.error('✓ bundled → plugin-runtime/governed-brain.cjs');

// Install the externalized native modules INTO plugin-runtime/node_modules so the
// runtime is SELF-CONTAINED. The three externals (better-sqlite3 + its 'bindings'
// loader, and fs-ext) ship compiled .node addons that esbuild cannot inline; if the
// runtime relies on the repo's parent node_modules, a copied/marketplace plugin-runtime/
// (no parent) fails in LOCAL mode with "better-sqlite3 not built for this machine".
// Installing here builds them for the current host ABI and makes the folder portable.
// (TEAM mode never imports sqlite, so this only matters for local/personal-brain use.)
console.error('→ installing self-contained runtime natives (plugin-runtime)…');
execSync('npm install --omit=dev --no-audit --no-fund --loglevel=error', {
  cwd: 'plugin-runtime',
  stdio: 'inherit',
});
console.error('✓ plugin-runtime is self-contained (better-sqlite3, bindings, fs-ext)');
