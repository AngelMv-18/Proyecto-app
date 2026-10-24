import { config } from '../config.js';
import { Db, one } from '../db.js';
import { AppError } from '../errors.js';
import { LIQUID_TYPES, accountsWithBalances, budgetsStatus, categoryBreakdown, debtsWithRemaining, getUser, goalsWithProgress, incomeExpense, listTransactions, natureBreakdown, periodBounds, upcomingObligations } from './stats.js';
import { baseline, evaluatePurchase, liquidSummary, healthScore } from './insights.js';
import { fmtMoney } from './format.js';

const M = (x: number) => Math.round(x) / 100; // unidades menores -> mayores para el modelo

// ---------- Herramientas de solo lectura, siempre acotadas al usuario autenticado ----------
type Tool = { name: string; description: string; input_schema: object; run: (db: Db, userId: string, input: any) => Promise<any> };

async function periodFrom(db: Db, tz: string, p?: string) {
  if (p === 'last_month') return { ...(await periodBounds(db, tz, 'month', -1)), label: 'mes anterior' };
  if (p === 'week') return { ...(await periodBounds(db, tz, 'week')), label: 'semana actual' };
  if (p === 'last_week') return { ...(await periodBounds(db, tz, 'week', -1)), label: 'semana anterior' };
  if (p === 'year') return { ...(await periodBounds(db, tz, 'year')), label: 'año actual' };
  return { ...(await periodBounds(db, tz, 'month')), label: 'mes actual' };
}
const PERIOD = { type: 'string', enum: ['month', 'last_month', 'week', 'last_week', 'year'], description: 'Período calendario (por defecto: mes actual)' };

