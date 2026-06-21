#!/usr/bin/env node
/**
 * Full-chain smoke for the Governed Second Brain stack.
 *
 * Drives the BUILT local MCP runtime (plugin-runtime/governed-brain.cjs) over a
 * real stdio MCP session and exercises the whole deterministic chain end to end:
 *
 *     brain_capture  ->  brain_govern  ->  brain_audit_verify  ->  brain_search
 *     (proposal)         (dedupe/policy/    (hash chain + anchor   (qmd:// cited,
 *                         promote + anchor)  integrity)             best-effort)
 *
 * This is HERMETIC and ZERO-EGRESS: govern, the audit hash chain, and the
 * external anchor are all deterministic and in-process — no LLM, no API key, no
 * network. (ICO compile is the only egress path in the stack, and it is not on
 * this route.) It runs against an isolated TEAMKB_BASE_PATH in a temp dir, so it
 * never reads or writes a real ~/.teamkb brain.
 *
 * REQUIRED (fail the build): capture accepted, govern promotes >=1 with an
 * anchored chain head, audit-verify ok with >=1 event.
 * BEST-EFFORT (warn only): qmd-cited search returns a hit — depends on qmd being
 * installable on PATH in the runner, which the workflow does separately.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNTIME = join(ROOT, 'plugin-runtime', 'governed-brain.cjs');
const BASE = mkdtempSync(join(tmpdir(), 'gsb-smoke-'));

let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failed += 1;
};
const warn = (msg) => console.log(`⚠ ${msg}`);
const parse = (res) => JSON.parse(res.content[0].text);

const transport = new StdioClientTransport({
  command: 'node',
  args: [RUNTIME],
  env: { ...process.env, TEAMKB_BASE_PATH: BASE, TEAMKB_TENANT_ID: 'local' },
});
const client = new Client({ name: 'gsb-smoke', version: '0.0.0' }, { capabilities: {} });

try {
  await client.connect(transport);

  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  ok(tools.length === 6, `6 tools registered: ${tools.join(', ')}`);

  // 1. capture — the model's PROPOSAL onto the spool.
  const cap = parse(
    await client.callTool({
      name: 'brain_capture',
      arguments: {
        title: 'Smoke: governed brain CI invariant',
        content:
          'The CI smoke drives capture -> govern -> audit-verify -> search hermetically, with zero LLM egress.',
        category: 'reference',
      },
    }),
  );
  ok(cap.ok === true, 'brain_capture accepted the candidate');

  // 2. govern — deterministic dedupe/policy/promote + the hash-chained audit + anchor.
  const gov = parse(await client.callTool({ name: 'brain_govern', arguments: {} }));
  ok(
    gov.ok === true && gov.promoted >= 1,
    `brain_govern promoted ${gov.promoted} (rejected ${gov.rejected}, duplicate ${gov.duplicates}, flagged ${gov.flagged})`,
  );
  ok(
    !!gov.anchored && gov.anchored.chainedRows >= 1,
    `audit chain anchored: head ${String(gov.anchored?.chainHead).slice(0, 12)}..., ${gov.anchored?.chainedRows} row(s), committed=${gov.anchored?.committed}`,
  );

  // 3. audit-verify — the receipts: hash chain AND external anchor must agree.
  const ver = parse(await client.callTool({ name: 'brain_audit_verify', arguments: {} }));
  ok(
    ver.ok === true && ver.totalEvents >= 1,
    `brain_audit_verify ok (${ver.totalEvents} event(s), ${ver.anchorCount} anchor(s), ${ver.chainBreaks?.length ?? 0} chain break(s))`,
  );

  // 4. status — the governed memory is durably stored.
  const st = parse(await client.callTool({ name: 'brain_status', arguments: {} }));
  ok(st.total >= 1, `brain_status total=${st.total}`);

  // 5. search — best-effort: only a hit if qmd is on PATH in this runner.
  const sr = parse(
    await client.callTool({
      name: 'brain_search',
      arguments: { query: 'governed brain CI invariant', scope: 'all' },
    }),
  );
  if (sr.count >= 1) {
    ok(true, `brain_search returned ${sr.count} cited hit(s) — e.g. ${sr.results[0].citation}`);
  } else if (sr.note) {
    // qmd is genuinely unavailable in this runner: search failed (res not ok) and
    // returned a `note`. Stay best-effort — a missing qmd is an environment gap.
    warn(`brain_search returned 0 hits (qmd index unavailable) — note: ${sr.note}`);
  } else {
    // qmd RAN (no note) yet returned nothing for a query that matches the
    // just-governed memory's title. That is the signature of the local
    // fail-closed-tenant bug — brain_search omitting config.tenantId so the
    // c5k.2 guard refuses every query. Fail hard so it can never ship silently.
    ok(false, 'brain_search returned 0 hits with NO note — qmd ran but retrieval is empty (local tenant-guard regression: does brain_search pass config.tenantId?)');
  }
} finally {
  await client.close().catch(() => {});
  rmSync(BASE, { recursive: true, force: true });
}

console.log(failed === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL (${failed} required check(s) failed)`);
process.exit(failed === 0 ? 0 : 1);
