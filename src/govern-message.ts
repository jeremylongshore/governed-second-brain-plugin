/**
 * Human-facing message for one local-mode brain_govern result.
 * Pure string formatting — no DB, no qmd packages (CI-safe).
 *
 * Empty-spool / empty-inbox all-zeros used to look like a silent failure
 * ("Governed 0 inbox candidate(s)…"). Callers need to know that is the
 * healthy idle state, not a stuck pipeline.
 */
export interface GovernMessageInput {
  ingested: number;
  processed: number;
  promoted: number;
  rejected: number;
  flagged: number;
  duplicates: number;
  quarantined: number;
  skipped: number;
  indexUpdated: boolean;
}

export function formatGovernMessage(s: GovernMessageInput): string {
  const idle =
    s.ingested === 0 &&
    s.processed === 0 &&
    s.promoted === 0 &&
    s.rejected === 0 &&
    s.flagged === 0 &&
    s.duplicates === 0 &&
    s.quarantined === 0 &&
    s.skipped === 0;

  if (idle) {
    let message =
      'Nothing to govern — spool and inbox are empty (not a failure). ' +
      'Capture something first with /brain-save (or brain_capture), then run brain_govern again.';
    if (!s.indexUpdated) {
      message +=
        ' Search index not refreshed — install qmd 2.x on PATH and re-run brain_govern to make new memories searchable.';
    }
    return message;
  }

  const parts = [
    `${s.promoted} promoted`,
    `${s.quarantined} quarantined`,
    `${s.rejected} rejected`,
    `${s.duplicates} duplicate`,
    `${s.flagged} flagged`,
  ];
  if (s.skipped > 0) parts.push(`${s.skipped} skipped`);
  let message = `Governed ${s.processed} inbox candidate(s) (${s.ingested} newly ingested): ${parts.join(', ')}.`;
  if (!s.indexUpdated) {
    message +=
      ' Search index not refreshed — install qmd 2.x on PATH and re-run brain_govern to make new memories searchable.';
  }
  return message;
}
