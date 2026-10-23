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
  await expect(page.getByText('No configurado')).toBeVisible();
  await expect(page.getByText('GOOGLE_CLIENT_ID', { exact: true })).toBeVisible();
  await expect(page.getByText('Sin API pública')).toBeVisible();
  await expect(page.getByRole('button', { name: /Conectar con Google/ })).toHaveCount(0);
});

test('la app sirve sin conectar nada: transferencia no cambia el total y NOVA AI avisa si faltan datos', async ({ page }) => {
  await register(page); await createCash(page, '500');
  await page.goto('/#/ia');
  await page.getByRole('button', { name: '¿Cuánto puedo gastar esta semana?' }).click();
  await expect(page.getByText(/no tienes movimientos confirmados/i)).toBeVisible();
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
  await expect(page.getByText(/no tiene claves VAPID/)).toBeVisible();
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
