import type { SupplierFields } from '@/lib/db/purchasing';

/** The supplier columns of a document from a validated form body: a supplier
 *  picked from the list carries only its id (its details are read live from
 *  `suppliers`); a hand-typed one carries the name + optional details, which
 *  stay on the document and are never added to `suppliers`. */
export function supplierFieldsOf(b: {
  supplier_id: string | null;
  supplier_name: string | null;
  supplier_phone: string | null;
  supplier_email: string | null;
  supplier_address: string | null;
}): SupplierFields {
  if (b.supplier_id) {
    return { supplier_id: b.supplier_id, supplier_name: null, supplier_phone: null, supplier_email: null, supplier_address: null };
  }
  return {
    supplier_id: null,
    supplier_name: b.supplier_name,
    supplier_phone: b.supplier_phone,
    supplier_email: b.supplier_email,
    supplier_address: b.supplier_address,
  };
}
