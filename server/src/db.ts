import pg from 'pg';
import { config } from './config.js';

// BIGINT -> number: los importes en centavos caben de sobra en 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
// DATE -> 'YYYY-MM-DD' sin conversión de zona horaria.
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
export type Db = pg.PoolClient | pg.Pool;

export async function withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function rows<T = any>(db: Db, text: string, params: any[] = []): Promise<T[]> {
  return (await db.query(text, params)).rows as T[];
}
export async function one<T = any>(db: Db, text: string, params: any[] = []): Promise<T | undefined> {
  return (await db.query(text, params)).rows[0] as T | undefined;
}
