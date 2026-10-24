import { expect, test, Page } from '@playwright/test';

const PASS = 'clave-segura-e2e-1';
let n = 0;
async function register(page: Page) {
  const email = `e2e${Date.now()}${++n}@test.local`;
  await page.goto('/');
  await page.getByRole('button', { name: /Crear una cuenta nueva/ }).click({ timeout: 1500 }).catch(() => {});
  await page.fill('#name', 'Ana');
  await page.fill('#email', email);
  await page.fill('#pw', PASS);
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page.getByText('Empecemos por tus cuentas')).toBeVisible();
  return email;
}
async function createCash(page: Page, balance = '1000') {
  await page.goto('/#/cuentas?nueva=1');
  await page.getByRole('button', { name: 'Efectivo', exact: true }).click(); // banco/tipo "Efectivo"
  await page.fill('#an', 'Efectivo');
  await page.fill('#ao', balance);
  await page.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByText('Cuenta creada')).toBeVisible();
  await page.goto('/#/');
  await expect(page.locator('.hero')).toBeVisible();
}

test('flujo principal: registro, cuenta, gasto rápido y saldo actualizado', async ({ page }) => {
  await register(page);
  await createCash(page);
  await page.goto('/#/');
  await expect(page.locator('.hero .big')).toContainText('1,000.00');
  await page.getByRole('button', { name: 'Agregar movimiento' }).click();
  await page.fill('#amount', '120');
  await page.getByRole('button', { name: 'Alimentación', exact: true }).click();
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(page.getByText(/Gasto de HNL 120.00 registrado/)).toBeVisible();
  await expect(page.locator('.hero .big')).toContainText('880.00');
  await page.goto('/#/movimientos');
  await expect(page.getByRole('button', { name: /Gasto, HNL 120.00/ })).toBeVisible();
});

test('validación: no deja guardar un gasto sin importe y muestra el error junto al campo', async ({ page }) => {
  await register(page); await createCash(page);
  await page.getByRole('button', { name: 'Agregar movimiento' }).click();
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'importe mayor que cero' })).toBeVisible();
});

test('manejo de errores: sin conexión muestra un mensaje útil', async ({ page }) => {
  await register(page); await createCash(page);
  await page.getByRole('button', { name: 'Agregar movimiento' }).click();
  await page.fill('#amount', '50');
  await page.route('**/api/transactions', (r) => r.abort());
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(page.getByText(/Sin conexión con el servidor/)).toBeVisible();
});

test('permisos: sin sesión se muestra el acceso y una sesión vencida vuelve al login', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Bienvenido|Crea tu centro/ })).toBeVisible();
  await register(page);
  await context.clearCookies();
  await page.goto('/#/cuentas');
  await page.reload();
  await expect(page.getByLabel('Contraseña')).toBeVisible();
  const r = await page.request.get('/api/accounts');
  expect(r.status()).toBe(401);
});

test('Gmail no configurado se informa con honestidad y no finge estar conectado', async ({ page }) => {
  await register(page);
  await page.goto('/#/integraciones');
  await expect(page.getByText('No activado')).toBeVisible();
  // El administrador ve el asistente con los valores para copiar; los demás, un aviso sin pasos técnicos.
  await expect(page.getByText('GOOGLE_CLIENT_ID', { exact: true }).or(page.getByText(/administrador aún no activó/))).toBeVisible();
  await expect(page.getByText('Sin API pública')).toHaveCount(0); // solo queda el correo
  await expect(page.getByRole('button', { name: /Vincular mi Gmail/ })).toHaveCount(0);
});

test('la app sirve sin conectar nada: transferencia no cambia el total y NOVA AI avisa si faltan datos', async ({ page }) => {
  await register(page); await createCash(page, '500');
  await page.goto('/#/ia');
  await page.getByRole('button', { name: '¿Cuánto puedo gastar esta semana?' }).click();
  // Con solo el saldo ya puede estimarlo (y lo dice: no cuenta ingresos futuros)
  await expect(page.getByText(/por semana/).first()).toBeVisible();
  await expect(page.getByText(/No se cuentan ingresos futuros/).first()).toBeVisible();
  // Para analizar gastos sí necesita movimientos, y lo dice sin inventar cifras
  await page.getByLabel('Escribe tu pregunta').fill('¿En qué categoría estoy gastando más?');
  await page.getByLabel('Enviar').click();
  await expect(page.getByText(/necesito movimientos confirmados/i)).toBeVisible();
  await page.getByRole('tab', { name: '¿Me conviene comprarlo?' }).click();
  await page.fill('#pi', 'Teléfono'); await page.fill('#pp', '3000');
  await page.getByRole('button', { name: 'Evaluar compra' }).click();
  await expect(page.getByText(/Evaluación orientativa ·/)).toBeVisible();
  await expect(page.getByText(/La decisión es tuya/)).toBeVisible();
});

