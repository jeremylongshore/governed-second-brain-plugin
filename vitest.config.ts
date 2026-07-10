import { defineConfig } from 'vitest/config';

/**
 * Unit-test config for the plugin's CI-safe TypeScript surface.
 *
 * Only src/mode.ts (the dispatch predicate) and src/remote-server.ts (the team
 * proxy) can be exercised without the private sibling monorepo (@qmd-team-intent-kb/*)
 * and better-sqlite3 — the same constraint that keeps smoke.yml from building in
 * CI. Coverage is therefore scoped to exactly those two files so the floor is an
 * honest number for the surface these unit tests own, not diluted by modules that
 * are only reachable through the full local stack (covered by smoke.yml instead).
 *
 * Both suites run: src/**\/*.test.ts (mode + remote-server unit tests) and
 * test/**\/*.test.ts (the R4 error-surfacing suite). The pre-existing smoke/ and
 * scripts/ suites use the node:test runner (`node --test`, via their own npm
 * scripts) — vitest must not adopt them, so neither glob reaches into them.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/mode.ts', 'src/remote-server.ts'],
      reporter: ['text', 'lcov'],
      // Honest floor just under the current measured numbers (lines 57 / stmts 54
      // / funcs 50 / branch 49). The pure helpers (resolveMode, errorResult,
      // authHeaders, search) are covered; the brain_capture / brain_transition
      // tool handlers + stdio boot in remote-server.ts are exercised by smoke.yml
      // over a real MCP session, not here — so the file-level floor is modest by
      // design. Ratchet up as the unit surface grows; never down.
      thresholds: {
        lines: 55,
        statements: 50,
        functions: 45,
        branches: 45,
      },
    },
  },
});
