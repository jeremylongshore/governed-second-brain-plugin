import { randomUUID } from 'node:crypto';
import { GovernancePolicy } from '@qmd-team-intent-kb/schema';
import type { PolicyRepository } from '@qmd-team-intent-kb/store';

/**
 * Seed a minimal default governance policy for LOCAL mode — ONCE per tenant.
 *
 * Without a policy row, the Curator (apps/curator processSingle) auto-approves
 * every non-duplicate candidate: `policyRepo.findByTenant(tenantId).find(p =>
 * p.enabled)` returns undefined → straight promote. The always-on disclosure
 * choke point (CandidateRepository.insert) still blocks secrets/PII/comp — but
 * it throws at insert and writes NO governance receipt. Seeding a tiny policy
 * gives local mode *receipted* rejections for the safety-critical rules, matching
 * the team server's posture on the rules that actually matter.
 *
 * Deliberately minimal — only `reject` rules with no human-review loop on a
 * single-user machine: `source_trust` / `relevance_score` would strand items as
 * `flagged` with nobody to review them, and `tenant_match` is moot for one local
 * tenant. Idempotent: inserts only if the tenant has no policy yet. Built via
 * `GovernancePolicy.parse()` so Zod applies/validates every field (a raw literal
 * would skip the `enabled` defaults and the pipeline would enforce zero rules).
 *
 * @returns true if a policy was seeded, false if one already existed.
 */
export function seedDefaultPolicy(policyRepo: PolicyRepository, tenantId: string): boolean {
  if (policyRepo.findByTenant(tenantId).length > 0) return false;
  const now = new Date().toISOString();
  const policy = GovernancePolicy.parse({
    id: randomUUID(),
    name: 'local-default',
    tenantId,
    enabled: true,
    version: 1,
    createdAt: now,
    updatedAt: now,
    rules: [
      {
        id: 'secret-detection',
        type: 'secret_detection',
        action: 'reject',
        enabled: true,
        priority: 0,
        parameters: {},
        description:
          'Reject candidates containing credentials/secrets — a receipted backstop to the always-on disclosure choke point.',
      },
      {
        id: 'content-length',
        type: 'content_length',
        action: 'reject',
        enabled: true,
        priority: 10,
        // NOTE: the content_length rule reads parameters['min'] (default 10) —
        // NOT 'minLength' (a 'minLength' key is silently ignored).
        parameters: { min: 25 },
        description: 'Reject too-short candidates (<25 chars) — low-signal noise.',
      },
    ],
  });
  policyRepo.insert(policy);
  return true;
}
