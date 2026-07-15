#!/usr/bin/env node
/**
 * Pack C — onboarding + install-surface asserts for Governed Second Brain.
 *
 * Zero secrets. Checks the plugin package + (optional) live demos page so the
 * dogfood install path cannot rot silently.
 *
 *   node smoke/onboarding-assert.mjs
 *   BBB_PAGE_URL=https://demos.intentsolutions.io/bbb/ node smoke/onboarding-assert.mjs
 *   SKIP_PAGE=1 node smoke/onboarding-assert.mjs   # package-only (CI-safe always)
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_URL = process.env.BBB_PAGE_URL || 'https://demos.intentsolutions.io/bbb/';
const SKIP_PAGE = process.env.SKIP_PAGE === '1' || process.env.CI === 'true';

let failed = 0;
const ok = (label) => console.log(`  ✓ ${label}`);
const fail = (label, detail) => {
  failed += 1;
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
};

function read(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) {
    fail(`missing ${rel}`);
    return null;
  }
  return readFileSync(p, 'utf8');
}

function readJson(rel) {
  const raw = read(rel);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`invalid JSON ${rel}`, e.message);
    return null;
  }
}

console.log('=== onboarding-assert (Governed Second Brain) ===\n');

// --- Manifests ---
console.log('Manifests');
const marketplace = readJson('.claude-plugin/marketplace.json');
const plugin = readJson('.claude-plugin/plugin.json');

if (marketplace) {
  const plug = marketplace.plugins?.[0];
  if (plug?.name === 'governed-second-brain') ok('marketplace plugin name');
  else fail('marketplace plugin name', JSON.stringify(plug?.name));

  // The Jul 2026 dogfood bug: author must be an object, not a string.
  if (plug?.author && typeof plug.author === 'object' && plug.author.name) {
    ok('marketplace author is object (not string)');
  } else {
    fail('marketplace author must be { name, email? } object', typeof plug?.author);
  }
}

if (plugin) {
  if (plugin.name === 'governed-second-brain') ok('plugin.json name');
  else fail('plugin.json name', plugin.name);
  if (plugin.mcpServers?.['governed-brain']?.transport === 'stdio') {
    ok('plugin.json mcpServers.governed-brain stdio');
  } else {
    fail('plugin.json missing governed-brain stdio MCP');
  }
  const args = plugin.mcpServers?.['governed-brain']?.args ?? [];
  if (args.some((a) => String(a).includes('governed-brain.cjs'))) {
    ok('plugin.json points at governed-brain.cjs');
  } else {
    fail('plugin.json MCP args must reference governed-brain.cjs');
  }
}

const runtime = join(ROOT, 'plugin-runtime/governed-brain.cjs');
if (existsSync(runtime)) ok('shipped bundle plugin-runtime/governed-brain.cjs present');
else fail('missing shipped bundle plugin-runtime/governed-brain.cjs');

// --- Skills / commands ---
console.log('\nSkills (/brain · /brain-save)');
for (const name of ['brain', 'brain-save']) {
  const rel = `skills/${name}/SKILL.md`;
  const body = read(rel);
  if (!body) continue;
  if (body.match(new RegExp(`^name:\\s*${name}\\s*$`, 'm'))) ok(`${rel} name: ${name}`);
  else fail(`${rel} frontmatter name`, 'missing or wrong');
  if (body.includes(`/${name}`) || body.includes(`"/brain`) || body.includes("'/brain")) {
    ok(`${rel} documents slash trigger`);
  } else {
    fail(`${rel} should document /${name} trigger`);
  }
}

const brainSkill = read('skills/brain/SKILL.md') || '';
if (/keywords/i.test(brainSkill) || /not a full sentence/i.test(brainSkill) || /1–2 strong/i.test(brainSkill) || /keyword/i.test(brainSkill)) {
  ok('brain skill mentions keyword retrieval (not only full questions)');
} else {
  // soft — skill may phrase differently
  console.log('  · brain skill keyword guidance not found (warn)');
}

// --- Onboarding docs in-repo ---
console.log('\nIn-repo onboarding');
const onboarding = read('onboarding/README.md') || '';
if (/team/i.test(onboarding) && /local/i.test(onboarding)) ok('onboarding README covers team + local');
else fail('onboarding README must cover team and local paths');
if (onboarding.includes('jeremylongshore/bobs-big-brain-plugin')) {
  ok('onboarding README uses public marketplace path');
} else {
  fail('onboarding README should reference jeremylongshore/bobs-big-brain-plugin');
}
if (onboarding.includes('tenantId') || onboarding.includes('intent-solutions')) {
  ok('onboarding README mentions tenantId / intent-solutions');
} else {
  fail('onboarding README should require tenantId for team mode');
}
// No Windows installer lead
if (!/\.cmd\b|win-setup\.ps1|one-click installer/i.test(onboarding)) {
  ok('onboarding README does not lead with OS installers');
} else {
  fail('onboarding README still pushes OS installers');
}

// --- Live page (optional) ---
if (SKIP_PAGE) {
  console.log('\nLive page: skipped (CI or SKIP_PAGE=1)');
} else {
  console.log(`\nLive page: ${PAGE_URL}`);
  try {
    const res = await fetch(PAGE_URL, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) fail(`page HTTP ${res.status}`);
    else {
      ok(`page HTTP ${res.status}`);
      const html = await res.text();
      const checks = [
        ['Team tab / path', /Team|teammate|team brain/i.test(html)],
        ['Local path', /Local|local personal brain|LOCAL mode/i.test(html)],
        ['marketplace add', html.includes('jeremylongshore/bobs-big-brain-plugin')],
        ['plugin install', html.includes('governed-second-brain@governed-second-brain')],
        ['Commands section', /\/brain/.test(html) && /\/brain-save/.test(html)],
        ['tenantId callout', html.includes('tenantId') || html.includes('intent-solutions')],
        ['no .cmd installer link', !/install-bobs-big-brain\.cmd|win-setup\.ps1/.test(html)],
        ['Intent Solutions footer', /intent solutions|intentsolutions\.io/i.test(html)],
      ];
      for (const [label, pass] of checks) {
        if (pass) ok(label);
        else fail(label);
      }
    }
  } catch (e) {
    fail('fetch page', e.message);
  }
}

console.log('');
if (failed) {
  console.error(`✗ onboarding-assert: ${failed} failure(s)`);
  process.exit(1);
}
console.log('✓ onboarding-assert complete');
