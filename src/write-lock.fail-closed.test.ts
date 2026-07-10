import { mkdtempSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * Fail-closed guarantee (R9 review finding): if the native `flock` throws
 * SYNCHRONOUSLY — an fs-ext native load/runtime failure — `acquireWriteLock` must
 * (a) surface the error and (b) close the fd it opened, so no fd leaks AND no
 * caller can proceed to write while UNLOCKED (which would reintroduce the exact
 * backup/write race the lock exists to prevent). This mock makes `flock` throw;
 * it is file-scoped, so the real-flock tests in write-lock.test.ts are unaffected.
 */
vi.mock('fs-ext', () => ({
  flock: () => {
    throw new Error('simulated fs-ext native failure');
  },
  flockSync: () => {},
}));

// Imported AFTER the (hoisted) mock so write-lock binds to the throwing flock.
import { acquireWriteLock } from './write-lock.js';

const isLinux = platform() === 'linux';

/** Count currently-open fds pointing at `lockPath` (Linux /proc). Leak detector. */
function lockFdCount(lockPath: string): number {
  let n = 0;
  for (const fd of readdirSync('/proc/self/fd')) {
    try {
      if (readlinkSync(join('/proc/self/fd', fd)) === lockPath) n += 1;
    } catch {
      /* fd vanished between readdir and readlink — ignore */
    }
  }
  return n;
}

describe('write lock — fail-closed on a synchronous flock failure', () => {
  it('surfaces the error and does not leak the fd (never proceeds unlocked)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'gsb-lock-fc-'));
    const lockPath = join(base, '.write.lock');
    try {
      const before = isLinux ? lockFdCount(lockPath) : 0;

      // The synchronous flock throw must become a rejection of acquireWriteLock —
      // NOT a hang, NOT a silent success (which would let a caller write unlocked).
      await expect(acquireWriteLock(base, 1000)).rejects.toThrow(/simulated fs-ext native failure/);

      // And the fd opened during the failed acquire must have been closed.
      if (isLinux) expect(lockFdCount(lockPath)).toBe(before);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
