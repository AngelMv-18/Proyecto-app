import { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, ZodTypeAny, z } from 'zod';
import { badRequest } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest { userId: string | null }
}

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw zodToApp(r.error);
  return r.data;
}
export function zodToApp(e: ZodError) {
  const fields: Record<string, string> = {};
  for (const i of e.issues) fields[i.path.join('.') || '_'] ??= i.message;
  const first = e.issues[0];
  return badRequest(`Datos no válidos: ${first.path.join('.') || 'cuerpo'} — ${first.message}`, 'validation', fields);
}
export const uid = (req: FastifyRequest) => req.userId as string;
export const idParam = z.object({ id: z.string().uuid() });
export type Reply = FastifyReply;
