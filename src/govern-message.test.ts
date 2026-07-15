import { describe, expect, it } from 'vitest';
import { formatGovernMessage } from './govern-message.js';

const zeros = {
  ingested: 0,
  processed: 0,
  promoted: 0,
  rejected: 0,
  flagged: 0,
  duplicates: 0,
  quarantined: 0,
  skipped: 0,
  indexUpdated: true,
};

describe('formatGovernMessage', () => {
  it('idle all-zeros is not a failure — names empty spool/inbox and next step', () => {
    const msg = formatGovernMessage(zeros);
    expect(msg).toMatch(/not a failure/i);
    expect(msg).toMatch(/empty/i);
    expect(msg).toMatch(/brain_capture|\/brain-save/);
    expect(msg).not.toMatch(/^Governed 0 inbox/);
  });

  it('idle with missing index still mentions qmd', () => {
    const msg = formatGovernMessage({ ...zeros, indexUpdated: false });
    expect(msg).toMatch(/qmd/i);
  });

  it('non-idle keeps the counts summary', () => {
    const msg = formatGovernMessage({
      ingested: 2,
      processed: 3,
      promoted: 1,
      rejected: 1,
      flagged: 0,
      duplicates: 1,
      quarantined: 0,
      skipped: 0,
      indexUpdated: true,
    });
    expect(msg).toMatch(/^Governed 3 inbox candidate/);
    expect(msg).toContain('2 newly ingested');
    expect(msg).toContain('1 promoted');
    expect(msg).toContain('1 rejected');
    expect(msg).toContain('1 duplicate');
  });

  it('includes skipped when > 0', () => {
    const msg = formatGovernMessage({
      ingested: 0,
      processed: 1,
      promoted: 0,
      rejected: 0,
      flagged: 0,
      duplicates: 0,
      quarantined: 0,
      skipped: 1,
      indexUpdated: true,
    });
    expect(msg).toContain('1 skipped');
    expect(msg).not.toMatch(/not a failure/i);
  });
});
