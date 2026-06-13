import type { ContactResidentType } from '@/lib/types/contacts';

/** resident_type → Hebrew label + DESIGN.md §10 badge tone (owner=blue, tenant=violet, operator=amber). */
export const RESIDENT_TYPE_META: Record<
  ContactResidentType,
  { label: string; badge: string }
> = {
  owner: { label: 'בעלים', badge: 'bg-blue-100 text-blue-700' },
  tenant: { label: 'שוכר', badge: 'bg-violet-100 text-violet-600' },
  operator: { label: 'מפעיל', badge: 'bg-amber-100 text-amber-700' },
};

export const RESIDENT_TYPES: ReadonlyArray<{ value: ContactResidentType; label: string }> = [
  { value: 'owner', label: 'בעלים' },
  { value: 'tenant', label: 'שוכר' },
  { value: 'operator', label: 'מפעיל' },
];

export function residentTypeLabel(t: ContactResidentType): string {
  return RESIDENT_TYPE_META[t]?.label ?? t;
}
