/**
 * Bob's Big Brain — mode resolution (the local-vs-team dispatch predicate).
 *
 * Extracted verbatim from the entry point (src/index.ts) so the exact rule that
 * decides whether the plugin runs the in-process LOCAL brain or proxies a remote
 * TEAM brain is a pure, unit-testable function with NO server side effects. The
 * dispatcher imports this; the two modes are still dynamic-imported by index.ts,
 * so only the selected one ever loads.
 *
 * Rule — team iff TEAMKB_API_URL is *genuinely* set:
 *   - undefined / unset                     -> local (the public showcase default)
 *   - '' or whitespace-only                 -> local
 *   - an unexpanded '${...}' shell placeholder (what a host may pass verbatim when
 *     the var is not set in the user's environment) -> local
 *   - any other non-empty value             -> team, apiUrl = the trimmed value
 *
 * The '${...}' guard is the subtle one the 6-engineer review flagged: without it a
 * literal "${TEAMKB_API_URL}" would be treated as a real URL and a misconfigured
 * host would silently run the WRONG brain. Keeping this a named, tested function
 * makes the dispatch decision a first-class, regression-guarded seam.
 */
export type BrainMode = 'local' | 'team';

export interface ResolvedMode {
  mode: BrainMode;
  /** The resolved team API base URL — present iff `mode === 'team'`. */
  apiUrl?: string;
}

/**
 * Is a raw env value GENUINELY set, or an "absent" sentinel?
 *
 * Three things count as absent (all mean "the user did not set this"):
 *   - undefined / unset
 *   - '' or whitespace-only
 *   - an unexpanded '${...}' shell placeholder — what a host passes verbatim for a
 *     manifest env entry whose variable is not set in the launching environment.
 *     A GUI/Dock launch never sources ~/.zshrc, so team vars set there arrive as the
 *     literal placeholder; treating it as absent is what stops a misconfigured host
 *     from silently running the WRONG brain.
 *
 * This is the ONE predicate shared by `resolveMode` (below) and the team.json loader
 * (src/team-config.ts), where the question "should team.json fill this key?" is
 * exactly "is the env value absent?". Extracting it keeps the two call sites from
 * drifting apart on what "set" means.
 */
export function isConfigured(rawValue: string | undefined): boolean {
  const v = rawValue?.trim();
  return v !== undefined && v !== '' && !v.startsWith('${');
}

/** Resolve the runtime mode from a raw TEAMKB_API_URL env value (untrimmed). */
export function resolveMode(rawTeamkbApiUrl: string | undefined): ResolvedMode {
  return isConfigured(rawTeamkbApiUrl)
    ? { mode: 'team', apiUrl: (rawTeamkbApiUrl as string).trim() }
    : { mode: 'local' };
}
