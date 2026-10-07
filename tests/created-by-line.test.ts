import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CreatedByLine } from '@/components/shared/CreatedByLine';

// The card footer shared by the issues kanban, the tasks kanban and the worker
// issue cards: "נוצר ע״י <name> · DD/MM/YYYY HH:mm" on the Israel clock, the
// time alone when the row has no creator snapshot.

const html = (name: string | null, createdAt: string, className?: string) =>
  renderToStaticMarkup(createElement(CreatedByLine, { name, createdAt, className }));

describe('CreatedByLine', () => {
  it('names the creator and stamps the Postgres timestamp in Israel time', () => {
    const h = html('עמאד פראח', '2026-10-04 19:13:24.220808+00');
    expect(h).toContain('נוצר ע״י עמאד פראח · ');
    expect(h).toContain('<span dir="ltr" class="font-num tabular-nums whitespace-nowrap">04/10/2026 22:13</span>');
  });

  it('shows the time alone for a row without a creator', () => {
    for (const name of [null, '', '   ']) {
      const h = html(name, '2026-07-27 07:53:54.835411+00');
      expect(h).not.toContain('נוצר ע״י');
      expect(h).toContain('27/07/2026 10:53');
    }
  });

  it('keeps the muted footer tokens and appends the caller placement', () => {
    const h = html('ישראל ישראלי', '2026-10-04 19:13:24+00', 'self-stretch');
    expect(h).toContain('class="border-t border-slate-200 pt-2 text-xs text-muted-foreground self-stretch"');
  });
});
