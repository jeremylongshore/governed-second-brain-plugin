import { appendAnchor, type AuditRepository } from '@qmd-team-intent-kb/store';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * External anchor of the audit chain head after a durable write — the snapshot
 * `verifyAnchors` cross-checks a later local rewrite against. `committed` is
 * true when the anchor log's git commit succeeded; when there is no `origin`
 * remote it is still `true` (the local git history IS the witness until a remote
 * is added — the standalone verifier reports that honestly as
 * `UNPUSHED_LOCAL_WITNESS`, so callers must NOT read `committed:true` as external
 * tamper-evidence).
 */
export interface AnchorResult {
  chainHead: string;
  chainedRows: number;
  committed: boolean;
}

/**
 * Commit the anchor log to a small git repo under <base>/audit, so a later local
 * rewrite of the audit chain is detectable against git's content-addressed
 * history. If the user has added a remote to that repo, push to it — that remote
 * is the true external tamper-evidence (an offline editor cannot quietly rewrite
 * a pushed history). Best-effort: never fails the caller's write path.
 *
 * The LOCAL steps (init/add/commit) stay synchronous — they are fast local-disk
 * ops and the returned `committed` must reflect the local commit synchronously.
 * The `git push` is the ONLY network I/O; on a hot path (brain_transition now
 * anchors per write) a synchronous push would block the Node event loop / freeze
 * the MCP server on network latency. So the push is fired non-blocking:
 * `execFile` in fire-and-forget callback form with a bounded 15s timeout, errors
 * swallowed. `committed` is the local-commit success — the push is a background
 * bonus external witness; until it lands the standalone verifier reports the
 * anchor as UNPUSHED_LOCAL_WITNESS, so `committed:true` is not claimed as
 * external tamper-evidence.
 */
function commitAnchor(auditDir: string): boolean {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'governed-brain',
    GIT_AUTHOR_EMAIL: 'anchor@localhost',
    GIT_COMMITTER_NAME: 'governed-brain',
    GIT_COMMITTER_EMAIL: 'anchor@localhost',
  };
  const git = (args: string[]) => execFileSync('git', args, { cwd: auditDir, stdio: 'ignore', env });
  try {
    if (!existsSync(join(auditDir, '.git'))) git(['init', '-q']);
    git(['add', 'anchors.jsonl']);
    git(['commit', '-q', '-m', `anchor ${new Date().toISOString()}`]);
    try {
      execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: auditDir, stdio: 'ignore' });
      // Fire-and-forget: never blocks the event loop, never rejects. The empty
      // callback swallows any push error (offline, auth, timeout); the local
      // commit above is already the witness until the push lands.
      execFile('git', ['push', '-q', 'origin', 'HEAD'], { cwd: auditDir, timeout: 15_000, env }, () => {});
    } catch {
      /* no remote configured — local git history is the anchor until one is added */
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Snapshot the current audit chain head to the append-only, hash-chained anchor
 * log under `<basePath>/audit/anchors.jsonl` and commit it to git (the
 * tamper-evidence `verifyAnchors` checks against). Shared by every durable
 * audit-write path — the govern pass (`runGovern`) AND lifecycle transitions
 * (`brain_transition`) — so each durable write narrows the rewrite-detection
 * window to one write rather than one govern cycle.
 *
 * Best-effort by contract: NEVER throws. On any failure (mkdir, appendAnchor, or
 * commit) it returns `undefined`; the caller keeps its own write and surfaces the
 * absent anchor honestly. `committed` may be `true` while unpushed (no remote) —
 * that is a local-only witness, not external tamper-evidence (see AnchorResult).
 */
export function anchorChainHead(
  auditRepo: AuditRepository,
  basePath: string,
  tenantId: string,
): AnchorResult | undefined {
  try {
    const auditDir = join(basePath, 'audit');
    mkdirSync(auditDir, { recursive: true });
    const rec = appendAnchor(auditRepo, join(auditDir, 'anchors.jsonl'), { tenantId });
    return {
      chainHead: rec.chainHead,
      chainedRows: rec.chainedRows,
      committed: commitAnchor(auditDir),
    };
  } catch {
    return undefined;
  }
}
