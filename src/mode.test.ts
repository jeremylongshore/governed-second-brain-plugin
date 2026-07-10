import { describe, expect, it } from 'vitest';
import { resolveMode } from './mode.js';

/**
 * The local-vs-team dispatch predicate (the seam the 6-engineer review flagged as
 * "silently falls into local mode"). Pure function, so the whole decision matrix
 * is pinned here with real assertions and asymmetric inputs — no server boot, no
 * mocks of the function under test.
 */
describe('resolveMode — local-vs-team dispatch', () => {
  it('falls to LOCAL when TEAMKB_API_URL is unset', () => {
    expect(resolveMode(undefined)).toEqual({ mode: 'local' });
  });

  it('falls to LOCAL on an empty string', () => {
    expect(resolveMode('')).toEqual({ mode: 'local' });
  });

  it('falls to LOCAL on a whitespace-only value', () => {
    expect(resolveMode('   ')).toEqual({ mode: 'local' });
  });

  it('falls to LOCAL on an unexpanded ${...} shell placeholder (the review-flagged trap)', () => {
    expect(resolveMode('${TEAMKB_API_URL}')).toEqual({ mode: 'local' });
  });

  it('still treats a ${...} placeholder padded with whitespace as LOCAL', () => {
    expect(resolveMode('  ${TEAMKB_API_URL}  ')).toEqual({ mode: 'local' });
  });

  it('selects TEAM for a real URL and returns the resolved apiUrl', () => {
    expect(resolveMode('http://team-server:3847')).toEqual({
      mode: 'team',
      apiUrl: 'http://team-server:3847',
    });
  });

  it('trims surrounding whitespace before deciding TEAM', () => {
    expect(resolveMode('  http://team-server:3847  ')).toEqual({
      mode: 'team',
      apiUrl: 'http://team-server:3847',
    });
  });

  it('never leaks an apiUrl in local mode', () => {
    expect(resolveMode(undefined).apiUrl).toBeUndefined();
    expect(resolveMode('').apiUrl).toBeUndefined();
  });
});
