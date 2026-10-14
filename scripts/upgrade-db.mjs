import { closePool, databaseConfigured, featureSchema, getPool } from '../lib/db.mjs';

if (!databaseConfigured()) throw new Error('Configure DB_HOST or DATABASE_URL before upgrading.');
try {
  for (const statement of featureSchema()) await getPool().query(statement);
  console.log('Feature tables ready. Existing bank data retained.');
} finally { await closePool(); }
