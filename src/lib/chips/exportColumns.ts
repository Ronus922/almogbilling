import type { ChipWithHolder } from '@/lib/types/chips';
import { CHIP_STATUS_LABEL, CHIP_TYPE_LABEL, RESIDENT_ROLE_LABEL } from '@/lib/constants/chips';
import { exportDate, type ListExport } from '@/lib/export/list-export';
import { DELIVERY_NOTE_LABEL, GUARD_NOTE_LABEL, ORDERER_NOTE_LABEL } from '@/lib/chipOrders/notes';
import { resolveChipHolder } from './holder';

// The chips tab of /chips as a file (25/11/2026): "הדפסה", "ייצוא לאקסל" and
// "הורדה ל-PDF" write the rows the table shows — after the status tabs, the
// search and the one-holder filter — in the columns the table shows. The
// table's first column stacks three facts (the holder's name, and under it
// the apartment and the role); a file holds one fact per column, so here the
// three stand side by side. The holder's name is the one the table shows:
// the live registry name (resolveChipHolder), never the issuance snapshot.
// From 27/11/2026 (Ronen) the order a chip was issued for follows: its number
// and its three notes, each in its own column, as in the Orders tab's file
// (a delivered order lives on in this tab, through its chips). Empty for a
// chip issued without an order, and for a viewer who may not see orders.
export const CHIPS_EXPORT: ListExport<ChipWithHolder> = {
  title: 'צ׳יפים',
  sheet: 'צ׳יפים',
  file: 'chips',
  columns: [
    { header: 'מחזיק', kind: 'text', width: 26, get: (c) => resolveChipHolder(c).name },
    { header: 'דירה', kind: 'ltr', width: 9, get: (c) => c.apartment_number },
    { header: 'תפקיד', kind: 'text', width: 12, get: (c) => RESIDENT_ROLE_LABEL[c.resident_role] },
    { header: 'מספר צ׳יפ', kind: 'ltr', width: 18, get: (c) => c.chip_number },
    { header: 'סוג', kind: 'text', width: 11, get: (c) => CHIP_TYPE_LABEL[c.chip_type] },
    { header: 'סטטוס', kind: 'text', width: 10, get: (c) => CHIP_STATUS_LABEL[c.status] },
    { header: 'הונפק', kind: 'ltr', width: 13, get: (c) => exportDate(c.issued_at) },
    { header: 'מנפיק', kind: 'text', width: 22, get: (c) => c.issued_by_name ?? '' },
    { header: 'מס׳ הזמנה', kind: 'ltr', width: 11, get: (c) => (c.order_ref ? String(c.order_ref.order_number) : '') },
    { header: ORDERER_NOTE_LABEL, kind: 'text', width: 30, get: (c) => c.order_ref?.orderer_note ?? '' },
    { header: GUARD_NOTE_LABEL, kind: 'text', width: 30, get: (c) => c.order_ref?.guard_note ?? '' },
    { header: DELIVERY_NOTE_LABEL, kind: 'text', width: 30, get: (c) => c.order_ref?.delivery_note ?? '' },
  ],
};
