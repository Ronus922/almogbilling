import { NextResponse } from 'next/server';
import { query } from '@/lib/db';

// Uptime probe: 200 only when the database answers. A hung connection (DB
// paused, network black hole) must surface as 503 quickly — uptime monitors
// and load balancers treat a hanging probe as a timeout, not as "down".
const DB_TIMEOUT_MS = 5_000;

export async function GET() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('health: db timeout')), DB_TIMEOUT_MS);
    });
    await Promise.race([query('SELECT 1'), timeout]);
    return NextResponse.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json(
      { status: 'error', message: 'DB unreachable' },
      { status: 503 }
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
