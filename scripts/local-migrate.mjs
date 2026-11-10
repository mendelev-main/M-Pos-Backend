import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';

// This runner is only for the isolated local cluster, never the deployment pipeline.
const password = (await readFile('.local/admin.password', 'utf8')).trim();
const client = new pg.Client({ host: '127.0.0.1', port: 55432, database: 'mpos', user: 'mpos_admin', password });
await client.connect();
try {
  await client.query(`CREATE TABLE IF NOT EXISTS public.local_schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  for (const name of (await readdir('db/migrations')).filter(n => /^\d{3}_[a-z0-9_]+\.sql$/.test(n)).sort()) {
    const sql = await readFile(`db/migrations/${name}`, 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const { rows } = await client.query('SELECT checksum FROM public.local_schema_migrations WHERE name=$1', [name]);
    if (rows.length) {
      if (rows[0].checksum !== checksum) throw new Error(`Applied migration changed: ${name}`);
      console.log(`Already applied: ${name}`);
      continue;
    }
    if (!/^BEGIN;$/m.test(sql) || !/COMMIT;\s*$/.test(sql)) throw new Error(`Unsupported transaction wrapper: ${name}`);
    await client.query('BEGIN');
    try {
      await client.query(sql.replace(/^BEGIN;$/m, '').replace(/COMMIT;\s*$/, ''));
      await client.query('INSERT INTO public.local_schema_migrations(name,checksum) VALUES($1,$2)', [name, checksum]);
      await client.query('COMMIT');
      console.log(`Applied: ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await client.end();
}
