import { createHash } from 'node:crypto';

const env = process.env;
const isProd = env.NODE_ENV === 'production';

export const config = {
  isProd,
  isTest: env.NODE_ENV === 'test',
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? '0.0.0.0',
  databaseUrl: env.DATABASE_URL ?? 'postgres://nova:nova@localhost:5432/nova_dev',
  allowRegistration: env.ALLOW_REGISTRATION === 'true',
  allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  // En Render la URL pública llega en RENDER_EXTERNAL_URL.
  publicUrl: env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${env.PORT ?? 3000}`,
  // Si se define, crear el PRIMER usuario exige este código (evita que un tercero se adelante tras el despliegue).
  registrationCode: env.REGISTRATION_CODE ?? '',
  sessionDays: Number(env.SESSION_DAYS ?? 14),
  // Clave de 32 bytes derivada del secreto; solo se usa para cifrar tokens OAuth en reposo.
  encryptionKey: env.APP_ENCRYPTION_KEY ? createHash('sha256').update(env.APP_ENCRYPTION_KEY).digest() : null,
  google: {
    clientId: env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
  },
  push: {
    publicKey: env.VAPID_PUBLIC_KEY ?? '',
    privateKey: env.VAPID_PRIVATE_KEY ?? '',
    subject: env.VAPID_SUBJECT ?? 'mailto:admin@localhost',
  },
  scheduler: env.SCHEDULER !== 'off',
  ai: {
    apiKey: env.ANTHROPIC_API_KEY ?? '',
    model: env.NOVA_AI_MODEL ?? 'claude-sonnet-5-5',
  },
};

export function googleConfigured() {
  return Boolean(config.google.clientId && config.google.clientSecret && config.encryptionKey);
}
export function googleMissing(): string[] {
  const m: string[] = [];
  if (!config.google.clientId) m.push('GOOGLE_CLIENT_ID');
  if (!config.google.clientSecret) m.push('GOOGLE_CLIENT_SECRET');
  if (!config.encryptionKey) m.push('APP_ENCRYPTION_KEY');
  return m;
}

export const pushConfigured = () => Boolean(config.push.publicKey && config.push.privateKey);

/** Relying Party de WebAuthn: el dominio público de la app (la huella queda ligada a ese dominio). */
export function webauthnRp() {
  const u = new URL(config.publicUrl);
  return { rpID: u.hostname, origin: u.origin };
}
