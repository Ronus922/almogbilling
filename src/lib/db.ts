import 'server-only';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

const g = globalThis as unknown as { _pgPool?: Pool };

function getPool(): Pool {
  if (!g._pgPool) {
    g._pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
    g._pgPool.on('error', (err) => {
      console.error('[pg pool error]', err);
    });
  }
  return g._pgPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params);
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T | null> {
  const r = await query<T>(text, params);
  return r.rows[0] ?? null;
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* swallow — connection may be broken */ }
    throw err;
  } finally {
    client.release();
  }
}
