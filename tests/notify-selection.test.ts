import { describe, it, expect } from 'vitest';
import { channelsToSelection, coerceNotifySelection, EMPTY_CHANNELS } from '@/lib/notify/selection';

// The global channel cards must expand into the recipient-keyed selection the
// routes consume — and survive coerceNotifySelection (server ingest) intact.
describe('channelsToSelection', () => {
  it('expands the chosen channels over every handler key', () => {
    const sel = channelsToSelection({ email: true, whatsapp: false }, ['user:a', 'supplier:b']);
    expect(sel).toEqual({
      'user:a': { email: true, whatsapp: false },
      'supplier:b': { email: true, whatsapp: false },
    });
  });

  it('no channel selected → empty (nothing sent)', () => {
    expect(channelsToSelection(EMPTY_CHANNELS, ['user:a'])).toEqual({});
  });

  it('no handler → empty (no recipient → nothing sent)', () => {
    expect(channelsToSelection({ email: true, whatsapp: true }, [])).toEqual({});
  });

  it('survives server coercion unchanged', () => {
    const sel = channelsToSelection({ email: false, whatsapp: true }, ['user:a']);
    expect(coerceNotifySelection(sel)).toEqual(sel);
  });
});
