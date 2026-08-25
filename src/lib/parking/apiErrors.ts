import 'server-only';
import { NextResponse } from 'next/server';
import { ApartmentNotFoundError, ParkingConflictError } from '@/lib/db/parking';
import { parkingErrorMessage, type ParkingErrorCode } from '@/lib/validation/parking';

// One place where a thrown domain/DB error becomes an HTTP response, so all
// eight parking/storage routes answer the same way. Every body carries BOTH a
// Hebrew `error` (what a human reads if the client has no special handling) and
// a stable `code` (what the client branches on).

/** 400 from a validation code. */
export function parkingBadRequest(code: ParkingErrorCode): NextResponse {
  return NextResponse.json({ error: parkingErrorMessage(code), code }, { status: 400 });
}

/** A route id is handed straight to a `where id = $1` on a uuid column, so a
 *  malformed one makes Postgres raise a syntax error — a 500 for what is really
 *  "no such row". Checked here, once, for every /[id] route. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function parkingNotFound(): NextResponse {
  return NextResponse.json(
    { error: parkingErrorMessage('not_found'), code: 'not_found' },
    { status: 404 },
  );
}

/**
 * Map a thrown error to a response, or null if it is not ours to handle (the
 * caller then logs and 500s — an unknown failure must not be dressed up as a
 * clean 4xx).
 *
 * The Postgres codes are a genuine backstop, not belt-and-braces: the pre-checks
 * in lib/db/parking.ts read-then-write, so two concurrent requests can both pass
 * the check and one will lose at the index. That loser gets a 409 with a generic
 * Hebrew message rather than a 500 — it just cannot name the holder, because by
 * then someone else's row is in the way.
 */
export function parkingErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof ParkingConflictError) {
    return NextResponse.json(
      {
        error: err.message,
        code: err.kind === 'parking' ? 'spot_number_taken' : 'unit_number_taken',
        conflict: {
          id: err.holderId,
          number: err.number,
          apartment_number: err.holderApartment,
          owner_type: err.holderOwnerType,
        },
      },
      { status: 409 },
    );
  }

  if (err instanceof ApartmentNotFoundError) {
    return NextResponse.json(
      {
        error: err.message,
        code: 'apartment_not_found',
        apartment_number: err.apartmentNumber,
      },
      { status: 400 },
    );
  }

  const e = err as { code?: string; constraint?: string };

  // 23505 unique_violation — lost the race to a concurrent write.
  if (e.code === '23505') {
    const isStorage = e.constraint === 'storage_units_number_active_uniq';
    return NextResponse.json(
      {
        error: isStorage ? parkingErrorMessage('unit_number_taken')
                         : parkingErrorMessage('spot_number_taken'),
        code: isStorage ? 'unit_number_taken' : 'spot_number_taken',
      },
      { status: 409 },
    );
  }

  // 23514 check_violation — a rule the validation layer should have caught
  // first. Answer in Hebrew rather than 500, but log it: reaching here means
  // validation and the schema have drifted apart.
  if (e.code === '23514') {
    console.error('[parking] CHECK violation reached the DB — validation gap', e.constraint);
    return NextResponse.json(
      { error: 'הנתונים אינם תקינים', code: 'invalid_data' },
      { status: 400 },
    );
  }

  return null;
}
