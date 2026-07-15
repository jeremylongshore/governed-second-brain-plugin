#!/usr/bin/env node
/**
 * One entrypoint: Governed Second Brain plugin test packs.
 *
 *   node scripts/test-plugin.mjs           # unit + hermetic smokes + onboarding
 *   node scripts/test-plugin.mjs --live    # + live team API smoke
 *   node scripts/test-plugin.mjs --quick   # hermetic only (no vitest)
 *
 * Exit non-zero on first pack failure.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const LIVE = args.has('--live');
const QUICK = args.has('--quick');

function run(label, cmd, cmdArgs, env = {}) {
  console.log(`\n━━━ ${label} ━━━`);
  const r = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: false,
  });
  if (r.status !== 0) {
    console.error(`\n✗ failed: ${label} (exit ${r.status ?? 'signal'})`);
    process.exit(r.status || 1);
  }
  console.log(`✓ ${label}`);
}

console.log('Governed Second Brain — test:plugin');
console.log(`  cwd:  ${ROOT}`);
console.log(`  live: ${LIVE}  quick: ${QUICK}`);

if (!QUICK) {
  run('Pack A · unit (vitest)', 'pnpm', ['exec', 'vitest', 'run']);
  run('Pack A · skill contract', 'node', ['--test', 'smoke/skill-contract.test.mjs']);
}

run('Pack A · local full-chain smoke', 'node', ['smoke/smoke.mjs']);
run('Pack A · team stub smoke', 'node', ['smoke-team.mjs']);
run('Pack A · mode-dispatch', 'node', ['--test', 'smoke/mode-dispatch.test.mjs']);
run(
  'Pack C · onboarding assert',
  'node',
  ['smoke/onboarding-assert.mjs'],
  // In this orchestrator we always hit the live page when not in CI; CI sets SKIP via env if needed
  process.env.CI === 'true' ? { SKIP_PAGE: '1' } : {},
);

if (LIVE) {
  run('Pack B · live team API', 'node', ['smoke/live-smoke.mjs']);
} else {
  console.log('\n··· Pack B (live-smoke) skipped — pass --live to run');
}

console.log('\n✓ test:plugin complete — all selected packs green');
