import { Db } from './db.js';

// El registro de auditoría nunca debe contener secretos: solo campos financieros del propio usuario.
export async function audit(db: Db, userId: string | null, entity: string, entityId: string | null, action: string, before?: unknown, after?: unknown, detail?: string) {
  await db.query(
    'INSERT INTO audit_log(user_id, entity, entity_id, action, before, after, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [userId, entity, entityId, action, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), detail ?? null],
  );
}
