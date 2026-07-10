import tseslint from 'typescript-eslint';

/**
 * Flat ESLint config for the plugin's TypeScript source.
 *
 * Deliberately NON-type-checked (typescript-eslint `recommended`, not
 * `recommendedTypeChecked`): the type-aware rules would need a full tsc program,
 * which requires the private sibling monorepo (@qmd-team-intent-kb/*) that does
 * not exist in CI. Parse-only linting still catches the real bug classes
 * (no-unused-vars, no-floating-promises-adjacent smells, unsafe patterns) across
 * every src file, including the ones that import the workspace — and runs in plain
 * CI with no workspace resolution.
 */
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'plugin-runtime/**',
      'changelogs/**',
      'coverage/**',
      'assets/**',
      '**/*.cjs',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.test.ts'],
    rules: {
      // Tests legitimately reach for loose shapes when stubbing fetch/env.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
