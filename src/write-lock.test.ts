import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireWriteLock, WriteLockBusyError, withWriteLock } from './write-lock.js';

/**
 * The local-mode write lock (R9 / Gate-1). The whole point is that it takes THE
 * SAME `flock(2)` lock the cron backup/compile wrappers take via `/usr/bin/flock`,
 * so these tests assert BOTH ends: (a) two in-process acquisitions serialize, and
 * (b) — the load-bearing one — the lock actually contends against a real
 * `/usr/bin/flock -x` holder. `fs-ext` (native) + `/usr/bin/flock` are present on
 * Linux CI; the interop test skips cleanly where the CLI is absent (e.g. macOS).
 */

const FLOCK_CLI = '/usr/bin/flock';
const hasFlockCli = existsSync(FLOCK_CLI);

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'gsb-lock-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('write lock — in-process serialization', () => {
  it('acquires, then blocks a second acquisition until the first releases', async () => {
    const first = await acquireWriteLock(base, 5000);

    // Second acquisition contends; with a short budget it must report busy, not hang.
    await expect(acquireWriteLock(base, 250)).rejects.toBeInstanceOf(WriteLockBusyError);

    first.release();

    // Now it is free again.
    const second = await acquireWriteLock(base, 5000);
    second.release();
  });

  it('withWriteLock releases even when the body throws', async () => {
    await expect(
      withWriteLock(base, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // If the lock leaked, this would time out as busy; it must acquire cleanly.
    const lock = await acquireWriteLock(base, 2000);
    lock.release();
  });

  it('WriteLockBusyError carries a clean, retryable message', () => {
    expect(new WriteLockBusyError().message).toMatch(/brain busy/i);
  });
});

describe.skipIf(!hasFlockCli)('write lock — interop with /usr/bin/flock (the cron lock)', () => {
  /** Hold LOCK_EX on `<base>/.write.lock` via the real flock CLI for `holdMs`. */
  function holdViaCli(holdMs: number) {
    const lockPath = join(base, '.write.lock');
    const child = spawn(FLOCK_CLI, ['-x', lockPath, '-c', `sleep ${holdMs / 1000}`], {
      stdio: 'ignore',
    });
    const exited = new Promise<void>((r) => child.on('exit', () => r()));
    return { child, exited };
  }

  it('reports busy while /usr/bin/flock holds the lock, then acquires after it releases', async () => {
    const { exited } = holdViaCli(1200);
    await sleep(300); // let the CLI grab LOCK_EX first

    // While the cron-equivalent holds it, our acquire must contend and report busy.
    await expect(acquireWriteLock(base, 400)).rejects.toBeInstanceOf(WriteLockBusyError);

    await exited; // CLI releases
    await sleep(150);

    // Same file, same kernel lock — now free.
    const lock = await acquireWriteLock(base, 3000);
    lock.release();
  });

  it('a patient acquire that outlasts the CLI hold succeeds (bounded wait, no hang)', async () => {
    const { exited } = holdViaCli(600);
    await sleep(200);

    // Budget exceeds the hold: it should wait out the CLI and then acquire.
    const lock = await acquireWriteLock(base, 5000);
    lock.release();
    await exited;
  });
});
