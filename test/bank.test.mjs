import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import handler from '../api/bank.mjs';
import { connectionOptions, closePool, getPool, sessionSchema, usesPostgres, postgresOptions, table } from '../lib/db.mjs';

test(`${usesPostgres() ? 'PostgreSQL' : 'MySQL'} account and transaction flow`, { skip: !process.env.DB_HOST && !process.env.DATABASE_URL }, async t => {
  const database = 'bank_web_test_' + randomBytes(6).toString('hex');
  assert.match(database, /^bank_web_test_[a-f0-9]{12}$/);
  const postgres = usesPostgres();
  const originalDatabase = process.env.DB_NAME;
  const originalSchema = process.env.DATABASE_SCHEMA;
  const { database: ignoredDatabase, ...options } = connectionOptions();
  const admin = postgres ? new pg.Pool(postgresOptions()) : await mysql.createConnection(options);
  let server;
  let created = false;
  try {
    if (postgres) process.env.DATABASE_SCHEMA = database;
    else {
      await admin.query('CREATE DATABASE ?? CHARACTER SET utf8mb4', [database]);
      created = true;
      process.env.DB_NAME = database;
    }
    const pool = getPool();
    if (postgres) {
      const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
      await pool.query(schema.replace(/\bbank\b/g, database));
      created = true;
    } else {
    await pool.query(`CREATE TABLE kokyaku_master (customer_id VARCHAR(20) PRIMARY KEY, name VARCHAR(255), name_kana VARCHAR(255)) ENGINE=InnoDB`);
    await pool.query(`CREATE TABLE kouza_master (account_id VARCHAR(20) PRIMARY KEY, customer_id VARCHAR(20), bank_code VARCHAR(10), branch_id VARCHAR(10), account_number VARCHAR(20), pin VARCHAR(10), balance BIGINT) ENGINE=InnoDB`);
    await pool.query(`CREATE TABLE torihiki_table (deal_id VARCHAR(20) PRIMARY KEY, bank_id VARCHAR(20), deal_date DATE, deal_code VARCHAR(255), price BIGINT, inbank_price BIGINT, comment VARCHAR(255)) ENGINE=InnoDB`);
    await pool.query(sessionSchema);
    }
    if (postgres) {
      await pool.query(`INSERT INTO ${table('kokyaku_master')} VALUES ('test-a','テスト太郎','テストタロウ','男','000','000','テスト','テスト','2000-01-01'),('test-b','テスト花子','テストハナコ','女','000','000','テスト','テスト','2000-01-01')`);
    } else {
      await pool.query("INSERT INTO kokyaku_master VALUES ('test-a','テスト太郎','テストタロウ'),('test-b','テスト花子','テストハナコ')");
    }
    await pool.query(`INSERT INTO ${table('kouza_master')} (account_id,customer_id,bank_code,branch_id,account_number,pin,balance) VALUES ('account-a','test-a','0158','999','9999998','0082',500),('account-b','test-b','0158','999','9999999','4321',300)`);
    server = createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let cookie = '';
    async function request(action, input, extraHeaders = {}) {
      const response = await fetch(base + '/api/bank?action=' + action, {
        method: input === undefined ? 'GET' : 'POST',
        headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json', ...extraHeaders },
        body: input === undefined ? undefined : JSON.stringify(input)
      });
      return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie') };
    }
    const credentials = { bankCode: '0158', branchCode: '999', accountNumber: '9999998', pin: '0082' };
    const balances = async () => {
      const [rows] = await pool.query(`SELECT balance FROM ${table('kouza_master')} ORDER BY account_id`);
      return rows.map(row => Number(row.balance));
    };
    await t.test('anonymous access, bad credentials, and CSRF are rejected', async () => {
      assert.equal((await request('history')).status, 401);
      assert.equal((await request('login', { ...credentials, pin: '0000' })).status, 401);
      assert.equal((await request('login', { ...credentials, accountNumber: "' OR 1=1" })).status, 400);
      assert.equal((await request('login', credentials, { Origin: 'https://other.example' })).status, 403);
    });
    await t.test('zero-prefixed PINs and account identifiers are preserved', async () => {
      const result = await request('login', credentials);
      assert.equal(result.status, 200);
      assert.equal(result.data.account.balance, 500);
      assert.equal(result.data.account.bankCode, '0158');
      assert.ok(!('pin' in result.data.account));
      assert.match(result.cookie, /HttpOnly; SameSite=Strict/);
      cookie = result.cookie.split(';')[0];
      assert.equal((await request('session')).data.account.id, 'account-a');
      assert.equal((await request('balance', { pin: credentials.pin })).data.receipt.amount, 500);
      assert.equal((await request('balance', { pin: '0000' })).status, 401);
    });
    await t.test('invalid amounts do not change balances', async () => {
      for (const amount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '100']) {
        assert.equal((await request('deposit', { amount })).status, 400);
      }
      assert.deepEqual(await balances(), [500, 300]);
    });
    await t.test('deposits, concurrent updates, and withdrawals persist', async () => {
      const deposit = await request('deposit', { amount: 100 });
      assert.equal(deposit.data.account.balance, 600);
      assert.equal(deposit.data.receipt.before, 500);
      assert.match(deposit.data.receipt.id, /^\d{13}[a-f0-9]{7}$/);
      const updates = await Promise.all([1, 1, 1].map(amount => request('deposit', { amount })));
      updates.forEach(result => assert.equal(result.status, 200));
      assert.deepEqual(await balances(), [603, 300]);
      assert.equal((await request('withdraw', { amount: 10, pin: credentials.pin })).data.account.balance, 593);
      assert.equal((await request('withdraw', { amount: 1000, pin: credentials.pin })).status, 409);
    });
    const transfer = { bankCode: '0158', branchCode: '999', accountNumber: '9999999', recipientName: 'テスト ハナコ', amount: 20, pin: credentials.pin };
    await t.test('transfers validate the destination and update both accounts', async () => {
      assert.equal((await request('transfer', { ...transfer, recipientName: '別人' })).status, 400);
      assert.equal((await request('transfer', { ...transfer, accountNumber: '0000000' })).status, 404);
      assert.equal((await request('transfer', { ...transfer, accountNumber: credentials.accountNumber })).status, 400);
      const result = await request('transfer', transfer);
      assert.equal(result.status, 200);
      assert.equal(result.data.receipt.destination.recipientName, 'テスト花子');
      assert.deepEqual(await balances(), [573, 320]);
      const [[row]] = await pool.query(`SELECT COUNT(*) AS count FROM ${table('torihiki_table')} WHERE deal_code IN ('3','4')`);
      assert.equal(Number(row.count), 2);
    });
    await t.test('a recipient balance failure rolls back the sender update', async () => {
      await pool.execute(`UPDATE ${table('kouza_master')} SET balance=? WHERE account_id=?`, [String(Number.MAX_SAFE_INTEGER), 'account-b']);
      assert.equal((await request('transfer', { ...transfer, amount: 1 })).status, 422);
      assert.deepEqual(await balances(), [573, Number.MAX_SAFE_INTEGER]);
      await pool.execute(`UPDATE ${table('kouza_master')} SET balance=320 WHERE account_id=?`, ['account-b']);
    });
    await t.test('concurrent withdrawals cannot overdraw an account', async () => {
      const results = await Promise.all([1, 2].map(() => request('withdraw', { amount: 400, pin: credentials.pin })));
      assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
      assert.deepEqual(await balances(), [173, 320]);
    });
    await t.test('history belongs to the session account and logout revokes the token', async () => {
      const result = await request('history');
      assert.equal(result.status, 200);
      assert.equal(result.data.history.length, 7);
      assert.ok(result.data.history.every(row => row.kind !== '振込入金'));
      assert.equal((await request('session')).data.account.balance, 173);
      assert.equal((await request('logout', {})).status, 200);
      assert.equal((await request('session')).data.account, null);
      assert.equal((await request('deposit', { amount: 1 })).status, 401);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await closePool();
    // Only the random, test-owned database/schema created above may be removed.
    if (created && postgres) await admin.query(`DROP SCHEMA IF EXISTS ${database} CASCADE`);
    else if (created) await admin.query('DROP DATABASE IF EXISTS ??', [database]);
    await admin.end();
    if (originalDatabase === undefined) delete process.env.DB_NAME;
    else process.env.DB_NAME = originalDatabase;
    if (originalSchema === undefined) delete process.env.DATABASE_SCHEMA;
    else process.env.DATABASE_SCHEMA = originalSchema;
  }
});
