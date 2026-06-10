import { NextResponse } from 'next/server';
import { AuthorizationError } from './errors';

/** Convenience: turn an AuthorizationError thrown inside handler into a Response. */
export function authErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof AuthorizationError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return null;
}
