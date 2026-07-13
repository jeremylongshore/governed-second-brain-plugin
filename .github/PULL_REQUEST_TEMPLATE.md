## Summary

<!-- Describe your changes in 1-3 bullet points -->

-
-
-

## Type of Change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to change)
- [ ] Documentation (updates to docs, comments, or README)
- [ ] Refactor (code change that neither fixes a bug nor adds a feature)
- [ ] CI/CD (changes to build process, workflows, or tooling)

## Checklist

- [ ] Tests pass locally (`pnpm lint` · `pnpm typecheck:ci` · `pnpm test:coverage` · `node --test scripts/verify-anchors.test.mjs`)
- [ ] Full-chain smoke passes if runtime behavior changed (`node smoke/smoke.mjs`)
- [ ] Hash-pinned gate configs re-pinned after any reviewed edit (`npx audit-harness init`)
- [ ] No secrets or credentials committed
- [ ] Commits follow conventional commit format
- [ ] Documentation updated (if applicable)
- [ ] Self-reviewed the diff before requesting review

## Trust-model / local-first check

<!-- The audit trail is tamper-EVIDENT, not tamper-proof; the plugin is local-first. See SECURITY.md + CONTRIBUTING.md. -->

- [ ] No copy implying "immutable" / "tamper-proof" / "non-repudiation" for local mode
- [ ] No new network egress or external sharing without an explicit, opt-in, labeled consent surface
- [ ] The model does not write durable state directly — the govern kernel still owns it

## Testing

<!-- Describe the tests you ran and how to reproduce them -->

## Related Issues

<!-- Link related issues below. Use "Closes #123" to auto-close on merge -->

Closes #