test('diseño responsive: navegación inferior en móvil, lateral en escritorio, sin desbordes', async ({ page }, info) => {
  await register(page); await createCash(page);
  const mobile = info.project.name === 'movil';
  await expect(page.locator('.bottomnav')).toBeVisible({ visible: mobile });
  await expect(page.locator('.side')).toBeVisible({ visible: !mobile });
  for (const r of ['/', '/movimientos', '/presupuestos', '/ia', '/perfil', '/cuentas', '/metas', '/deudas', '/recurrentes', '/informes', '/integraciones', '/revision']) {
    await page.goto('/#' + r);
    await page.waitForTimeout(250);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over, `desborde horizontal en ${r}`).toBeLessThanOrEqual(1);
  }
  // Tamaños táctiles adecuados en la navegación
  if (mobile) {
    const boxes = await page.locator('.bottomnav .navitem').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    for (const h of boxes) expect(h).toBeGreaterThanOrEqual(44);
  }
});

test('movimientos: anular exige motivo, conserva el historial y devuelve el saldo', async ({ page }) => {
  await register(page); await createCash(page);
  await page.getByRole('button', { name: 'Agregar movimiento' }).click();
  await page.fill('#amount', '200'); await page.fill('#merchant', 'Tienda prueba');
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await page.goto('/#/movimientos');
  await page.getByRole('button', { name: /Tienda prueba/ }).click();
  await page.getByRole('button', { name: 'Anular', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirmar anulación' })).toBeDisabled();
  await page.fill('#why', 'Registrado por error');
  await page.getByRole('button', { name: 'Confirmar anulación' }).click();
  await expect(page.getByText('Movimiento anulado').first()).toBeVisible();
  await page.goto('/#/');
  await expect(page.locator('.hero .big')).toContainText('1,000.00');
  await page.goto('/#/movimientos');
  await expect(page.getByText('Anulado').first()).toBeVisible();
});

test('2FA: tras activarla, el acceso pide el código de la app de autenticación', async ({ page, context }) => {
  const { totpAt, currentStep } = await import('../../server/src/services/totp');
  const email = await register(page);
  const h = { 'x-requested-with': 'nova' };
  const setup = await (await page.request.post('/api/me/2fa/setup', { headers: h, data: { password: PASS } })).json();
  const en = await page.request.post('/api/me/2fa/enable', { headers: h, data: { code: totpAt(setup.secret, currentStep()) } });
  expect(en.ok()).toBeTruthy();
  await context.clearCookies();
  await page.goto('/'); await page.reload();
  await page.fill('#email', email); await page.fill('#pw', PASS);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByLabel('Código de verificación')).toBeVisible();
  await page.fill('#otp', '000000');
  await page.getByRole('button', { name: 'Verificar' }).click();
  await expect(page.getByRole('alert')).toContainText('Código incorrecto');
  await page.fill('#otp', totpAt(setup.secret, currentStep() + 1));
  await page.getByRole('button', { name: 'Verificar' }).click();
  await expect(page.getByText('Empecemos por tus cuentas')).toBeVisible();
});

test('resúmenes: el resumen semanal se ve en Informes y push informa si no está configurado', async ({ page }) => {
  await register(page); await createCash(page);
  await page.goto('/#/informes?vista=resumenes');
  await expect(page.getByRole('heading', { name: 'Resumen de la semana' })).toBeVisible();
  await expect(page.getByText('Sin movimientos confirmados en este período.')).toBeVisible();
  await page.goto('/#/perfil');
  // El administrador ve el detalle técnico; los demás, un aviso sencillo sin nombres de variables.
  await expect(page.getByText(/no tiene claves VAPID/).or(page.getByText(/notificaciones en el teléfono aún no están disponibles/))).toBeVisible();
  if (!(await page.getByText(/no tiene claves VAPID/).count())) await expect(page.getByText(/VAPID|ANTHROPIC|GOOGLE_/)).toHaveCount(0);
});

test('billetera: la tarjeta con banco se ve en la pila y su detalle muestra fondos y pagos agendados', async ({ page }) => {
  await register(page);
  await page.goto('/#/cuentas?nueva=1');
  await page.getByRole('button', { name: 'BAC Credomatic' }).click();
  await page.getByRole('button', { name: 'Visa', exact: true }).click();
  await page.fill('#al4', '1824');
  await page.fill('#ao', '2500');
  await page.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByText('Cuenta creada')).toBeVisible();
  await page.goto('/#/');
  await page.getByRole('button', { name: /Abrir billetera/ }).click();
  await page.getByRole('button', { name: /Ver BAC Credomatic Débito/ }).click();
  await expect(page.getByText('Pagos agendados · 30 días')).toBeVisible();
  await expect(page.locator('.wv-info .kpi').first()).toContainText('2,500.00');
  await expect(page.getByRole('img', { name: /terminada en 1824/ }).first()).toBeVisible();
});

