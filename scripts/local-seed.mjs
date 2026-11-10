import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { seedDemoCatalog } from './demo-catalog.mjs';

// Deliberately fixed to the isolated local cluster; ignores production PG*/DATABASE_URL.
const password = (await readFile('.local/admin.password', 'utf8')).trim();
const client = new pg.Client({ host: '127.0.0.1', port: 55432, database: 'mpos', user: 'mpos_admin', password });
await client.connect();
try { console.log('Demo catalog ready:', await seedDemoCatalog(client)); }
finally { await client.end(); }
