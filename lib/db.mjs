import mysql from 'mysql2/promise';
import pg from 'pg';
import { supabaseCa } from './supabase-ca.mjs';

let pool;
export const databaseConfigured = () => Boolean(process.env.DATABASE_URL || process.env.DB_HOST);
export const usesPostgres = () => Boolean(process.env.DATABASE_URL);

export function table(name) {
  if (!['kouza_master', 'kokyaku_master', 'torihiki_table', 'bank_web_sessions'].includes(name)) throw new Error('Unknown bank table');
  if (!usesPostgres()) return name;
  const schema = process.env.DATABASE_SCHEMA || 'bank';
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error('Invalid database schema');
  return `${schema}.${name}`;
}

export function postgresOptions() {
  const url = new URL(process.env.DATABASE_URL);
  // Set TLS explicitly; connection-string SSL options otherwise replace driver options.
  for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) url.searchParams.delete(key);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const ca = process.env.DATABASE_CA_CERT || (url.hostname.endsWith('.pooler.supabase.com') ? supabaseCa : undefined);
  return {
    connectionString: url.toString(), max: 1, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000, allowExitOnIdle: true,
    ssl: local && process.env.PG_SSL === 'false' ? false : {
      rejectUnauthorized: true,
      ...(ca ? { ca: ca.replace(/\\n/g, '\n') } : {})
    }
  };
}

export function postgresSql(sql) {
  // The bank's SQL uses only positional placeholders, never literal question marks.
  let index = 0;
  return sql.replace(/\?/g, () => '$' + ++index);
}

function postgresConnection(client) {
  const execute = async (sql, values = []) => [(await client.query(postgresSql(sql), values)).rows];
  return {
    execute, query: execute,
    beginTransaction: () => client.query('BEGIN'),
    commit: () => client.query('COMMIT'), rollback: () => client.query('ROLLBACK'),
    release: () => client.release()
  };
}

export function connectionOptions() {
  if (!databaseConfigured()) throw new Error('DB_HOST is not configured');
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'BANK',
    charset: 'utf8mb4',
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    timezone: 'Z',
    connectTimeout: 5000,
    ...(process.env.DB_SSL === 'true' ? { ssl: { rejectUnauthorized: true } } : {})
  };
}

export function getPool() {
  if (!pool && usesPostgres()) {
    const native = new pg.Pool(postgresOptions());
    native.on('error', error => console.error('Postgres pool error:', error.code || error.name));
    const execute = async (sql, values = []) => [(await native.query(postgresSql(sql), values)).rows];
    pool = { execute, query: execute, getConnection: async () => postgresConnection(await native.connect()), end: () => native.end() };
  }
  pool ??= mysql.createPool({ ...connectionOptions(), connectionLimit: 5, queueLimit: 50 });
  return pool;
}

export async function closePool() {
  if (pool) { await pool.end(); pool = undefined; }
}

export const sessionSchema = `CREATE TABLE IF NOT EXISTS bank_web_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  account_id VARCHAR(20) NOT NULL,
  expires_at DATETIME NOT NULL,
  INDEX (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
