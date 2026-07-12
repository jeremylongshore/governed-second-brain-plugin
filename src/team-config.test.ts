import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyTeamConfig,
  loadTeamConfig,
  teamConfigPath,
  TeamConfigError,
} from './team-config.js';

/**
 * The ~/.teamkb/team.json config-file fallback — the onboarding fix that lets a
 * GUI/Dock launch (which never sources ~/.zshrc) reach team mode, and that FAILS
 * CLOSED on a present-but-broken file instead of silently running the wrong brain.
 *
 * Each test gets a throwaway base dir via TEAMKB_BASE_PATH, so team.json lands in a
 * temp tree and never touches the real ~/.teamkb. The filesystem is REAL — the unit
 * under test is file I/O, so mocking it would test nothing. Env objects are plain
 * literals passed in, never the process's own env.
 */
let base: string;

function writeTeamJson(content: string, mode = 0o600): string {
  const p = join(base, 'team.json');
  writeFileSync(p, content);
  chmodSync(p, mode);
  return p;
}

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { TEAMKB_BASE_PATH: base, ...overrides };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'teamkb-test-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('teamConfigPath — base-path precedence (mirror of getTeamKbBasePath)', () => {
  it('resolves <base>/team.json under TEAMKB_BASE_PATH', () => {
    expect(teamConfigPath(env())).toBe(join(base, 'team.json'));
  });

  it('falls back to TEAMKB_HOME when TEAMKB_BASE_PATH is unset', () => {
    expect(teamConfigPath({ TEAMKB_HOME: base })).toBe(join(base, 'team.json'));
  });
});

describe('loadTeamConfig — presence + fail-closed', () => {
  it('returns present:false when no file exists (the local-showcase default)', () => {
    const r = loadTeamConfig(env());
    expect(r.present).toBe(false);
    expect(r.config).toBeUndefined();
  });

  it('parses a well-formed 0600 file', () => {
    writeTeamJson(
      JSON.stringify({ apiUrl: 'http://brain:3847', apiToken: 'tok', tenantId: 'intent-solutions' }),
    );
    const r = loadTeamConfig(env());
    expect(r.present).toBe(true);
    expect(r.config).toEqual({
      apiUrl: 'http://brain:3847',
      apiToken: 'tok',
      tenantId: 'intent-solutions',
    });
  });

  it('REFUSES (throws) a group/world-readable file — the 0600 discipline is enforced, not assumed', () => {
    writeTeamJson(JSON.stringify({ apiUrl: 'http://brain:3847', apiToken: 'tok' }), 0o644);
    expect(() => loadTeamConfig(env())).toThrow(TeamConfigError);
    expect(() => loadTeamConfig(env())).toThrow(/0600/);
  });

  it('REFUSES a group-readable (0o640) file too — any group/other bit fails closed', () => {
    writeTeamJson(JSON.stringify({ apiUrl: 'http://brain:3847' }), 0o640);
    expect(() => loadTeamConfig(env())).toThrow(TeamConfigError);
  });

  it('REFUSES malformed JSON rather than degrading to local', () => {
    writeTeamJson('{ not json', 0o600);
    expect(() => loadTeamConfig(env())).toThrow(/not valid JSON/);
  });

  it('the malformed-JSON error NEVER echoes file contents (no token fragment leak)', () => {
    // A syntax error adjacent to the token must not surface a snippet of it.
    writeTeamJson('{ "apiToken": SECRET_TOKEN_LEAK_abc123 }', 0o600);
    try {
      loadTeamConfig(env());
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as Error).message).not.toContain('SECRET_TOKEN_LEAK_abc123');
      expect((e as Error).message).toMatch(/not valid JSON/);
    }
  });

  it('REFUSES a non-object (array) body', () => {
    writeTeamJson('[]', 0o600);
    expect(() => loadTeamConfig(env())).toThrow(/must be a JSON object/);
  });

  it('REFUSES a JSON null body', () => {
    writeTeamJson('null', 0o600);
    expect(() => loadTeamConfig(env())).toThrow(/must be a JSON object/);
  });

  it('REFUSES a present file with no usable apiUrl (empty object) — not a silent-absent file', () => {
    writeTeamJson('{}', 0o600);
    expect(() => loadTeamConfig(env())).toThrow(/no usable "apiUrl"/);
  });

  it('REFUSES snake_case keys (api_url) — the silent-local typo trap, and names the found keys', () => {
    writeTeamJson(JSON.stringify({ api_url: 'http://brain:3847', api_token: 'y' }), 0o600);
    expect(() => loadTeamConfig(env())).toThrow(/no usable "apiUrl"/);
    expect(() => loadTeamConfig(env())).toThrow(/api_url/); // the mistake is self-diagnosing
  });

  it('REFUSES a tenantId-only file (no apiUrl) — no tenant bleed into local mode', () => {
    writeTeamJson(JSON.stringify({ tenantId: 'intent-solutions' }), 0o600);
    expect(() => loadTeamConfig(env())).toThrow(/no usable "apiUrl"/);
  });

  it('REFUSES a whitespace-only apiUrl (present but empty is a mistake, not "unset")', () => {
    writeTeamJson(JSON.stringify({ apiUrl: '   ', tenantId: 'x' }), 0o600);
    expect(() => loadTeamConfig(env())).toThrow(/"apiUrl" must be a non-empty string/);
  });

  it('REFUSES a present-but-numeric apiToken (fail-closed, not silently ignored)', () => {
    writeTeamJson(JSON.stringify({ apiUrl: 'http://brain:3847', apiToken: 42 }), 0o600);
    expect(() => loadTeamConfig(env())).toThrow(/"apiToken" must be a non-empty string/);
  });

  it('REFUSES a present-but-empty tenantId', () => {
    writeTeamJson(JSON.stringify({ apiUrl: 'http://brain:3847', tenantId: '' }), 0o600);
    expect(() => loadTeamConfig(env())).toThrow(/"tenantId" must be a non-empty string/);
  });

  it('accepts a file with only a valid apiUrl (other keys absent — may come from env)', () => {
    writeTeamJson(JSON.stringify({ apiUrl: 'http://brain:3847' }), 0o600);
    expect(loadTeamConfig(env()).config).toEqual({ apiUrl: 'http://brain:3847' });
  });

  it('trims string field values', () => {
    writeTeamJson(JSON.stringify({ apiUrl: '  http://brain:3847  ' }), 0o600);
    expect(loadTeamConfig(env()).config).toEqual({ apiUrl: 'http://brain:3847' });
  });
});

