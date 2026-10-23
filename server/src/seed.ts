import { Db } from './db.js';

type Seed = { name: string; nature: 'essential' | 'discretionary' | 'extraordinary'; icon: string; subs: string[] };
const EXPENSE: Seed[] = [
  { name: 'Alimentación', nature: 'essential', icon: 'utensils', subs: ['Supermercado', 'Restaurantes', 'Comida rápida'] },
  { name: 'Transporte', nature: 'essential', icon: 'bus', subs: ['Combustible', 'Taxi / bus', 'Mantenimiento'] },
  { name: 'Hogar', nature: 'essential', icon: 'home', subs: ['Alquiler', 'Mantenimiento'] },
  { name: 'Servicios', nature: 'essential', icon: 'bolt', subs: ['Electricidad', 'Agua', 'Internet', 'Teléfono'] },
  { name: 'Educación', nature: 'essential', icon: 'book', subs: ['Matrícula', 'Materiales'] },
  { name: 'Tecnología', nature: 'discretionary', icon: 'chip', subs: ['Dispositivos', 'Software'] },
  { name: 'Entretenimiento', nature: 'discretionary', icon: 'ticket', subs: ['Salidas', 'Juegos'] },
  { name: 'Salud', nature: 'essential', icon: 'heart', subs: ['Consultas', 'Medicinas'] },
  { name: 'Compras personales', nature: 'discretionary', icon: 'bag', subs: ['Ropa', 'Cuidado personal'] },
  { name: 'Suscripciones', nature: 'discretionary', icon: 'repeat', subs: [] },
  { name: 'Deudas', nature: 'essential', icon: 'scale', subs: ['Intereses', 'Comisiones'] },
  { name: 'Ahorro', nature: 'discretionary', icon: 'vault', subs: [] },
  { name: 'Otros', nature: 'discretionary', icon: 'dots', subs: [] },
];
const INCOME = ['Salario', 'Ingresos extra', 'Intereses', 'Otros ingresos'];

export async function seedUser(db: Db, userId: string) {
  for (const c of EXPENSE) {
    const r = await db.query(
      "INSERT INTO categories(user_id,name,nature,kind,icon) VALUES ($1,$2,$3,'expense',$4) RETURNING id",
      [userId, c.name, c.nature, c.icon],
    );
    for (const s of c.subs) {
      await db.query("INSERT INTO categories(user_id,parent_id,name,nature,kind) VALUES ($1,$2,$3,$4,'expense')", [userId, r.rows[0].id, s, c.nature]);
    }
  }
  for (const n of INCOME) {
    await db.query("INSERT INTO categories(user_id,name,nature,kind,icon) VALUES ($1,$2,'discretionary','income','coin')", [userId, n]);
  }
}
