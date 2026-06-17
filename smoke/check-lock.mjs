#!/usr/bin/env node
/**
 * Lockfile drift guard. The validate-plugin gate once caught the npm package at
 * 0.1.3 while the plugin manifests sat at 0.1.0 — this makes that class of drift
 * a CI failure instead of a silent surprise. gsb.lock.json owns the known-good
 * tuple; here we assert it stays consistent with the package it ships in.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const at = (rel) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url))));
const lock = at('../gsb.lock.json');
const pkg = at('../package.json');
const mcp = at('../.mcp.json');
const plugin = at('../.claude-plugin/plugin.json');
const market = at('../.claude-plugin/marketplace.json');

let bad = 0;
const eq = (a, b, msg) => {
  const good = a === b;
  console.log(`${good ? '✓' : '✗'} ${msg}${good ? '' : ` (${a} != ${b})`}`);
  if (!good) bad += 1;
};

eq(lock.stack.plugin.name, pkg.name, 'gsb.lock plugin name == package.json name');
eq(lock.stack.plugin.version, pkg.version, 'gsb.lock plugin version == package.json version');
eq(plugin.version, pkg.version, 'plugin.json version == package.json version');
eq(market.plugins[0].version, pkg.version, 'marketplace.json plugin version == package.json version');
eq(mcp.mcpServers['governed-brain'].version, pkg.version, '.mcp.json server version == package.json version');

console.log(bad === 0 ? '\nLOCK OK' : `\nLOCK DRIFT (${bad} mismatch(es))`);
process.exit(bad === 0 ? 0 : 1);
