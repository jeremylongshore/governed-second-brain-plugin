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
      include: ['src/mode.ts', 'src/remote-server.ts', 'src/team-config.ts'],
      reporter: ['text', 'lcov'],
      // Honest floor just under the current measured numbers, now including
      // team-config.ts (measured: lines 72.6 / stmts 71.3 / funcs 63.6 / branch 63.6).
      // team-config.ts is thoroughly unit-tested (93%+); the residual gap is entirely
      // remote-server.ts's brain_capture / brain_transition tool handlers + stdio boot,
      // exercised by smoke.yml over a real MCP session (and by smoke/mode-dispatch),
      // not here. Ratchet up as the unit surface grows; never down.
      thresholds: {
        lines: 70,
        statements: 68,
        functions: 60,
        branches: 60,
      },
    },
  },
});
