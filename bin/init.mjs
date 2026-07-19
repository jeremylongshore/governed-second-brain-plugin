#!/usr/bin/env node
/**
 * governed-second-brain init — build a local governed brain from a folder, then
 * tell you how to wire it into Claude Code / Cowork.
 *
 * Usage:
 *   governed-second-brain init <folder> [--index-only] [--yes] [--clean]
 *                                       [--base <dir>] [--tenant <id>]
 *
 *   --index-only   Build with ZERO LLM egress: capture your files → govern
 *                  (deterministic dedupe/policy/promote) → qmd index. No
 *                  Anthropic calls. Best for regulated / client data.
 *                  (Full ICO-compile mode — which derives richer knowledge and
 *                  DOES egress to Anthropic — is on the way; see the notice.)
 *   --yes          Skip the consent prompt (non-interactive).
 *   --clean        Wipe the target brain dir first, then rebuild.
 *   --base <dir>   Brain location (default ~/.teamkb). Must be under $HOME.
 *   --tenant <id>  Tenant/namespace (default "local").
 *
 * This is a self-contained driver: it builds the brain by driving the plugin's
 * own bundled MCP server (the exact runtime you'll run day-to-day), so what the
 * installer exercises is what you ship.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { homedir } from 'node:os';
import { join, resolve, relative, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync, rmSync, readFileSync, statSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = join(PLUGIN_ROOT, 'plugin-runtime', 'governed-brain.cjs');
const RUNTIME_NM = join(PLUGIN_ROOT, 'plugin-runtime', 'node_modules');
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.mdx']);

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};
const log = (...a) => console.log(...a);
const die = (msg) => { console.error(C.red(`✗ ${msg}`)); process.exit(1); };

function parseArgs(argv) {
  const a = { _: [], indexOnly: false, yes: false, clean: false, register: true, scope: 'user',
    base: join(homedir(), '.teamkb'), tenant: 'local' };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--index-only') a.indexOnly = true;
    else if (t === '--yes' || t === '-y') a.yes = true;
    else if (t === '--clean') a.clean = true;
    else if (t === '--base') a.base = resolve(argv[++i]);
    else if (t === '--tenant') a.tenant = argv[++i];
    else if (t === '--scope') a.scope = argv[++i];
    else if (t === '--no-register') a.register = false;
    else if (t === '--resume') {/* additive is the default; no-op */}
    else a._.push(t);
  }
  return a;
}

function walkTextFiles(root) {
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) visit(p);
      else if (TEXT_EXT.has(extname(name).toLowerCase()) && st.size > 0 && st.size < 1_000_000) out.push(p);
    }
  };
  visit(root);
  return out;
}

async function confirm(question) {
  const rl = createInterface({ input: stdin, output: stdout });
  const ans = (await rl.question(`${question} ${C.dim('[y/N]')} `)).trim().toLowerCase();
  rl.close();
  return ans === 'y' || ans === 'yes';
}

