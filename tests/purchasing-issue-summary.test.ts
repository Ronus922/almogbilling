import { describe, expect, it } from 'vitest';
import { buildIssueSummary, type IssueResult } from '@/components/purchasing/issueSummary';

const H = 'בקשה להצעת מחיר מספר 7';
const r = (id: string, name: string, channel: 'email' | 'whatsapp', over: Partial<IssueResult> = {}): IssueResult =>
  ({ supplier_id: id, supplier_name: name, channel, ok: true, ...over });

describe('buildIssueSummary', () => {
  it('nothing ticked: issued without sending', () => {
    expect(buildIssueSummary({ heading: H, sending: false, results: null }))
      .toEqual({ level: 'success', message: `${H} הופקה בלי שליחה` });
  });
  it('counts suppliers, not channels', () => {
    const s = buildIssueSummary({ heading: H, sending: true, results: [r('a', 'א', 'email'), r('a', 'א', 'whatsapp'), r('b', 'ב', 'email')] });
    expect(s).toEqual({ level: 'success', message: `${H} הופקה ונשלחה ל-2 ספקים` });
    expect(buildIssueSummary({ heading: H, sending: true, results: [r('a', 'א', 'email')] }).message).toContain('לספק אחד');
  });
  it('names skipped and failed suppliers and warns', () => {
    const s = buildIssueSummary({
      heading: H, sending: true,
      results: [r('a', 'א', 'email'), r('b', 'ב', 'email', { ok: false, skipped: true }), r('c', 'ג', 'email', { ok: false, error: 'x' })],
    });
    expect(s.level).toBe('warning');
    expect(s.message).toContain('דולגו (חסר מייל או טלפון): ב');
    expect(s.message).toContain('השליחה נכשלה: ג');
  });
  it('nobody reached by a failure is an error; a failed send request too', () => {
    expect(buildIssueSummary({ heading: H, sending: true, results: [r('c', 'ג', 'email', { ok: false })] }).level).toBe('error');
    const e = buildIssueSummary({ heading: H, sending: true, results: null, sendError: 'boom', note: 'המספר 7 נתפס בינתיים' });
    expect(e.level).toBe('error');
    expect(e.message).toContain('boom');
    expect(e.message).toContain('נתפס בינתיים');
  });
});
