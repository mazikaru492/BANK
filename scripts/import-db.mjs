import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
import { connectionOptions, sessionSchema } from '../lib/db.mjs';

const source = process.argv[2];
if (!source) {
  console.error('Usage: npm run db:import -- "C:\\Users\\yukij\\BANK 1.sql"');
  process.exit(1);
}
const dump = await readFile(source, 'utf8');
const tables = ['kokyaku_master', 'kouza_master', 'torihiki_table'];
const definitions = tables.map(table => {
  const create = dump.match(new RegExp('CREATE TABLE `' + table + '` \\([\\s\\S]*?\\) ENGINE=[^;]+;'))?.[0];
  if (!create) throw new Error(`Missing table definition: ${table}`);
  return create.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS');
});
const options = connectionOptions();
const { database, ...serverOptions } = options;
const connection = await mysql.createConnection(serverOptions);
try {
  await connection.query('CREATE DATABASE IF NOT EXISTS ?? CHARACTER SET utf8mb4', [database]);
  await connection.changeUser({ database });
  for (const definition of definitions) await connection.query(definition);
  const counts = [];
  for (const table of tables) {
    const [[row]] = await connection.query('SELECT COUNT(*) AS count FROM ??', [table]);
    counts.push(Number(row.count));
  }
  if (counts.some(count => count > 0)) {
    if (!counts[0] || !counts[1]) throw new Error('Database is partially populated; import stopped to preserve existing data.');
    console.log('Existing data retained; no SQL data was overwritten.');
  } else {
    await connection.beginTransaction();
    try {
      for (const table of tables) {
        const inserts = dump.match(new RegExp('^INSERT INTO `' + table + '` VALUES [^\\r\\n]+;', 'gm')) || [];
        for (const statement of inserts) await connection.query(statement);
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
    console.log('Imported SQL data.');
  }
  await connection.query(sessionSchema);
  for (const table of tables) {
    const [[row]] = await connection.query('SELECT COUNT(*) AS count FROM ??', [table]);
    console.log(`${table}: ${row.count} rows`);
  }
} finally {
  await connection.end();
}
