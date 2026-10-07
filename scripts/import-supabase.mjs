import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { postgresOptions } from '../lib/db.mjs';
import { readBankDump, dumpColumns } from '../lib/sql-dump.mjs';

const source = process.argv[2];
if (!source || !process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL in .env.supabase.local, then run npm run db:supabase -- "C:\\Users\\yukij\\BANK 1.sql"');
  process.exit(1);
}
const data = readBankDump(await readFile(source, 'utf8'));
const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
const pool = new pg.Pool(postgresOptions());
let client;
try {
  client = await pool.connect();
  await client.query('BEGIN');
  await client.query(schema);
  const counts = [];
  for (const name of Object.keys(dumpColumns)) {
    const result = await client.query(`SELECT COUNT(*) AS count FROM bank.${name}`);
    counts.push(Number(result.rows[0].count));
  }
  if (counts.some(count => count > 0)) {
    if (!counts[0] || !counts[1]) throw new Error('Database is partially populated; import stopped to preserve existing data');
    console.log('Existing data retained; no rows overwritten.');
  } else {
    for (const [name, columns] of Object.entries(dumpColumns)) {
      const placeholders = columns.map((_, index) => '$' + (index + 1)).join(', ');
      for (const row of data[name]) await client.query(`INSERT INTO bank.${name} (${columns.join(', ')}) VALUES (${placeholders})`, row);
    }
    console.log('SQL data imported to the private bank schema.');
  }
  await client.query('COMMIT');
  for (const name of Object.keys(dumpColumns)) {
    const result = await client.query(`SELECT COUNT(*) AS count FROM bank.${name}`);
    console.log(`${name}: ${result.rows[0].count} rows`);
  }
} catch (error) {
  if (client) await client.query('ROLLBACK');
  console.error('Supabase import failed:', error.code || error.message);
  process.exitCode = 1;
} finally {
  client?.release(); await pool.end();
}
