import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, pool, withTx } from '../db.js';
import { AppError } from '../errors.js';
import { parse } from '../http.js';
import { audit } from '../audit.js';
import { newToken, sha256 } from '../security.js';
import { exchangeGoogleCode, googleLoginUrl, takeOAuthState } from '../services/google.js';
import { NO_PASSWORD, admitNewUser, createUser } from '../services/users.js';
import { startSession } from './auth.js';

export async function googleRoutes(app: FastifyInstance, opts: { fetch?: typeof fetch } = {}) {
  const f = opts.fetch ?? fetch;

  app.get('/api/auth/google/start', async (req, reply) => {
    const q = parse(z.object({ invite: z.string().max(100).optional() }), req.query);
    try { return reply.redirect(await googleLoginUrl(pool, { invite: q.invite })); }
    catch (e: any) { return reply.redirect(`/#/acceso?error=${encodeURIComponent(e?.code ?? 'error')}`); }
  });

  // Google redirige aquí (sin cabeceras personalizadas): la seguridad la dan el state de un solo uso y el nonce.
  app.get('/api/auth/google/callback', async (req, reply) => {
    const q = parse(z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }), req.query);
    const fail = (code: string) => reply.redirect(`/#/acceso?error=${encodeURIComponent(code)}`);
    if (q.error || !q.code || !q.state) return fail('cancelado');
    const st = await takeOAuthState<{ kind: string; invite: string | null; nonce: string }>(pool, q.state);
    if (!st || st.kind !== 'login') return fail('estado_vencido');
    try {
      const id = await exchangeGoogleCode(q.code, st.nonce, f);
      const user = await withTx(async (c) => {
        let u = await one(c, 'SELECT * FROM users WHERE google_sub=$1', [id.sub]);
        if (!u) {
          // Mismo correo verificado por Google: se vincula a la cuenta existente.
          u = await one(c, 'SELECT * FROM users WHERE email=$1', [id.email]);
          if (u) {
            if (u.google_sub && u.google_sub !== id.sub) throw new AppError(409, 'google_mismatch', 'La cuenta está vinculada a otro usuario de Google');
            u = await one(c, 'UPDATE users SET google_sub=$2 WHERE id=$1 RETURNING *', [u.id, id.sub]);
            await audit(c, u.id, 'user', u.id, 'google_linked');
          } else {
            const inviteId = await admitNewUser(c, { invite: st.invite });
            u = await createUser(c, { email: id.email, display_name: id.name, password_hash: NO_PASSWORD, google_sub: id.sub, invite_id: inviteId });
          }
        }
        return u;
      });
      if (user.totp_enabled) {
        const ticket = newToken();
        await pool.query(`INSERT INTO login_tickets(token_hash,user_id,expires_at) VALUES ($1,$2, now() + interval '5 minutes')`, [sha256(ticket), user.id]);
        return reply.redirect(`/#/acceso?ticket=${encodeURIComponent(ticket)}`);
      }
      await startSession(app, req, reply, user.id);
      await audit(pool, user.id, 'user', user.id, 'login', null, { via: 'google' });
      return reply.redirect('/#/');
    } catch (e: any) {
      return fail(e instanceof AppError ? e.code : 'error');
    }
  });
}
