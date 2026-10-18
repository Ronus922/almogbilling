import { describe, expect, it } from 'vitest';
import {
  buildPrimaryRecipientCandidates, mergeRecipientCandidates, extraRecipientLabel,
  WHATSAPP_SEND_MAX_RECIPIENTS,
} from '@/lib/whatsapp-recipients';
import { whatsappSendRecipientsSchema } from '@/lib/validation/requests';

// The multi-recipient single-send feature (18/10/2026): checkboxes instead of
// a radio in WhatsAppSendForm, same candidate-building logic shared with the
// server route so the two never disagree about which phones are valid.

describe('buildPrimaryRecipientCandidates', () => {
  it('labels the owner and tenant fields by their role, not the string', () => {
    expect(buildPrimaryRecipientCandidates({ phone_owner: '0501234567', phone_tenant: null }))
      .toEqual([{ phone: '972501234567', label: 'בעלים' }]);
    expect(buildPrimaryRecipientCandidates({ phone_owner: '0501234567', phone_tenant: '0507654321' }))
      .toEqual([{ phone: '972501234567', label: 'בעלים' }, { phone: '972507654321', label: 'שוכר/ת' }]);
  });

  it('drops the tenant candidate when it is the same number as the owner', () => {
    expect(buildPrimaryRecipientCandidates({ phone_owner: '0501234567', phone_tenant: '0501234567' }))
      .toEqual([{ phone: '972501234567', label: 'בעלים' }]);
  });

  it('both fields empty/invalid → no candidates', () => {
    expect(buildPrimaryRecipientCandidates({ phone_owner: null, phone_tenant: null })).toEqual([]);
    expect(buildPrimaryRecipientCandidates({ phone_owner: '', phone_tenant: '' })).toEqual([]);
  });
});

describe('mergeRecipientCandidates', () => {
  it('appends extras after the primary list, in order', () => {
    const primary = [{ phone: '972501111111', label: 'בעלים' }];
    const extra = [{ phone: '972502222222', label: 'בעלים נוסף' }];
    expect(mergeRecipientCandidates(primary, extra)).toEqual([...primary, ...extra]);
  });

  it('drops an extra whose phone is already in the primary list', () => {
    const primary = [{ phone: '972501111111', label: 'בעלים' }];
    const extra = [{ phone: '972501111111', label: 'בעלים נוסף' }, { phone: '972502222222', label: 'שוכר נוסף' }];
    expect(mergeRecipientCandidates(primary, extra)).toEqual([
      { phone: '972501111111', label: 'בעלים' },
      { phone: '972502222222', label: 'שוכר נוסף' },
    ]);
  });
});

describe('extraRecipientLabel', () => {
  it('names the role alone with no name, or "role · name" with one — the same shape the client and server must agree on', () => {
    expect(extraRecipientLabel('owner', null)).toBe('בעלים נוסף');
    expect(extraRecipientLabel('tenant', null)).toBe('שוכר נוסף');
    expect(extraRecipientLabel('owner', 'דנה כהן')).toBe('בעלים נוסף · דנה כהן');
    expect(extraRecipientLabel('tenant', 'יוסי לוי')).toBe('שוכר נוסף · יוסי לוי');
  });
});

describe('whatsappSendRecipientsSchema', () => {
  it('absent is fine (legacy single-phone callers never send it)', () => {
    expect(whatsappSendRecipientsSchema.safeParse(undefined).success).toBe(true);
    expect(whatsappSendRecipientsSchema.safeParse(undefined).data).toBeUndefined();
  });

  it('accepts up to the cap, refuses one more', () => {
    const phones = (n: number) => Array.from({ length: n }, (_, i) => `97250${String(i).padStart(7, '0')}`);
    expect(whatsappSendRecipientsSchema.safeParse(phones(WHATSAPP_SEND_MAX_RECIPIENTS)).success).toBe(true);
    const over = whatsappSendRecipientsSchema.safeParse(phones(WHATSAPP_SEND_MAX_RECIPIENTS + 1));
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.message).toMatch(new RegExp(`עד ${WHATSAPP_SEND_MAX_RECIPIENTS} נמענים`));
  });

  it('refuses an empty string entry', () => {
    expect(whatsappSendRecipientsSchema.safeParse(['972501234567', '']).success).toBe(false);
  });

  it('refuses a non-array', () => {
    expect(whatsappSendRecipientsSchema.safeParse('972501234567').success).toBe(false);
    expect(whatsappSendRecipientsSchema.safeParse(123).success).toBe(false);
  });
});
