/**
 * Governed Second Brain — the ~/.teamkb/team.json config-file fallback.
 *
 * The onboarding day-killer this fixes: a teammate sets TEAMKB_API_URL /
 * TEAMKB_API_TOKEN in ~/.zshrc, but a GUI/Dock-launched Claude never sources
 * ~/.zshrc, so those vars are ABSENT and the plugin silently runs an empty LOCAL
 * brain that "succeeds" with zero results (also the governance hole: an unlocked
 * local writer bypassing the control plane). The fix is a config source that does
 * not depend on the launching shell — a small JSON file on disk that the
 * double-click installer writes born-0600.
 *
 * Precedence (per key), pinned + tested:  real env  →  team.json  →  (absent → local).
 * Real env always wins; team.json only fills keys the environment left absent.
 *
 * Fail-CLOSED — never launder a misconfig into the wrong brain:
 *   - file absent (ENOENT)                          → { present: false }; the plugin
 *       stays local (the legitimate public-showcase default — NOT a failure).
 *   - file present but group/world-readable (0o077) → THROW. A bearer token must not
 *       sit in a loosely-permissioned file; the 0600 discipline is enforced, not
 *       assumed.
 *   - file present but unreadable / invalid JSON / not an object → THROW.
 * index.ts turns any throw into a loud refusal (stderr + non-zero exit): a teammate
 * who dropped a team.json clearly WANTS team mode, so a broken one must refuse — not
 * silently degrade to an unlocked local writer.
 *
 * CI-safe by construction: imports ONLY node builtins (+ the shared predicate from
 * mode.ts) — never @qmd-team-intent-kb/* — so it typechecks and unit-tests in plain
 * CI, which has no private sibling monorepo. The base-path precedence is replicated
 * verbatim from @qmd-team-intent-kb/common `getTeamKbBasePath` (TEAMKB_BASE_PATH →
 * TEAMKB_HOME → ~/.teamkb) — the same "copy the small contract, don't import the big
 * dep" pattern remote-server.ts uses for its category enum.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isConfigured } from './mode.js';

/** The three keys team.json can supply, mapped to the env vars they fill. */
const KEY_TO_ENV = {
  apiUrl: 'TEAMKB_API_URL',
  apiToken: 'TEAMKB_API_TOKEN',
  tenantId: 'TEAMKB_TENANT_ID',
} as const;

export type TeamConfigKey = keyof typeof KEY_TO_ENV;

export interface TeamConfig {
  apiUrl?: string;
  apiToken?: string;
  tenantId?: string;
}

export interface TeamConfigResult {
  /** Was a team.json file present on disk? (Absent is fine — the local showcase.) */
  present: boolean;
  /** The parsed config — present only when a valid file was found. */
  config?: TeamConfig;
  /** Absolute path we looked at (for messages). */
  path: string;
}

/** A present-but-unusable team.json. index.ts turns this into a loud refusal. */
export class TeamConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamConfigError';
  }
}

/**
 * Mirror of @qmd-team-intent-kb/common `getTeamKbBasePath`, kept CI-safe (no import):
 * TEAMKB_BASE_PATH → TEAMKB_HOME → ~/.teamkb, empty/whitespace treated as unset.
 */
function teamKbBasePath(env: NodeJS.ProcessEnv): string {
  const base = env['TEAMKB_BASE_PATH']?.trim();
  if (base) return base;
  const home = env['TEAMKB_HOME']?.trim();
  if (home) return home;
  return join(homedir(), '.teamkb');
}

/** Absolute path to the team config file for the given environment. */
export function teamConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(teamKbBasePath(env), 'team.json');
}

/**
 * Load ~/.teamkb/team.json. Returns { present:false } when the file does not exist
 * (the normal local-showcase case). THROWS TeamConfigError when a file IS present
 * but cannot be safely trusted (loose perms, unreadable, malformed) — fail-closed.
 */
export function loadTeamConfig(env: NodeJS.ProcessEnv = process.env): TeamConfigResult {
  const path = teamConfigPath(env);
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { present: false, path };
    throw new TeamConfigError(`cannot stat ${path}: ${(e as Error).message}`);
  }
  // Fail-closed on loose perms: the file holds a bearer token and must be owner-only.
  // Any group/other rwx bit set (0o077) → refuse. (0o777 mask gives the octal string.)
  if ((mode & 0o077) !== 0) {
    const octal = (mode & 0o777).toString(8).padStart(3, '0');
    throw new TeamConfigError(
      `${path} is group/world-readable (mode ${octal}) — it holds a bearer token and must be 0600. ` +
        `Run: chmod 600 ${path}`,
    );
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new TeamConfigError(`cannot read ${path}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Deliberately DO NOT echo the parser's message: on Node 20+ a syntax error can
    // embed a snippet of the file contents (which may include a token fragment) and
    // index.ts writes this to stderr → the MCP debug log. Keep it content-free.
    throw new TeamConfigError(
      `${path} is not valid JSON — could not parse it. Check for a trailing comma or an unquoted value.`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TeamConfigError(
      `${path} must be a JSON object like { "apiUrl": "...", "apiToken": "..." }`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  const config: TeamConfig = {};
  for (const key of Object.keys(KEY_TO_ENV) as TeamConfigKey[]) {
    if (!(key in obj)) continue; // absent is fine — the value may come from env, or be optional
    // Present-but-invalid (wrong type, empty, or whitespace-only) is a MISTAKE, not an
    // absent value: fail closed with a precise message instead of silently coercing it
    // to "unset" and risking a wrong-mode boot.
    const v = obj[key];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new TeamConfigError(
        `${path}: "${key}" must be a non-empty string. Fix the value, or remove the key.`,
      );
    }
    config[key] = v.trim();
  }
  // A present team.json exists to enter TEAM mode, which is keyed on apiUrl. A file
  // with no usable apiUrl — an empty object, snake_case `api_url`, a typo, or only
  // tenantId/apiToken — is an INCOMPLETE team config, NOT a silent-absent file. Refuse
  // it loudly rather than (a) fall silently through to unlocked local mode [the
  // snake_case trap], or (b) bleed a stray tenantId into local-mode tenant scope. The
  // recognized keys are camelCase: apiUrl / apiToken / tenantId. Listing the file's
  // actual keys makes a snake_case/typo mistake self-diagnosing.
  if (config.apiUrl === undefined) {
    const found = Object.keys(obj);
    throw new TeamConfigError(
      `${path} has no usable "apiUrl" — a team config must set at least ` +
        `{ "apiUrl": "http://..." } (camelCase). Found keys: ${found.length ? found.join(', ') : '(none)'}. ` +
        `Fix the spelling, or remove the file to run the local brain.`,
    );
  }
  return { present: true, config, path };
}

/**
 * Fill any of the three team env keys the environment left ABSENT from a loaded
 * team.json. Mutates `env` in place — index.ts calls this BEFORE dynamic-importing
 * the selected mode, so remote-server.ts / config.ts read the merged values with no
 * change to how they read env. Real env always wins (isConfigured); team.json only
 * fills gaps. Returns the list of env keys it filled (for the boot log — values are
 * NEVER logged).
 */
export function applyTeamConfig(env: NodeJS.ProcessEnv, result: TeamConfigResult): string[] {
  if (!result.present || result.config === undefined) return [];
  const filled: string[] = [];
  for (const key of Object.keys(KEY_TO_ENV) as TeamConfigKey[]) {
    const envName = KEY_TO_ENV[key];
    const fileVal = result.config[key];
    if (fileVal !== undefined && !isConfigured(env[envName])) {
      env[envName] = fileVal;
      filled.push(envName);
    }
  }
  return filled;
}
