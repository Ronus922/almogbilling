import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listPickableSuppliers } from '@/lib/db/purchasing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/purchasing/suppliers — the active suppliers, read-only, for choosing
// the addressees of a request / the supplier of an order. Gated on purchasing,
// not on the suppliers module: the purchasing user needs the picker, not the
// suppliers screen.
export async function GET() {
  try { await requirePermission('purchasing', 'view'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  return NextResponse.json({ suppliers: await listPickableSuppliers() });
}