export const TOOLS: Tool[] = [
  {
    name: 'resumen_financiero', description: 'Saldos por cuenta, dinero disponible, reservado en metas, comprometido y libre, ingresos/gastos del mes.',
    input_schema: { type: 'object', properties: {} },
    run: async (db, uid) => {
      const u = await getUser(db, uid);
      const ls = await liquidSummary(db, uid, u.currency);
      const m = await periodBounds(db, u.timezone, 'month');
      const ie = await incomeExpense(db, uid, u.currency, { from: m.start, to: m.end });
      const obl = await upcomingObligations(db, uid, u.currency, u.timezone, 30);
      const b = await baseline(db, uid, u.currency, u.timezone);
      return {
        moneda: u.currency, periodo_mes: { desde: m.start, hasta: m.end },
        cuentas: ls.accs.filter((a) => !a.archived && !a.linked_account_id).map((a) => ({ nombre: a.name, tipo: a.type, moneda: a.currency, saldo: M(a.balance), reservado_en_metas_virtuales: M(a.reserved_virtual), tarjetas_de_debito_vinculadas: ls.accs.filter((x) => x.linked_account_id === a.id).map((x) => x.name) })),
        disponible_liquido: M(ls.liquid), reservado_metas_virtuales: M(ls.reserved), deuda_tarjetas: M(ls.cards_owed),
        compromisos_30_dias: M(obl.reduce((s, o) => s + o.amount, 0)), libre_tras_compromisos: M(ls.free - obl.reduce((s, o) => s + o.amount, 0)),
        mes_actual: { ingresos: M(ie.income), gastos: M(ie.expense), ahorro_neto: M(ie.net) },
        dias_de_historial: b.span_days, historial_suficiente: b.sufficient,
        cuentas_en_otra_moneda_excluidas: ls.foreign.length,
      };
    },
  },
  {
    name: 'gastos_por_categoria', description: 'Gasto neto (gastos menos devoluciones) por categoría en un período; excluye transferencias y pagos de deuda.',
    input_schema: { type: 'object', properties: { periodo: PERIOD }, },
    run: async (db, uid, i) => {
      const u = await getUser(db, uid); const p = await periodFrom(db, u.timezone, i?.periodo);
      const cats = await categoryBreakdown(db, uid, u.currency, { from: p.start, to: p.end });
      const nat = await natureBreakdown(db, uid, u.currency, { from: p.start, to: p.end });
      const total = cats.reduce((s, c) => s + c.total, 0);
      return { periodo: p.label, desde: p.start, hasta: p.end, moneda: u.currency, total: M(total), categorias: cats.map((c) => ({ categoria: c.name, naturaleza: c.nature, total: M(c.total), porcentaje: total ? Math.round((c.total / total) * 1000) / 10 : 0 })), por_naturaleza: nat.map((n) => ({ naturaleza: n.nature, total: M(n.total) })) };
    },
  },
  {
    name: 'comparar_meses', description: 'Compara gastos por categoría e ingresos entre el mes actual y el anterior.',
    input_schema: { type: 'object', properties: {} },
    run: async (db, uid) => {
      const u = await getUser(db, uid);
      const a = await periodBounds(db, u.timezone, 'month'), b = await periodBounds(db, u.timezone, 'month', -1);
      const elapsed = (Date.now() - new Date(a.start).getTime()) / 86400000;
      const [ca, cb, ia, ib] = await Promise.all([categoryBreakdown(db, uid, u.currency, { from: a.start, to: a.end }), categoryBreakdown(db, uid, u.currency, { from: b.start, to: b.end }), incomeExpense(db, uid, u.currency, { from: a.start, to: a.end }), incomeExpense(db, uid, u.currency, { from: b.start, to: b.end })]);
      const names = [...new Set([...ca, ...cb].map((c) => c.name))];
      return {
        nota: `El mes actual lleva ${Math.round(elapsed)} día(s); la comparación es mes parcial vs mes completo.`, moneda: u.currency,
        mes_actual: { desde: a.start, ingresos: M(ia.income), gastos: M(ia.expense) }, mes_anterior: { desde: b.start, ingresos: M(ib.income), gastos: M(ib.expense) },
        categorias: names.map((n) => { const x = ca.find((c) => c.name === n)?.total ?? 0, y = cb.find((c) => c.name === n)?.total ?? 0; return { categoria: n, actual: M(x), anterior: M(y), diferencia: M(x - y) }; }).sort((p, q) => Math.abs(q.diferencia) - Math.abs(p.diferencia)),
      };
    },
  },
  {
    name: 'estado_presupuestos', description: 'Presupuestos con porcentaje consumido, restante y proyección lineal.',
    input_schema: { type: 'object', properties: {} },
    run: async (db, uid) => {
      const u = await getUser(db, uid);
      return { moneda: u.currency, presupuestos: (await budgetsStatus(db, uid, u.currency, u.timezone)).map((b) => ({ categoria: b.category_name, periodo: b.period, limite: M(b.amount), gastado: M(b.spent), restante: M(b.remaining), porcentaje: b.pct, proyeccion_fin_de_periodo: M(b.projected) })) };
    },
  },
  {
    name: 'metas_de_ahorro', description: 'Metas con progreso, fecha estimada y ahorro semanal/mensual necesario.',
    input_schema: { type: 'object', properties: {} },
    run: async (db, uid) => {
      const u = await getUser(db, uid);
      return { moneda: u.currency, metas: (await goalsWithProgress(db, uid)).filter((g) => g.status === 'active').map((g) => ({ nombre: g.name, objetivo: M(g.target_amount), ahorrado: M(g.saved), faltante: M(g.missing), porcentaje: g.pct, fecha_objetivo: g.target_date, fecha_estimada: g.eta_date, semanal_necesario: g.weekly_needed != null ? M(g.weekly_needed) : null, mensual_necesario: g.monthly_needed != null ? M(g.monthly_needed) : null, retrasada: g.behind, tipo: g.virtual ? 'reserva virtual' : `cuenta real: ${g.account_name}`, prioridad: g.priority })) };
    },
  },
  {
    name: 'compromisos_y_deudas', description: 'Pagos recurrentes próximos y deudas pendientes (por pagar y por cobrar).',
    input_schema: { type: 'object', properties: { dias: { type: 'integer', minimum: 1, maximum: 120 } } },
    run: async (db, uid, i) => {
      const u = await getUser(db, uid);
      const obl = await upcomingObligations(db, uid, u.currency, u.timezone, i?.dias ?? 30);
      const debts = (await debtsWithRemaining(db, uid)).filter((d) => d.status === 'open');
      return { moneda: u.currency, dias: i?.dias ?? 30, compromisos: obl.map((o) => ({ nombre: o.name, fecha: o.date, importe: M(o.amount), vencido: o.overdue })), total: M(obl.reduce((s, o) => s + o.amount, 0)), deudas: debts.map((d) => ({ tipo: d.direction === 'owe' ? 'yo debo' : 'me deben', contraparte: d.counterparty, pendiente: M(d.remaining), vence: d.due_date })) };
    },
  },
  {
    name: 'buscar_movimientos', description: 'Busca movimientos confirmados por texto (comercio/descripción) y período; devuelve total y hasta 10 ejemplos.',
    input_schema: { type: 'object', properties: { texto: { type: 'string' }, periodo: PERIOD }, },
    run: async (db, uid, i) => {
      const u = await getUser(db, uid); const p = await periodFrom(db, u.timezone, i?.periodo);
      const r = await listTransactions(db, uid, { q: i?.texto, from: p.start, to: p.end, status: 'confirmed' }, 10);
      return { periodo: p.label, coincidencias: r.total, ejemplos: r.items.map((t) => ({ fecha: t.occurred_at, tipo: t.type, importe: M(t.amount), comercio: t.merchant, categoria: t.category_name })) };
    },
  },
  {
    name: 'capacidad_de_gasto_semanal', description: 'Estima cuánto se puede gastar esta semana sin comprometer obligaciones registradas.',
    input_schema: { type: 'object', properties: {} },
    run: async (db, uid) => {
      const u = await getUser(db, uid);
      const ls = await liquidSummary(db, uid, u.currency);
      const today = (await one<{ d: string; dim: number }>(db, `SELECT (now() AT TIME ZONE $1)::date::text d, (date_trunc('month', now() AT TIME ZONE $1) + interval '1 month' - interval '1 day')::date - (now() AT TIME ZONE $1)::date + 1 AS dim`, [u.timezone]))!;
      const horizon = Math.max(Number(today.dim), 7);
      const obl = await upcomingObligations(db, uid, u.currency, u.timezone, horizon);
      const oblTotal = obl.reduce((s, o) => s + o.amount, 0);
      const free = ls.free - oblTotal;
      return {
        moneda: u.currency, horizonte_dias: horizon, supuestos: ['No se cuentan ingresos futuros.', 'Se descuentan compromisos registrados y dinero reservado en metas virtuales.'],
        disponible: M(ls.liquid), reservado: M(ls.reserved), compromisos_en_horizonte: M(oblTotal), libre: M(free),
        presupuesto_semanal_sugerido: M(Math.max(free, 0) / (horizon / 7)),
      };
    },
  },
  {
    name: 'evaluar_compra', description: 'Evalúa una compra: compatibilidad con presupuesto, caja, compromisos y metas. No aprueba compras.',
    input_schema: { type: 'object', required: ['precio'], properties: { articulo: { type: 'string' }, precio: { type: 'number', description: 'En la moneda principal' }, pago: { type: 'string', enum: ['cash', 'debit', 'credit', 'installments'] }, cuotas: { type: 'integer' }, tipo: { type: 'string', enum: ['need', 'want'] } } },
    run: async (db, uid, i) => {
      const r = await evaluatePurchase(db, uid, { item: i.articulo ?? 'compra', price: Math.round(i.precio * 100), payment: i.pago ?? 'cash', installments: i.cuotas, kind: i.tipo ?? 'want' });
      return { veredicto: r.headline, razones: r.reasons, advertencias: r.warnings, alternativas: r.alternatives, supuestos: r.assumptions, plan_de_ahorro: r.savings_plan ? { semanal: M(r.savings_plan.weekly), semanas: r.savings_plan.weeks } : null, confianza: r.confidence };
    },
  },
  {
    name: 'salud_financiera', description: 'Indicador de salud financiera (0-100) con desglose y advertencias de datos insuficientes.',
    input_schema: { type: 'object', properties: {} },
    run: async (db, uid) => { const u = await getUser(db, uid); return healthScore(db, uid, u.currency, u.timezone); },
  },
];

