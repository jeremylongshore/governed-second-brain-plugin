import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { flock, flockSync } from 'fs-ext';

/**
 * Cross-process write serialization for the local brain — a `flock(2)` advisory
 * lock on `<teamkb base>/.write.lock`.
 *
 * WHY flock(2) specifically: the shell cron wrappers (`~/bin/teamkb-backup.sh`,
 * `~/bin/teamkb-compile-daily.sh`) already serialize every `~/.teamkb` write with
 * `/usr/bin/flock` on this exact file. A local-mode `brain_govern` /
 * `brain_transition` that took NO lock could land a multi-artifact write between
 * the 04:30 backup's `VACUUM INTO` and its `tar`, producing a restored brain whose
 * own verifier falsely reports "TAMPER DETECTED"; concurrent anchor appends fork
 * the anchor log. So the plugin MUST take THE SAME lock the cron takes.
 *
 * `/usr/bin/flock` uses the `flock(2)` syscall (LOCK_EX). A mkdir/PID-lockfile
 * library (proper-lockfile, lockfile) uses a DIFFERENT mechanism and does NOT
 * interoperate with it. Node has no built-in flock, so we use `fs-ext` (a small
 * native addon that wraps `flock(2)` directly) — the only way to contend for the
 * same kernel lock the cron holds. Local mode already carries a native dep
 * (better-sqlite3, externalized from the bundle); fs-ext is externalized the same
 * way (see build.mjs / bin/init.mjs).
 *
 * The lock is held on the OPEN FILE DESCRIPTION: it dies with the holding process
 * (a crashed writer never leaves a stale lock — flock(2) reclaims it), and it is
 * released explicitly on `release()`.
 */

const LOCK_FILENAME = '.write.lock';

/** Bounded wait before we give up and report the brain busy (ms). */
const DEFAULT_TIMEOUT_MS = 8000;

/** Poll interval between non-blocking acquire attempts (ms). */
const RETRY_INTERVAL_MS = 100;

/**
 * Thrown when the write lock could not be acquired within the bounded wait —
 * another writer (an interactive govern/transition, or the cron backup/compile
 * holding `/usr/bin/flock`) is mid-write. Callers surface this as a clean, retryable
 * result rather than hanging the MCP.
 */
export class WriteLockBusyError extends Error {
  constructor(message = 'brain busy — another write in progress, retry') {
    super(message);
    this.name = 'WriteLockBusyError';
  }
}

/** A held write lock. Call `release()` exactly once (callers use try/finally). */
export interface WriteLockHandle {
  release(): void;
}

/** Promise wrapper over the async, non-blocking `flock(fd, 'exnb')`. */
function tryFlockExclusive(fd: number): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => {
    flock(fd, 'exnb', (err) => resolve(err ?? null));
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Contention error codes returned by a non-blocking flock when the lock is held. */
function isContention(err: NodeJS.ErrnoException): boolean {
  return err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK';
}

/**
 * Acquire the exclusive advisory write lock for the brain rooted at `basePath`.
 *
 * Non-blocking `flock(fd, 'exnb')` is retried on the libuv threadpool every
 * {@link RETRY_INTERVAL_MS} until it succeeds or the bounded wait elapses — the
 * Node event loop is never blocked, so the MCP stays responsive. On contention
 * past the deadline it throws {@link WriteLockBusyError}; on any other flock/fs
 * error it rethrows that error. Always pair with `handle.release()` in a `finally`.
 */
export async function acquireWriteLock(
  basePath: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<WriteLockHandle> {
  mkdirSync(basePath, { recursive: true });
  const lockPath = join(basePath, LOCK_FILENAME);
  // 'a' = create-if-absent, never truncate. The file is a pure lock token; its
  // bytes are never read or written — only the kernel flock on its descriptor matters.
  const fd = openSync(lockPath, 'a');
  const deadline = Date.now() + Math.max(0, timeoutMs);

  for (;;) {
    const err = await tryFlockExclusive(fd);
    if (!err) {
      return {
        release() {
          // Explicit unlock, then close. Closing the fd alone already releases the
          // flock (the lock lives on the open file description), so the unlock is
          // belt-and-suspenders; the close is what always runs.
          try {
            flockSync(fd, 'un');
          } catch {
            /* unlock best-effort — the close below releases the lock regardless */
          } finally {
            try {
              closeSync(fd);
            } catch {
              /* already closed / invalid fd — nothing to reclaim */
            }
          }
        },
      };
    }
    if (!isContention(err)) {
      // A real error (bad fd, EINTR loop exhausted, etc.) — don't spin; surface it.
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
      throw err;
    }
    if (Date.now() >= deadline) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
      throw new WriteLockBusyError();
    }
    await sleep(RETRY_INTERVAL_MS);
  }
}

/**
 * Run `fn` while holding the brain's exclusive write lock, releasing it on the way
 * out whether `fn` resolves or throws. Throws {@link WriteLockBusyError} if the lock
 * cannot be acquired within the bounded wait.
 */
export async function withWriteLock<T>(
  basePath: string,
  fn: () => Promise<T> | T,
  timeoutMs?: number,
): Promise<T> {
  const handle = await acquireWriteLock(basePath, timeoutMs);
  try {
    return await fn();
  } finally {
    handle.release();
  }
}
