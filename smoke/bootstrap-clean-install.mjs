#!/usr/bin/env node
/**
 * Proves a file-copy marketplace install can start LOCAL mode from a clean
 * plugin-runtime/ with no parent node_modules and complete the governed write
 * path. All brain data and installed native modules live in a disposable temp
 * tree that is removed in finally.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRATCH = mkdtempSync(join(tmpdir(), 'gsb-bootstrap-'));
const RUNTIME = join(SCRATCH, 'plugin-runtime');
const BRAIN = join(SCRATCH, 'brain');
const BOOTSTRAP = join(RUNTIME, 'bootstrap.cjs');
const SOURCE_RUNTIME = join(ROOT, 'plugin-runtime');
const REQUIRED_FILES = ['bootstrap.cjs', 'governed-brain.cjs', 'package.json', 'package-lock.json'];

mkdirSync(RUNTIME, { recursive: true });
for (const file of REQUIRED_FILES) {
  cpSync(join(SOURCE_RUNTIME, file), join(RUNTIME, file), { recursive: true, force: true });
}

let child;
let failed = 0;
const ok = (condition, message) => {
  console.log(`${condition ? '✓' : '✗'} ${message}`);
  if (!condition) failed += 1;
};
const parse = (result) => JSON.parse(result.content[0].text);

function openMcp(command, args, env) {
  const processHandle = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  const protocolErrors = [];
  let buffer = '';
  let sequence = 0;

  processHandle.stdout.setEncoding('utf8');
  processHandle.stdout.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n');
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // Keep the smoke alive long enough to report a deterministic protocol
        // failure. MCP stdio stdout must contain JSON-RPC only.
        protocolErrors.push('non-JSON stdout');
        continue;
      }
      if (message.id === undefined || !pending.has(message.id)) continue;
      const { resolve, reject, timer } = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
      else resolve(message.result);
    }
  });

  const request = (method, params = {}) => {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 120_000);
      pending.set(id, { resolve, reject, timer });
      processHandle.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };
  const notify = (method, params = {}) => {
    processHandle.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };
  return { processHandle, protocolErrors, request, notify };
}

try {
  ok(!existsSync(join(RUNTIME, 'node_modules')), 'fixture begins without runtime node_modules');

  const teamMcp = openMcp(process.execPath, [BOOTSTRAP], {
    ...process.env,
    HOME: SCRATCH,
    TEAMKB_API_URL: 'http://127.0.0.1:9',
    TEAMKB_API_TOKEN: 'synthetic-bootstrap-smoke-token',
    TEAMKB_BASE_PATH: BRAIN,
    TEAMKB_TENANT_ID: 'bootstrap-smoke',
  });
  child = teamMcp.processHandle;
  await teamMcp.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'gsb-bootstrap-team-smoke', version: '0.0.0' },
  });
  teamMcp.notify('notifications/initialized');
  const teamTools = (await teamMcp.request('tools/list')).tools.map((tool) => tool.name);
  ok(teamTools.includes('brain_search'), `clean-install team mode registered ${teamTools.length} tool(s)`);
  ok(teamMcp.protocolErrors.length === 0, 'team mode emitted JSON-RPC only on stdout');
  ok(!existsSync(join(RUNTIME, 'node_modules')), 'team mode started without provisioning local native dependencies');
  child.stdin.end();
  await once(child, 'exit');
  child = undefined;

  const mcp = openMcp(process.execPath, [BOOTSTRAP], {
    ...process.env,
    HOME: SCRATCH,
    TEAMKB_API_URL: '',
    TEAMKB_API_TOKEN: '',
    TEAMKB_BASE_PATH: BRAIN,
    TEAMKB_TENANT_ID: 'bootstrap-smoke',
  });
  child = mcp.processHandle;
  await mcp.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'gsb-bootstrap-smoke', version: '0.0.0' },
  });
  mcp.notify('notifications/initialized');

  const tools = (await mcp.request('tools/list')).tools.map((tool) => tool.name).sort();
  ok(tools.length === 6, `clean-install bootstrap registered 6 local tools: ${tools.join(', ')}`);
  ok(mcp.protocolErrors.length === 0, 'local mode emitted JSON-RPC only on stdout');
  ok(
    existsSync(join(RUNTIME, 'node_modules', 'better-sqlite3')) &&
      existsSync(join(RUNTIME, 'node_modules', 'fs-ext')),
    'lockfile-pinned native dependencies were provisioned inside plugin-runtime',
  );

  const capture = parse(
    await mcp.request('tools/call', {
      name: 'brain_capture',
      arguments: {
        title: 'Clean marketplace installation invariant',
        content: 'A copied plugin provisions its pinned native runtime before governed local capture and promotion.',
        category: 'reference',
      },
    }),
  );
  ok(capture.ok === true, 'brain_capture accepted a disposable candidate');

  const govern = parse(await mcp.request('tools/call', { name: 'brain_govern', arguments: {} }));
  ok(govern.ok === true && govern.promoted >= 1, `brain_govern promoted ${govern.promoted ?? 0}`);

  const status = parse(await mcp.request('tools/call', { name: 'brain_status', arguments: {} }));
  ok(status.total >= 1, `brain_status sees ${status.total ?? 0} governed memory`);

  const audit = parse(await mcp.request('tools/call', { name: 'brain_audit_verify', arguments: {} }));
  ok(audit.ok === true && audit.totalEvents >= 1, `brain_audit_verify validated ${audit.totalEvents ?? 0} event(s)`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.stdin.end();
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolve) => setTimeout(() => {
        child.kill('SIGTERM');
        resolve();
      }, 5_000)),
    ]);
  }
  rmSync(SCRATCH, { recursive: true, force: true });
  ok(!existsSync(SCRATCH), 'all disposable runtime and brain state was removed');
}

console.log(failed === 0 ? '\nBOOTSTRAP CLEAN-INSTALL PASS' : `\nBOOTSTRAP CLEAN-INSTALL FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