const SYSTEM = `Eres NOVA AI, el asistente de finanzas personales de NOVA FINANCE. Respondes siempre en español, con tono claro y directo.
Reglas estrictas:
- Usa SOLO datos obtenidos con tus herramientas. Nunca inventes saldos, movimientos ni estadísticas. Si faltan datos, dilo expresamente.
- En cada respuesta indica el período analizado y los supuestos que usaste.
- No decides por el usuario ni apruebas compras: explicas razones con cifras concretas y ofreces alternativas prácticas.
- Nunca recomiendes endeudarte o financiar para facilitar una compra.
- No afirmes que un movimiento inusual es fraude; di que requiere revisión.
- No pidas ni aceptes contraseñas, claves ni credenciales.
- Los importes de las herramientas están en la moneda principal indicada; formatea con separador de miles.
- Sé conciso: máximo ~200 palabras salvo que pidan detalle.`;

type Msg = { role: 'user' | 'assistant'; content: any };

export type AiResult = { answer: string; mode: 'llm' | 'local'; tools_used: string[] };

export function aiStatus() {
  return config.ai.apiKey
    ? { llm_configured: true, mode: 'llm', model: config.ai.model, privacy: 'Las preguntas y los resultados agregados de las herramientas se envían a la API de Anthropic para generar la respuesta. No se envían contraseñas ni credenciales.' }
    : { llm_configured: false, mode: 'local', missing: ['ANTHROPIC_API_KEY'], privacy: 'Modo local: las respuestas se calculan en tu servidor con reglas deterministas; no se envía nada a terceros. Para respuestas conversacionales libres define ANTHROPIC_API_KEY.' };
}