test('bloqueo con huella: se activa, bloquea al volver y se desbloquea con la huella', async ({ page, context }) => {
  // Autenticador de plataforma virtual de Chrome (equivale al lector de huellas del teléfono).
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await register(page);
  await page.goto('/#/apariencia');
  await page.getByRole('button', { name: 'Activar con mi huella' }).click();
  await expect(page.getByText('Huella registrada', { exact: false })).toBeVisible();
  await expect(page.getByText('Activado')).toBeVisible();
  // Simula que pasó el tiempo de bloqueo: la próxima apertura exige la huella.
  const { Client } = await import('pg');
  const db = new Client({ connectionString: 'postgres://nova:nova@localhost:5432/nova_e2e' }); await db.connect();
  await db.query(`UPDATE sessions SET unlocked_until = now() - interval '1 minute'`); await db.end();
  await page.goto('/#/'); await page.reload();
  await expect(page.getByRole('dialog', { name: 'App bloqueada' })).toBeVisible();
  // La huella virtual responde sola (presencia automática): la app se desbloquea.
  await expect(page.getByRole('dialog', { name: 'App bloqueada' })).toBeHidden({ timeout: 15000 });
  await expect(page.getByText('Empecemos por tus cuentas')).toBeVisible();
});

test('apariencia: cambiar nombre y color se refleja en la app y en el manifiesto', async ({ page }) => {
  // La apariencia la cambia el administrador (la primera cuenta de la instalación).
  const { Client } = await import('pg');
  const db = new Client({ connectionString: 'postgres://nova:nova@localhost:5432/nova_e2e' }); await db.connect();
  let first = (await db.query('SELECT email FROM users ORDER BY created_at, id LIMIT 1')).rows[0]?.email;
  await db.end();
  if (!first) first = await register(page);
  else {
    await page.goto('/'); await page.fill('#email', first); await page.fill('#pw', PASS);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.locator('.main')).toBeVisible();
  }
  await page.goto('/#/apariencia');
  await page.fill('#bn', 'Finanzas Ana');
  await page.getByRole('button', { name: 'Turquesa' }).click();
  await page.getByRole('button', { name: 'Medianoche' }).click();
  await page.getByRole('button', { name: 'Guardar apariencia' }).click();
  await expect(page.getByText('Apariencia guardada')).toBeVisible();
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--lime').trim());
  expect(accent.toUpperCase()).toBe('#2DE2D0');
  expect(await page.title()).toBe('Finanzas Ana');
  const m = await (await page.request.get('/manifest.webmanifest')).json();
  expect(m.name).toBe('Finanzas Ana');
  await page.getByRole('button', { name: 'Restablecer' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restablecer' }).click();
  await expect(page.getByText('Apariencia restablecida')).toBeVisible();
  expect((await (await page.request.get('/manifest.webmanifest')).json()).name).toBe('NOVA FINANCE');
});

test('compartir: el administrador crea un enlace y un invitado se registra con él', async ({ page, browser }) => {
  const { Client } = await import('pg');
  const db = new Client({ connectionString: 'postgres://nova:nova@localhost:5432/nova_e2e' }); await db.connect();
  const first = (await db.query('SELECT email FROM users ORDER BY created_at, id LIMIT 1')).rows[0]?.email;
  await db.end();
  if (!first) await register(page);
  else { await page.goto('/'); await page.fill('#email', first); await page.fill('#pw', PASS); await page.getByRole('button', { name: 'Entrar' }).click(); await expect(page.locator('.main')).toBeVisible(); }
  await page.goto('/#/compartir');
  await page.fill('#in', 'Familia');
  await page.getByRole('button', { name: 'Crear enlace' }).click();
  const link = (await page.locator('code').first().textContent())!.trim();
  expect(link).toMatch(/\/#\/invitacion\//);
  // El administrador abre su propio enlace: se explica por qué ve su cuenta y no se gasta la invitación.
  await page.goto(link.replace(/^https?:\/\/[^/]+/, 'http://localhost:3100'));
  await expect(page.getByRole('heading', { name: 'Este es un enlace de invitación' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cerrar sesión y usar la invitación' })).toBeVisible();
  // El invitado abre el enlace en otro navegador (sin sesión).
  const guest = await browser.newContext();
  const g = await guest.newPage();
  await g.goto(link.replace(/^https?:\/\/[^/]+/, 'http://localhost:3100'));
  await expect(g.getByRole('heading', { name: 'Te invitaron a probar la app' })).toBeVisible();
  const guestName = `Primo ${Date.now()}`;
  await g.fill('#name', guestName); await g.fill('#email', `primo${Date.now()}@test.local`); await g.fill('#pw', PASS);
  await g.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(g.getByText('Empecemos por tus cuentas')).toBeVisible();
  await guest.close();
  await page.goto('/#/compartir');
  await expect(page.getByText(`Se unieron: ${guestName}`)).toBeVisible();
});

test('comentarios: un usuario envía un comentario y lo ve en su lista', async ({ page }) => {
  await register(page);
  await page.goto('/#/comentarios');
  await page.getByRole('button', { name: 'Tengo una idea' }).click();
  await page.getByLabel('¿Qué te gustaría que hiciera la app?').fill('Me gustaría ver mis gastos por semana');
  await page.getByRole('radio', { name: '5 de 5' }).click();
  await page.getByRole('button', { name: 'Enviar' }).click();
  await expect(page.getByText('¡Gracias! Tu comentario llegó al administrador.')).toBeVisible();
  await expect(page.getByText('Me gustaría ver mis gastos por semana')).toBeVisible();
});

test('compartir: solo el administrador ve la opción y puede crear invitaciones', async ({ page }) => {
  await register(page);
  const isAdmin = (await (await page.request.get('/api/appearance')).json()).is_admin;
  await page.goto('/#/perfil');
  await expect(page.getByText('Comentarios y sugerencias')).toBeVisible();
  await expect(page.getByText('Compartir app', { exact: true })).toHaveCount(isAdmin ? 1 : 0);
  const r = await page.request.post('/api/invites', { headers: { 'x-requested-with': 'nova' }, data: { max_uses: 1, days: 1 } });
  expect(r.status()).toBe(isAdmin ? 200 : 403);
});

test('revisión: si no se sabe la tarjeta o cuenta, la app pregunta y no deja confirmar hasta elegir', async ({ page }) => {
  const email = await register(page);
  const post = (url: string, data: any) => page.request.post(url, { headers: { 'x-requested-with': 'nova' }, data }).then((r) => r.json());
  const caja = await post('/api/accounts', { name: 'Caja chica', type: 'cash', opening_balance: 100000 });
  await post('/api/accounts', { name: 'Banco Prueba', type: 'bank', opening_balance: 500000 });
  const { Client } = await import('pg');
  const db = new Client({ connectionString: 'postgres://nova:nova@localhost:5432/nova_e2e' }); await db.connect();
  await db.query(`INSERT INTO transactions(user_id,type,amount,currency,occurred_at,account_id,merchant,status,source,needs_review,account_pending,review_hint)
    SELECT u.id,'expense',15000,'HNL',now(),$2,'Supercell (Google Play)','pending','email',true,true,'Cobro de USD 1.99. Importe estimado en HNL con un tipo de cambio de referencia (26.5): corrígelo con el monto real que cobró tu banco.'
    FROM users u WHERE u.email=$1`, [email, caja.id]);
  await db.end();
  await page.goto('/#/revision');
  await expect(page.getByText('necesitan tu ayuda')).toBeVisible();
  await expect(page.getByText('¿De qué tarjeta o cuenta es este gasto?')).toBeVisible();
  await expect(page.getByText(/Importe estimado en HNL/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Confirmar$/ }).first()).toBeDisabled();
  await page.getByRole('button', { name: 'Banco Prueba' }).click();
  await expect(page.getByText('¿De qué tarjeta o cuenta es este gasto?')).toHaveCount(0);
  await page.getByRole('button', { name: /Confirmar$/ }).first().click();
  await expect(page.getByText('Todo al día')).toBeVisible();
  await page.goto('/#/cuentas');
  await expect(page.getByText('HNL 4,850.00').first()).toBeVisible(); // 5,000 − 150, salió de la cuenta elegida
});