describe('applyTeamConfig — precedence: real env → team.json → absent(local)', () => {
  function loaded(cfg: object): ReturnType<typeof loadTeamConfig> {
    writeTeamJson(JSON.stringify(cfg));
    return loadTeamConfig(env());
  }

  it('fills every key the environment left absent', () => {
    const result = loaded({ apiUrl: 'http://brain:3847', apiToken: 'tok', tenantId: 'ten' });
    const e: NodeJS.ProcessEnv = {};
    const filled = applyTeamConfig(e, result);
    expect(e['TEAMKB_API_URL']).toBe('http://brain:3847');
    expect(e['TEAMKB_API_TOKEN']).toBe('tok');
    expect(e['TEAMKB_TENANT_ID']).toBe('ten');
    expect(filled.sort()).toEqual(['TEAMKB_API_TOKEN', 'TEAMKB_API_URL', 'TEAMKB_TENANT_ID']);
  });

  it('real env WINS — a genuinely-set env value is never overwritten', () => {
    const result = loaded({ apiUrl: 'http://file:3847', apiToken: 'file-tok' });
    const e: NodeJS.ProcessEnv = { TEAMKB_API_URL: 'http://env:9999' };
    const filled = applyTeamConfig(e, result);
    expect(e['TEAMKB_API_URL']).toBe('http://env:9999'); // env kept
    expect(e['TEAMKB_API_TOKEN']).toBe('file-tok'); // gap filled
    expect(filled).toEqual(['TEAMKB_API_TOKEN']);
  });

  it('treats an empty-string env value as absent → team.json fills it', () => {
    const result = loaded({ apiUrl: 'http://file:3847' });
    const e: NodeJS.ProcessEnv = { TEAMKB_API_URL: '' };
    applyTeamConfig(e, result);
    expect(e['TEAMKB_API_URL']).toBe('http://file:3847');
  });

  it('treats an unexpanded ${...} placeholder env value as absent → team.json fills it', () => {
    const result = loaded({ apiUrl: 'http://file:3847' });
    const e: NodeJS.ProcessEnv = { TEAMKB_API_URL: '${TEAMKB_API_URL}' };
    applyTeamConfig(e, result);
    expect(e['TEAMKB_API_URL']).toBe('http://file:3847');
  });

  it('fills nothing when no file was present (stays local)', () => {
    const result = loadTeamConfig(env()); // no file written
    const e: NodeJS.ProcessEnv = {};
    expect(applyTeamConfig(e, result)).toEqual([]);
    expect(e['TEAMKB_API_URL']).toBeUndefined();
  });
});