async function preflight(folder, args, fileCount) {
  log('');
  log(C.bold('  Bob's Big Brain — pre-flight'));
  log('  ' + C.dim('─'.repeat(58)));
  log(`  Mode        ${args.indexOnly ? C.green('index-only (no LLM egress)') : C.yellow('full compile (egresses to Anthropic)')}`);
  log(`  Source      ${folder}  ${C.dim(`(${fileCount} text file${fileCount === 1 ? '' : 's'})`)}`);
  log(`  Brain       ${args.base}  ${C.dim(`(tenant: ${args.tenant})`)}`);
  log('');
  log('  This will:');
  log(`    • ${C.bold('read')} every text file (.md/.txt/.mdx) under the source folder`);
  log(`    • ${C.bold('run local tools')} on your machine (the bundled govern kernel + qmd)`);
  log(`    • ${C.bold('write')} a governed brain (SQLite + JSONL audit + qmd index) under ${args.base}`);
  if (args.indexOnly) {
    log(`    • ${C.green('send NOTHING over the network')} — index-only is fully local`);
  } else {
    log(`    • ${C.yellow('SEND your file text to DeepSeek')} (ICO compile derives knowledge) — this egresses`);
  }
  log('');
  if (args.yes) return true;
  return confirm('  Proceed?');
}

// The bundle externalizes two native modules — better-sqlite3 (the local store)
// and fs-ext (the flock(2) wrapper the local-mode write lock uses to serialize
// against the cron's /usr/bin/flock). An npx install pulls them in as deps; a
// file-copy install (e.g. /plugin install from a marketplace) ships only the
// bundle, so both must be vendored + native-built into plugin-runtime/.
const NATIVE_DEPS = [
  { name: 'better-sqlite3', fallbackVer: '^12.10.0', addonRel: join('build', 'Release', 'better_sqlite3.node') },
  { name: 'fs-ext', fallbackVer: '^2.1.1', addonRel: join('build', 'Release', 'fs_ext.node') },
];

function ensureNativeDep() {
  const require = createRequire(RUNTIME);
  // Read the version each native dep was built against from package.json, but
  // NEVER let a missing/malformed package.json crash init — degrade to each dep's
  // fallbackVer below. (The pre-R9 code read this inside a per-dep try/catch;
  // hoisting it must keep that fail-safe.)
  let deps = {};
  try {
    deps = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')).dependencies || {};
  } catch {
    /* missing/unreadable/malformed package.json — fall back to fallbackVer */
  }
  for (const { name, fallbackVer, addonRel } of NATIVE_DEPS) {
    // Already resolvable from the runtime (e.g. npx-installed it as a dependency)? Done.
    try { require.resolve(name); continue; } catch {}
    const addon = join(RUNTIME_NM, name, addonRel);
    if (existsSync(addon)) continue;
    // Resolve the version the bundle was built against.
    const ver = deps[name] || fallbackVer;
    log(C.dim(`  vendoring ${name}@${ver} into plugin-runtime/ (native build)…`));
    try {
      execFileSync('npm', ['install', `${name}@${ver}`, '--prefix', join(PLUGIN_ROOT, 'plugin-runtime'), '--no-save', '--silent'],
        { stdio: ['ignore', 'ignore', 'inherit'] });
    } catch {
      die(`failed to build ${name} (needs Node 20+ and a C/C++ toolchain). Install build-essential / Xcode CLT and retry.`);
    }
    if (!existsSync(addon)) die(`${name} native addon did not build — see errors above.`);
  }
}

function checkQmd() {
  try {
    const v = execFileSync('qmd', ['--version'], { encoding: 'utf8' }).trim();
    const m = v.match(/(\d+)\.\d+\.\d+/);
    if (m && Number(m[1]) < 2) {
      log(C.yellow(`  ⚠ ${v} is too old — retrieval needs qmd 2.x. Upgrade: https://github.com/tobi/qmd`));
      return false;
    }
    log(C.dim(`  qmd on PATH: ${v}`));
    return true;
  } catch {
    log(C.yellow('  ⚠ qmd not on PATH — capture + govern + the audit chain will still work, but SEARCH'));
    log(C.yellow('    will return nothing until you install qmd 2.x and re-run. See https://github.com/tobi/qmd'));
    return false;
  }
}

async function buildBrain(folder, files, args) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [RUNTIME],
    env: { ...process.env, TEAMKB_TENANT_ID: args.tenant, TEAMKB_BASE_PATH: args.base },
  });
  const client = new Client({ name: 'gsb-installer', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  const text = (r) => { try { return JSON.parse(r.content?.[0]?.text ?? '{}'); } catch { return {}; } };

  log('');
  log(C.bold(`  Capturing ${files.length} file${files.length === 1 ? '' : 's'} → governing…`));
  let captured = 0;
  for (const f of files) {
    const rel = relative(folder, f) || f;
    const content = readFileSync(f, 'utf8').slice(0, 200_000);
    const r = text(await client.callTool({
      name: 'brain_capture',
      arguments: { title: rel, content, category: 'reference', filePaths: [f] },
    }));
    if (r.ok) captured++;
    stdout.write(`\r  ${C.dim(`captured ${captured}/${files.length}`)}   `);
  }
  log('');
  const gov = text(await client.callTool({ name: 'brain_govern', arguments: {} }));
  const st = text(await client.callTool({ name: 'brain_status', arguments: {} }));
  await client.close();
  return { captured, gov, status: st };
}

// Resolve the ICO CLI: local sibling checkout first (built), then `ico` on PATH,
// then npx. Full-compile drives it with ICO_PROVIDER=deepseek.
function resolveIco() {
  const sibling = resolve(PLUGIN_ROOT, '..', 'bobs-big-brain-compiler', 'packages', 'cli', 'dist', 'index.js');
  if (process.env.GSB_ICO_CLI && existsSync(process.env.GSB_ICO_CLI)) {
    return { cmd: 'node', base: [process.env.GSB_ICO_CLI], label: process.env.GSB_ICO_CLI };
  }
  if (existsSync(sibling)) return { cmd: 'node', base: [sibling], label: '../bobs-big-brain-compiler (local)' };
  try {
    execFileSync('ico', ['--version'], { stdio: 'ignore' });
    return { cmd: 'ico', base: [], label: 'ico (PATH)' };
  } catch {
    return { cmd: 'npx', base: ['-y', 'intentional-cognition-os@^1.14.0'], label: 'npx intentional-cognition-os@^1.14.0' };
  }
}

// Full-compile path: ICO derives knowledge from the folder (6 passes, on DeepSeek),
// emits the spool, and brain_govern (the same in-process runtime) governs it.
async function fullCompile(folder, args) {
  const ico = resolveIco();
  const ws = join(args.base, 'ico-workspace');
  rmSync(ws, { recursive: true, force: true });
  const icoEnv = { ...process.env, ICO_PROVIDER: 'deepseek' }; // DEEPSEEK_API_KEY already in env
  const run = (a, opts = {}) =>
    execFileSync(ico.cmd, [...ico.base, ...a], { stdio: ['ignore', 'ignore', 'inherit'], env: icoEnv, ...opts });

  log('');
  log(C.dim(`  ICO via ${ico.label} — provider: deepseek`));
  log(C.dim('  ico init…'));
  run(['init', basename(ws), '--path', dirname(ws)]);
  log(C.dim('  ico mount + ingest…'));
  run(['--workspace', ws, 'mount', 'add', 'corpus', folder]);
  run(['--workspace', ws, 'ingest', folder, '--yes']);
  log(C.yellow('  ico compile all (6 passes — sending content to DeepSeek)…'));
  run(['--workspace', ws, 'compile', 'all'], { stdio: ['ignore', 'inherit', 'inherit'] });
  log(C.dim('  ico spool emit…'));
  run(['--workspace', ws, 'spool', 'emit', '--scope', 'all', '--tenant', args.tenant]);

  // Hand the compiled spool to the brain's spool dir, then govern via the bundled MCP server.
  const wsSpool = join(ws, 'spool');
  const brainSpool = join(args.base, 'spool');
  mkdirSync(brainSpool, { recursive: true });
  let moved = 0;
  if (existsSync(wsSpool)) {
    for (const f of readdirSync(wsSpool)) {
      if (f.startsWith('spool-') && f.endsWith('.jsonl')) {
        copyFileSync(join(wsSpool, f), join(brainSpool, f));
        moved++;
      }
    }
  }
  if (moved === 0) die('ICO compile produced no spool — nothing to govern (see the compile output above).');

  const transport = new StdioClientTransport({
    command: 'node',
    args: [RUNTIME],
    env: { ...process.env, TEAMKB_TENANT_ID: args.tenant, TEAMKB_BASE_PATH: args.base },
  });
  const client = new Client({ name: 'gsb-installer', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  const text = (r) => {
    try {
      return JSON.parse(r.content?.[0]?.text ?? '{}');
    } catch {
      return {};
    }
  };
  log(C.bold('  Governing the compiled spool…'));
  const gov = text(await client.callTool({ name: 'brain_govern', arguments: {} }));
  const status = text(await client.callTool({ name: 'brain_status', arguments: {} }));
  await client.close();
  return { captured: gov.ingested ?? 0, gov, status };
}

function hasClaude() {
  try { execFileSync('claude', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

// Register the bundled server with Claude Code via the official CLI. Idempotent:
// drop any prior registration at this scope, then add fresh with absolute paths
// (so the server resolves its vendored native dep + the brain we just built).
function registerMcp(args) {
  try { execFileSync('claude', ['mcp', 'remove', 'governed-brain', '-s', args.scope], { stdio: 'ignore' }); } catch {}
  try {
    execFileSync('claude', [
      'mcp', 'add', 'governed-brain', '-s', args.scope,
      '-e', `TEAMKB_TENANT_ID=${args.tenant}`,
      '-e', `TEAMKB_BASE_PATH=${args.base}`,
      '--', 'node', RUNTIME,
    ], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function printNextSteps(args, qmdOk, registered) {
  log('');
  log('  ' + C.green('✓ Brain built.') + ` ${C.dim(args.base)}`);
  log('  ' + C.dim('─'.repeat(58)));
  if (registered) {
    log('  ' + C.green(`✓ MCP server 'governed-brain' registered with Claude Code`) + C.dim(` (scope: ${args.scope})`));
    log('  ' + C.dim('Start a new Claude Code session to load it.'));
    log('');
    log('  For the /brain and /brain-save skills too, install the full plugin:');
    log(C.cyan('    claude plugin marketplace add jeremylongshore/bobs-big-brain-plugin'));
    log(C.cyan('    claude plugin install governed-second-brain'));
  } else {
    log('  ' + C.yellow('Register the MCP server with Claude Code:'));
    log(C.cyan(`    claude mcp add governed-brain -s ${args.scope} \\`));
    log(C.cyan(`      -e TEAMKB_TENANT_ID=${args.tenant} -e TEAMKB_BASE_PATH=${args.base} \\`));
    log(C.cyan(`      -- node ${RUNTIME}`));
    log('  …or, for the skills too: ' + C.cyan('claude plugin marketplace add jeremylongshore/bobs-big-brain-plugin'));
  }
  log('');
  log(C.bold('  Then try'));
  log(`    /brain ${C.dim('"<a few keywords from your notes>"')}        ${C.dim('→ a qmd://-cited answer')}`);
  log(`    /brain-save ${C.dim('"<a fact worth keeping>"')}            ${C.dim('→ governed capture + receipt')}`);
  if (!qmdOk) log('  ' + C.yellow('(install qmd 2.x on PATH first, or /brain will return nothing)'));
  log('');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._[0] !== 'init' || !args._[1]) {
    log('Usage: governed-second-brain init <folder> [--index-only] [--yes] [--clean] [--base <dir>] [--tenant <id>]');
    process.exit(args._[0] === 'init' ? 1 : 0);
  }
  const folder = resolve(args._[1]);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) die(`not a folder: ${folder}`);
  if (!args.base.startsWith(homedir())) die(`--base must be under your home directory (${homedir()})`);
  if (!existsSync(RUNTIME)) die(`bundled runtime missing at ${RUNTIME} — run "pnpm build" in the plugin repo first.`);

  // Full compile mode egresses to DeepSeek — require the key up front (fail fast, before consent).
  if (!args.indexOnly && !process.env.DEEPSEEK_API_KEY) {
    die(
      'full compile mode sends your file text to DeepSeek and needs DEEPSEEK_API_KEY.\n' +
        '    export DEEPSEEK_API_KEY=…   — or use --index-only for the zero-egress path.',
    );
  }

  const files = walkTextFiles(folder);
  if (files.length === 0) die(`no .md/.txt/.mdx files found under ${folder}`);

  if (!(await preflight(folder, args, files.length))) { log(C.dim('  aborted.')); process.exit(0); }

  if (args.clean && existsSync(args.base)) {
    log(C.dim(`  --clean: removing ${args.base}`));
    rmSync(args.base, { recursive: true, force: true });
  }

  ensureNativeDep();
  const qmdOk = checkQmd();
  const { captured, gov, status } = args.indexOnly
    ? await buildBrain(folder, files, args)
    : await fullCompile(folder, args);

  log('  ' + C.dim('─'.repeat(58)));
  log(`  captured ${C.bold(captured)} · governed → ${C.green(`${gov.promoted ?? 0} promoted`)}, ` +
      `${gov.rejected ?? 0} rejected, ${gov.duplicates ?? 0} duplicate` +
      (gov.indexUpdated ? '' : C.yellow('  (index not refreshed — qmd?)')));
  log(`  brain now holds ${C.bold(status.total ?? 0)} governed memor${(status.total ?? 0) === 1 ? 'y' : 'ies'}`);

  let registered = false;
  if (args.register && hasClaude()) registered = registerMcp(args);
  printNextSteps(args, qmdOk, registered);
}

main().catch((e) => die(e?.stack || String(e)));
