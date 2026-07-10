/**
 * Governed Second Brain — mode resolution (the local-vs-team dispatch predicate).
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

/** Resolve the runtime mode from a raw TEAMKB_API_URL env value (untrimmed). */
export function resolveMode(rawTeamkbApiUrl: string | undefined): ResolvedMode {
  const raw = rawTeamkbApiUrl?.trim();
  const apiUrl = raw !== undefined && raw !== '' && !raw.startsWith('${') ? raw : undefined;
  return apiUrl !== undefined ? { mode: 'team', apiUrl } : { mode: 'local' };
}