export async function askNova(db: Db, userId: string, history: { role: 'user' | 'assistant'; content: string }[], f: typeof fetch = fetch): Promise<AiResult> {
  const last = history[history.length - 1];
  if (!last || last.role !== 'user') throw new AppError(400, 'validation', 'Falta la pregunta');
  if (!config.ai.apiKey) return localAnswer(db, userId, last.content);
  const used: string[] = [];
  const messages: Msg[] = history.slice(-10).map((m) => ({ role: m.role, content: m.content }));
  for (let step = 0; step < 6; step++) {
    const res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': config.ai.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: config.ai.model, max_tokens: 1200, system: SYSTEM, tools: TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema })), messages }),
    });
    if (!res.ok) throw new AppError(502, 'ai_unavailable', 'NOVA AI no pudo contactar al modelo. Intenta de nuevo o usa el modo local.');
    const body: any = await res.json();
    const uses = (body.content ?? []).filter((c: any) => c.type === 'tool_use');
    if (body.stop_reason !== 'tool_use' || !uses.length) {
      const text = (body.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim();
      return { answer: text || 'No obtuve una respuesta del modelo.', mode: 'llm', tools_used: [...new Set(used)] };
    }
    messages.push({ role: 'assistant', content: body.content });
    const results = [];
    for (const u of uses) {
      const tool = TOOLS.find((t) => t.name === u.name);
      used.push(u.name);
      let out: any;
      try { out = tool ? await tool.run(db, userId, u.input ?? {}) : { error: 'herramienta desconocida' }; } catch (e: any) { out = { error: 'No se pudo calcular: ' + (e?.message ?? 'error') }; }
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { answer: 'No pude completar el análisis en el número de pasos permitido.', mode: 'llm', tools_used: [...new Set(used)] };
}

// ---------- Modo local: respuestas deterministas con los mismos cálculos ----------
const HELP = 'Prueba con preguntas como:\n• ¿Cuánto dinero tengo? / ¿Cuánto puedo gastar esta semana?\n• ¿En qué gasto más? / ¿Cuánto gasté en comida?\n• ¿Puedo permitirme una compra de 3,000?\n• ¿Cómo voy con mis metas? / ¿Cuánto debo?\n• ¿Qué pagos tengo pronto? / ¿Cómo van mis presupuestos?\n• ¿Qué gastos puedo reducir? / ¿Qué cambió respecto al mes anterior?';
const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export async function localAnswer(db: Db, userId: string, q: string): Promise<AiResult> {
  const t = strip(q);
  const u = await getUser(db, userId);
  const c = u.currency, L = u.locale;
  const f = (x: number) => fmtMoney(x, c, L);
  const used: string[] = [];
  const run = async (n: string, input: any = {}) => { used.push(n); return TOOLS.find((x) => x.name === n)!.run(db, userId, input); };
  const R = (answer: string): AiResult => ({ answer, mode: 'local', tools_used: used });
  const base = await baseline(db, userId, c, u.timezone);
  const noData = (await one<{ n: number }>(db, `SELECT count(*)::int n FROM transactions WHERE user_id=$1 AND status='confirmed'`, [userId]))!.n === 0;
  // Preguntas de análisis de gastos necesitan movimientos; las de saldos, metas, deudas y pagos se responden con lo que haya.
  const needMovements = (what: string) => R(`Para decirte ${what} necesito movimientos confirmados, y todavía no tienes ninguno. Registra tus gastos e ingresos (o confirma los que llegan a Revisión desde Gmail) y vuelve a preguntarme.\n\nMientras tanto puedo decirte cuánto dinero tienes, cómo van tus metas, tus deudas y tus próximos pagos.`);
  const snapshot = async () => {
    const s: any = await run('resumen_financiero');
    if (!s.cuentas.length) return 'Aún no tienes cuentas registradas. Crea tu efectivo, tus cuentas y tarjetas en Cuentas.';
    return `Tienes **${f(s.disponible_liquido * 100)} disponibles** entre efectivo, bancos y billeteras${s.reservado_metas_virtuales ? ` (de eso, ${f(s.reservado_metas_virtuales * 100)} reservados en metas)` : ''}.\n${s.cuentas.map((a: any) => `• ${a.nombre}: ${f(a.saldo * 100)}${a.tarjetas_de_debito_vinculadas?.length ? ` (con ${a.tarjetas_de_debito_vinculadas.join(', ')})` : ''}`).join('\n')}${s.deuda_tarjetas ? `\n• Deuda en tarjetas de crédito: ${f(s.deuda_tarjetas * 100)}` : ''}${s.compromisos_30_dias ? `\nPagos de los próximos 30 días: ${f(s.compromisos_30_dias * 100)} → te quedarían ${f(s.libre_tras_compromisos * 100)} libres.` : ''}`;
  };
  if (/(ayuda|que puedes|que sabes|como funcionas)/.test(t)) return R(`${HELP}\n\n${await snapshot()}`);

  // Saldos y cuentas: no requieren historial.
  if (/(saldo|cuanto (?:dinero )?tengo|cuanto hay|mis cuentas|dinero disponible|disponible|cuanto me queda|patrimonio|en total)/.test(t) && !/(semana|despues de pagar|compromisos)/.test(t)) return R(await snapshot());
  if (/(deuda|\bdebo\b|me deben|prestamo|prestamos)/.test(t) && !/(reducir|recortar|ahorrar|gastar|comprar)/.test(t)) {
    const r: any = await run('compromisos_y_deudas');
    if (!r.deudas.length) return R('No tienes deudas ni préstamos registrados. Puedes agregarlos en Deudas para que te recuerde los pagos y cuánto te falta.');
    return R(`Tus deudas y préstamos pendientes:\n${r.deudas.map((d: any) => `• ${d.tipo === 'yo debo' ? 'Debes a' : 'Te debe'} ${d.contraparte}: ${f(d.pendiente * 100)}${d.vence ? ` (vence ${d.vence})` : ''}`).join('\n')}`);
  }
  if (/(presupuesto|presupuestos|me pase|limite)/.test(t)) {
    const r: any = await run('estado_presupuestos');
    if (!r.presupuestos.length) return R('No tienes presupuestos. Créalos en Presupuestos (por ejemplo, Alimentación 6,000 al mes) y te avisaré antes de que te pases.');
    return R(`Así van tus presupuestos:\n${r.presupuestos.map((b: any) => `• ${b.categoria}: ${f(b.gastado * 100)} de ${f(b.limite * 100)} (${b.porcentaje}%)${b.restante < 0 ? ' ⚠️ excedido' : ` · quedan ${f(b.restante * 100)}`}`).join('\n')}`);
  }
  if (/(pagos? (?:proximos|pendientes|que vienen)|pagos? .{0,15}pronto|proximos pagos|que tengo que pagar|recurrentes|suscripciones|facturas|vence|vencen)/.test(t)) {
    const r: any = await run('compromisos_y_deudas', { dias: 30 });
    if (!r.compromisos.length) return R('No tienes pagos programados en los próximos 30 días. Agrega tus suscripciones, alquiler o servicios en Recurrentes.');
    return R(`Pagos de los próximos 30 días (${f(r.total * 100)} en total):\n${r.compromisos.slice(0, 8).map((o: any) => `• ${o.fecha}: ${o.nombre} — ${f(o.importe * 100)}${o.vencido ? ' ⚠️ vencido' : ''}`).join('\n')}`);
  }

  // ¿Puedo permitirme una compra de N?
  const money = q.match(/(\d[\d.,]*)\s*(?:hnl|lempiras|lps?|l\b)?/i);
  if (/(permitir|comprar|compra de|conviene)/.test(t) && money) {
    const raw = money[1].replace(/\.(?=\d{3}\b)/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.');
    const price = Number(raw);
    if (price > 0) {
      const r: any = await run('evaluar_compra', { precio: price, tipo: 'want' });
      return R(`**${r.veredicto}** (compra de ${f(price * 100)}).\n\n${r.razones.map((x: string) => `• ${x}`).join('\n')}\n\n${r.advertencias.length ? `⚠️ ${r.advertencias.join(' ')}\n\n` : ''}Alternativas:\n${r.alternativas.map((x: string) => `• ${x}`).join('\n')}\n\nSupuestos: ${r.supuestos.join(' ')}\nEs una evaluación orientativa; la decisión es tuya.`);
    }
  }
  if (/(esta semana|semana)/.test(t) && /(gastar|puedo)/.test(t)) {
    const r: any = await run('capacidad_de_gasto_semanal');
    return R(`Con lo que has registrado, podrías gastar unos **${f(r.presupuesto_semanal_sugerido * 100)} por semana** durante los próximos ${r.horizonte_dias} días.\n\n• Disponible: ${f(r.disponible * 100)} · Reservado en metas: ${f(r.reservado * 100)} · Compromisos: ${f(r.compromisos_en_horizonte * 100)}\n• Libre tras compromisos: ${f(r.libre * 100)}\n\nSupuestos: ${r.supuestos.join(' ')}`);
  }
  if (/(despues de pagar|me quedara|compromisos)/.test(t)) {
    const r: any = await run('compromisos_y_deudas'); const s: any = await run('resumen_financiero');
    return R(`Disponible hoy: ${f(s.disponible_liquido * 100)}. Compromisos de los próximos ${r.dias} días: ${f(r.total * 100)}${r.compromisos.length ? ` (${r.compromisos.slice(0, 5).map((o: any) => `${o.nombre} ${o.fecha}`).join(', ')})` : ''}.\n**Te quedarían ≈ ${f((s.disponible_liquido - r.total) * 100)}**, o ${f(s.libre_tras_compromisos * 100)} si descuentas lo reservado en metas. No incluye ingresos futuros.`);
  }
  if (/(meta|objetivo de ahorro|ahorro)/.test(t) && /(voy|como|progreso|cuanto)/.test(t) && !/reduz/.test(t)) {
    const r: any = await run('metas_de_ahorro');
    if (!r.metas.length) return R('No tienes metas activas. Crea una en la sección Metas y te diré cuánto necesitas ahorrar por semana.');
    return R(r.metas.map((g: any) => `**${g.nombre}**: ${f(g.ahorrado * 100)} de ${f(g.objetivo * 100)} (${g.porcentaje}%).${g.fecha_objetivo ? ` Meta: ${g.fecha_objetivo}.` : ''}${g.mensual_necesario ? ` Necesitas ≈ ${f(g.mensual_necesario * 100)}/mes (${f(g.semanal_necesario * 100)}/semana).` : ''}${g.fecha_estimada && g.fecha_estimada !== 'cumplida' ? ` Al ritmo actual: ${g.fecha_estimada}.` : ''}${g.retrasada ? ' ⚠️ Va retrasada.' : ''}`).join('\n'));
  }
  if (/(cambio|respecto al mes|mes anterior|comparad)/.test(t)) {
    if (noData) return needMovements('qué cambió respecto al mes anterior');
    const r: any = await run('comparar_meses');
    const top = r.categorias.slice(0, 4).map((x: any) => `• ${x.categoria}: ${f(x.actual * 100)} vs ${f(x.anterior * 100)} (${x.diferencia >= 0 ? '+' : ''}${f(x.diferencia * 100)})`).join('\n');
    return R(`Gastos del mes actual: ${f(r.mes_actual.gastos * 100)} vs ${f(r.mes_anterior.gastos * 100)} el mes anterior. Ingresos: ${f(r.mes_actual.ingresos * 100)} vs ${f(r.mes_anterior.ingresos * 100)}.\nMayores cambios:\n${top}\n\n${r.nota}`);
  }
  if (/(reducir|recortar|ahorrar si|cuanto podria ahorrar|sin afectar)/.test(t)) {
    if (noData) return needMovements('qué gastos podrías reducir');
    const r: any = await run('gastos_por_categoria', { periodo: 'month' });
    const disc = r.categorias.filter((x: any) => x.naturaleza !== 'essential');
    if (!disc.length) return R('No veo gastos discrecionales registrados este mes, así que no hay recortes evidentes que proponer.');
    const tot = disc.reduce((s: number, x: any) => s + x.total, 0);
    return R(`Gastos no esenciales de ${r.periodo}: ${f(tot * 100)}.\n${disc.slice(0, 4).map((x: any) => `• ${x.categoria}: ${f(x.total * 100)} → recortar 20% ahorraría ${f(x.total * 20)}`).join('\n')}\n\nSi reduces 20% todos los no esenciales ahorrarías ≈ **${f(tot * 20)}** al mes. Supuesto: el mes actual es representativo (llevas ${base.span_days} días de historial).`);
  }
  if (noData && /(gast|categoria|salud|como voy|resumen|estado)/.test(t)) return needMovements(/salud|como voy|resumen|estado/.test(t) ? 'cómo va tu salud financiera' : 'en qué gastas');
  const cats: any = (await run('gastos_por_categoria', { periodo: /anterior/.test(t) ? 'last_month' : 'month' }));
  const named = cats.categorias.find((x: any) => t.includes(strip(x.categoria)) || strip(x.categoria).split(' ').some((w: string) => w.length > 4 && t.includes(w.slice(0, 5))));
  if (/(cuanto gaste|gaste en)/.test(t) && named) return R(`En ${cats.periodo} gastaste **${f(named.total * 100)}** en ${named.categoria} (${named.porcentaje}% de tus gastos de ${f(cats.total * 100)}).`);
  if (/(categoria|gastando mas|mas gasto)/.test(t)) {
    if (!cats.categorias.length) return R(`No hay gastos confirmados en ${cats.periodo}.`);
    return R(`En ${cats.periodo} gastas más en **${cats.categorias[0].categoria}**: ${f(cats.categorias[0].total * 100)} (${cats.categorias[0].porcentaje}%).\n${cats.categorias.slice(1, 4).map((x: any) => `• ${x.categoria}: ${f(x.total * 100)} (${x.porcentaje}%)`).join('\n')}\nTotal: ${f(cats.total * 100)}.`);
  }
  if (/(salud|como voy|resumen|estado)/.test(t)) {
    const h: any = await run('salud_financiera');
    return R(`Salud financiera: **${h.score ?? 'sin datos'}/100 (${h.label})**. ${h.note}\n${h.parts.filter((p: any) => p.score != null).map((p: any) => `• ${p.label}: ${p.score}/100 — ${p.detail}`).join('\n')}`);
  }
  return R(`No entendí bien tu pregunta (en modo local solo reconozco preguntas concretas sobre tus datos). Esto es lo que puedo decirte ahora:\n\n${await snapshot()}\n\n${HELP}`);
}
