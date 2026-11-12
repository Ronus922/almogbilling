import type { ChipOrderMatchStatus, ChipOrderRole } from './model';

/**
 * How one apartment line of an order compares with the tenants list
 * (contacts = the source of truth for apartments), decided once when the
 * order is created and stored on the line:
 *   owner, and the ordering phone is one of the apartment's owner phones
 *     (contacts.owner_phone or an extra owner in contact_people) → matched;
 *   owner, another owner is on file                               → review;
 *   owner, no owner on file at all                                → unassigned;
 *   tenant / operator — the lease decides, a person must look     → document_review.
 * Phones are compared in E.164 (+9725XXXXXXXX), normalised by the caller.
 */
export function chipOrderMatchStatus(input: {
  role: ChipOrderRole;
  orderPhoneE164: string;
  ownerPhonesE164: string[];
  ownerOnFile: boolean;
}): ChipOrderMatchStatus {
  if (input.role !== 'owner') return 'document_review';
  if (input.ownerPhonesE164.includes(input.orderPhoneE164)) return 'matched';
  return input.ownerOnFile ? 'review' : 'unassigned';
}
