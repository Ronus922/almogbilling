import { describe, expect, it } from 'vitest';
import { parseBulkLine } from '@/lib/whatsapp-bulk-stream';

// The bulk-send panel reads POST /api/whatsapp/send-bulk as NDJSON. It used to
// take every line that was not "progress" for the final summary, so the first
// new line type (the "waiting" line, 08/11/2026) would have been shown as one.

describe('parseBulkLine', () => {
  it('passes the three known line types through', () => {
    const progress = { type: 'progress', index: 1, total: 3, apartment: '4', status: 'sent' };
    const waiting = { type: 'waiting', index: 2, total: 3, waited_ms: 0, per_min: 12 };
    const summary = { type: 'summary', sent: 3, failed: 0, skipped: 0, failures: [] };
    expect(parseBulkLine(JSON.stringify(progress))).toEqual(progress);
    expect(parseBulkLine(JSON.stringify(waiting))).toEqual(waiting);
    expect(parseBulkLine(JSON.stringify(summary))).toEqual(summary);
  });

  it('ignores a line it does not know instead of taking it for the summary', () => {
    expect(parseBulkLine(JSON.stringify({ type: 'something-new', x: 1 }))).toBeNull();
    expect(parseBulkLine(JSON.stringify({ sent: 3, failed: 0 }))).toBeNull();
  });

  it('ignores garbage', () => {
    expect(parseBulkLine('')).toBeNull();
    expect(parseBulkLine('not json')).toBeNull();
    expect(parseBulkLine('null')).toBeNull();
    expect(parseBulkLine('42')).toBeNull();
    expect(parseBulkLine('"progress"')).toBeNull();
  });
});
