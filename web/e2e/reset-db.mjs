// Base limpia para cada ejecución de pruebas de interfaz (se ejecuta antes de levantar el servidor).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pg = require('pg');
const base = process.env.E2E_PG ?? 'postgres://nova:nova@localhost:5432';
const admin = new pg.Client({ connectionString: `${base}/postgres` });
await admin.connect();
if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname='nova_e2e'")).rowCount) await admin.query('CREATE DATABASE nova_e2e');
await admin.end();
const c = new pg.Client({ connectionString: `${base}/nova_e2e` });
await c.connect();
await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await c.end();
