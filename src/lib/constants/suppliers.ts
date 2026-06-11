import {
  Briefcase,
  Wrench,
  Zap,
  Wind,
  Sparkles,
  ShieldCheck,
  Trees,
  HardHat,
  Armchair,
  UtensilsCrossed,
  WashingMachine,
  ArrowUpDown,
  Bug,
  MoreHorizontal,
  type LucideIcon,
} from 'lucide-react';
import type {
  SupplierStatus,
  SupplierPaymentTerms,
  SupplierDocType,
} from '@/lib/types/suppliers';

/**
 * Status → DESIGN.md tone name (NOT hardcoded bg/text classes). The badge
 * component resolves the tone to DESIGN.md tone-variant classes.
 */
export type DesignTone = 'emerald' | 'slate' | 'amber';

export const SUPPLIER_STATUSES: ReadonlyArray<{
  value: SupplierStatus;
  label: string;
  tone: DesignTone;
}> = [
  { value: 'active', label: 'פעיל', tone: 'emerald' },
  { value: 'inactive', label: 'לא פעיל', tone: 'slate' },
  { value: 'archived', label: 'בארכיון', tone: 'amber' },
];

export function supplierStatusMeta(status: SupplierStatus) {
  return SUPPLIER_STATUSES.find((s) => s.value === status) ?? SUPPLIER_STATUSES[0];
}

export const PAYMENT_TERMS: ReadonlyArray<{ value: SupplierPaymentTerms; label: string }> = [
  { value: 'immediate', label: 'מיידי' },
  { value: 'net_15', label: 'שוטף + 15' },
  { value: 'net_30', label: 'שוטף + 30' },
  { value: 'net_45', label: 'שוטף + 45' },
  { value: 'net_60', label: 'שוטף + 60' },
  { value: 'net_90', label: 'שוטף + 90' },
  { value: 'other', label: 'אחר' },
];

export function paymentTermsLabel(value: string): string {
  return PAYMENT_TERMS.find((p) => p.value === value)?.label ?? value;
}

/** Hardcoded supplier-type taxonomy (spec §3). Icons via lucide (not Material Symbols). */
export const SUPPLIER_TYPES: ReadonlyArray<{ value: string; label: string; icon: LucideIcon }> = [
  { value: 'general', label: 'כללי', icon: Briefcase },
  { value: 'plumbing', label: 'אינסטלציה', icon: Wrench },
  { value: 'electrical', label: 'חשמל', icon: Zap },
  { value: 'hvac', label: 'מיזוג אוויר', icon: Wind },
  { value: 'cleaning', label: 'ניקיון', icon: Sparkles },
  { value: 'security', label: 'אבטחה', icon: ShieldCheck },
  { value: 'gardening', label: 'גינון', icon: Trees },
  { value: 'construction', label: 'בנייה/שיפוץ', icon: HardHat },
  { value: 'furniture', label: 'ריהוט', icon: Armchair },
  { value: 'food', label: 'מזון', icon: UtensilsCrossed },
  { value: 'laundry', label: 'כביסה', icon: WashingMachine },
  { value: 'elevator', label: 'מעליות', icon: ArrowUpDown },
  { value: 'pest_control', label: 'הדברה', icon: Bug },
  { value: 'other', label: 'אחר', icon: MoreHorizontal },
];

export function supplierTypeMeta(value: string) {
  return SUPPLIER_TYPES.find((t) => t.value === value) ?? SUPPLIER_TYPES[0];
}

export const DOC_TYPES: ReadonlyArray<{ value: SupplierDocType; label: string }> = [
  { value: 'general', label: 'כללי' },
  { value: 'contract', label: 'חוזה' },
  { value: 'invoice', label: 'חשבונית' },
  { value: 'quote', label: 'הצעת מחיר' },
  { value: 'license', label: 'רישיון' },
  { value: 'insurance', label: 'ביטוח' },
  { value: 'warranty', label: 'אחריות' },
];

export function docTypeLabel(value: string): string {
  return DOC_TYPES.find((d) => d.value === value)?.label ?? value;
}

// Document upload validation (server-enforced).
export const ALLOWED_DOC_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

export const MAX_DOC_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
