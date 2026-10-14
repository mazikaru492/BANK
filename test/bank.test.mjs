import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import handler from '../api/bank.mjs';
import { connectionOptions, closePool, getPool, sessionSchema, featureSchema, usesPostgres, postgresOptions, table } from '../lib/db.mjs';
import { japanDate } from '../lib/bank.mjs';
import { companies, bookFor, feeFor, limitsFor, quantityForBudget, reservedCash } from '../assets/stocks.mjs';

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
    await pool.query(`CREATE TABLE kokyaku_master (customer_id VARCHAR(20) PRIMARY KEY, name VARCHAR(255) NOT NULL, name_kana VARCHAR(255) NOT NULL,
      gender VARCHAR(10) NOT NULL, phone_number VARCHAR(20) NOT NULL, postal_code VARCHAR(10) NOT NULL,
      prefecture VARCHAR(20) NOT NULL, address VARCHAR(255) NOT NULL, birth_date DATE NOT NULL) ENGINE=InnoDB`);
    await pool.query(`CREATE TABLE kouza_master (account_id VARCHAR(20) PRIMARY KEY, customer_id VARCHAR(20), bank_code VARCHAR(10), branch_id VARCHAR(10), account_number VARCHAR(20), pin VARCHAR(10), balance BIGINT) ENGINE=InnoDB`);
    await pool.query(`CREATE TABLE torihiki_table (deal_id VARCHAR(20) PRIMARY KEY, bank_id VARCHAR(20), deal_date DATE, deal_code VARCHAR(255), price BIGINT, inbank_price BIGINT, comment VARCHAR(255)) ENGINE=InnoDB`);
    await pool.query(sessionSchema);
    }
    for (const statement of featureSchema()) await pool.query(statement);
    await pool.query(`INSERT INTO ${table('kokyaku_master')} VALUES ('test-a','テスト太郎','テストタロウ','男','000','000','テスト','テスト','2000-01-01'),('test-b','テスト花子','テストハナコ','女','000','000','テスト','テスト','2000-01-01')`);
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
    await t.test('feature endpoints require a session', async () => {
      for (const action of ['settings', 'investment', 'stocks', 'statements']) assert.equal((await request(action)).status, 401);
      for (const action of ['stock-order', 'stock-cancel']) assert.equal((await request(action, {})).status, 401);
      assert.equal((await request('settings', { limit: 10, pin: credentials.pin })).status, 401);
      const result = await request('login', credentials); cookie = result.cookie.split(';')[0];
    });
    await t.test('daily limits include earlier withdrawals and serialize concurrent requests', async () => {
      for (const limit of [-1, 1.5, '100', Number.MAX_SAFE_INTEGER + 1]) assert.equal((await request('settings', { limit, pin: credentials.pin })).status, 400);
      assert.equal((await request('settings', { limit: 430, pin: '0000' })).status, 401);
      const saved = await request('settings', { limit: 430, pin: credentials.pin });
      assert.deepEqual(saved.data.settings, { limit: 430, used: 410, remaining: 20, date: japanDate() });
      const updates = await Promise.all([1, 2].map(() => request('withdraw', { amount: 15, pin: credentials.pin })));
      assert.deepEqual(updates.map(result => result.status).sort(), [200, 409]);
      assert.equal((await request('settings')).data.settings.remaining, 5);
      // Yesterday's withdrawals must not consume today's allowance.
      await pool.execute(`INSERT INTO ${table('torihiki_table')} (deal_id, bank_id, deal_date, deal_code, price, inbank_price, comment)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, ['old-withdrawal', 'account-a', japanDate(new Date(Date.now() - 86400000)), '2', 500, 0, 'test']);
      assert.equal((await request('settings')).data.settings.used, 425);
      assert.equal((await request('settings', { limit: 0, pin: credentials.pin })).status, 200);
      assert.equal((await request('withdraw', { amount: 1, pin: credentials.pin })).status, 409);
      assert.equal((await request('settings', { limit: null, pin: credentials.pin })).data.settings.remaining, null);
      assert.equal((await request('session')).data.account.balance, 158);
    });
    await t.test('investment trades preserve balances, holdings and transaction history', async () => {
      let quote = await request('investment');
      assert.equal(quote.data.market.price, 1000);
      assert.deepEqual(quote.data.holding, { quantity: 0, cost: 0 });
      const trade = { quantity: 2, price: 1000, pin: credentials.pin };
      assert.equal((await request('invest-buy', trade)).status, 409);
      await request('deposit', { amount: 10000 });
      for (const quantity of [0, -1, 1.5, '1']) assert.equal((await request('invest-buy', { ...trade, quantity })).status, 400);
      assert.equal((await request('invest-buy', { ...trade, price: 1 })).status, 409);
      assert.equal((await request('invest-buy', { ...trade, pin: '0000' })).status, 401);
      const bought = await request('invest-buy', trade);
      assert.equal(bought.status, 200); assert.equal(bought.data.account.balance, 8158);
      assert.deepEqual(bought.data.holding, { quantity: 2, cost: 2000 });
      assert.equal((await request('invest-sell', { ...trade, quantity: 3 })).status, 409);
      const sold = await request('invest-sell', { ...trade, quantity: 1 });
      assert.equal(sold.data.account.balance, 9158); assert.deepEqual(sold.data.holding, { quantity: 1, cost: 1000 });
      const sales = await Promise.all([1, 2].map(() => request('invest-sell', { ...trade, quantity: 1 })));
      assert.deepEqual(sales.map(result => result.status).sort(), [200, 409]);
      assert.deepEqual((await request('investment')).data.holding, { quantity: 0, cost: 0 });
      assert.equal((await request('session')).data.account.balance, 10158);
      assert.equal((await request('settings')).data.settings.used, 425);
      assert.ok((await request('history')).data.history.some(item => item.kind === '投資購入'));
      // Make the next quote due without slowing the test down.
      await pool.execute(`UPDATE ${table('bank_market')} SET updated_at=? WHERE market_id=?`, [Date.now() - 4000, 'manabi']);
      quote = await request('investment');
      assert.notEqual(quote.data.market.price, 1000); assert.equal(quote.data.market.prices.length, 2);
      assert.equal((await request('invest-buy', trade)).status, 409);
    });
    await t.test('card entries validate dates and amounts, persist and keep the balance unchanged', async () => {
      const entry = { cardType: 'virtual-card', date: japanDate(), merchant: 'まなび書店', amount: 1500 };
      assert.deepEqual((await request('statements')).data.entries, []);
      for (const change of [{ date: '2026-02-30' }, { date: '9999-01-01' }, { merchant: '' }, { cardType: 'other' }, { amount: -1 }, { amount: 1.5 }]) {
        assert.equal((await request('card-entry', { ...entry, ...change })).status, 400);
      }
      assert.equal((await request('card-entry', entry)).status, 200);
      const rows = (await request('statements')).data.entries;
      assert.equal(rows.length, 1); assert.equal(rows[0].merchant, entry.merchant); assert.equal(rows[0].sample, false);
      assert.equal((await request('session')).data.account.balance, 10158);
      await request('logout', {});
      const other = await request('login', { ...credentials, accountNumber: '9999999', pin: '4321' }); cookie = other.cookie.split(';')[0];
      assert.deepEqual((await request('statements')).data.entries, []);
      assert.deepEqual((await request('investment')).data.holding, { quantity: 0, cost: 0 });
      assert.equal((await request('settings')).data.settings.limit, null);
    });
    await t.test('100-stock orders persist, reserve cash and shares, fill limits and isolate accounts', async () => {
      const signedIn = await request('login', credentials); cookie = signedIn.cookie.split(';')[0];
      await request('deposit', { amount: 1000000 });
      let snapshot = (await request('stocks')).data;
      assert.equal(Object.keys(snapshot.market.quotes).length, 100);
      assert.deepEqual(snapshot.portfolio.holdings, {});
      // Freeze the test-owned market so quote changes cannot make assertions flaky.
      snapshot.market.updatedAt = Date.now() + 3600000;
      await pool.execute(`UPDATE ${table('bank_stock_market')} SET payload=? WHERE market_id=?`, [JSON.stringify(snapshot.market), 'jp-stocks']);
      const price = bookFor(snapshot.market.quotes['7203']).ask;
      const buy = { symbol: '7203', side: 'buy', type: 'market', quantity: 2, unit: 1, expectedPrice: price, pin: credentials.pin };
      for (const patch of [{ quantity: 1, unit: 100 }, { symbol: 'bad' }, { expectedPrice: 1 }]) assert.ok((await request('stock-order', { ...buy, ...patch })).status >= 400);
      assert.equal((await request('stock-order', { ...buy, pin: '0000' })).status, 401);
      const bought = await request('stock-order', buy); assert.equal(bought.status, 200);
      const cost = price * 2 + feeFor(price * 2);
      assert.equal(bought.data.account.balance, snapshot.account.balance - cost); assert.equal(bought.data.portfolio.holdings['7203'].cost, cost);
      const low = limitsFor(snapshot.market.quotes['7203']).low;
      const pending = await request('stock-order', { ...buy, type: 'limit', limitPrice: low, quantity: 100, unit: 100 });
      assert.equal(pending.data.order.status, 'open'); assert.equal(pending.data.account.balance, bought.data.account.balance);
      const heldCash = reservedCash(pending.data.portfolio);
      assert.equal((await request('withdraw', { amount: pending.data.account.balance - heldCash + 1, pin: credentials.pin })).status, 409);
      const cancelled = await request('stock-cancel', { id: pending.data.order.id }); assert.equal(cancelled.status, 200); assert.equal(reservedCash(cancelled.data.portfolio), 0);
      assert.equal((await request('stock-cancel', { id: pending.data.order.id })).status, 409);
      const sellPrice = bookFor(snapshot.market.quotes['7203']).bid;
      const sales = await Promise.all([1, 2].map(() => request('stock-order', { ...buy, side: 'sell', quantity: 2, expectedPrice: sellPrice })));
      assert.deepEqual(sales.map(s => s.status).sort(), [200, 409]);
      const waiting = await request('stock-order', { ...buy, type: 'limit', limitPrice: price - 10, quantity: 1 }); assert.equal(waiting.data.order.status, 'open');
      const crossing = structuredClone(snapshot.market); crossing.quotes['7203'].price = price - 20;
      await pool.execute(`UPDATE ${table('bank_stock_market')} SET payload=? WHERE market_id=?`, [JSON.stringify(crossing), 'jp-stocks']);
      const filled = await request('stocks'); assert.equal(filled.data.fills.length, 1); assert.equal(filled.data.portfolio.holdings['7203'].quantity, 1);
      assert.equal((await request('stocks')).data.fills.length, 0);
      await request('logout', {}); const again = await request('login', credentials); cookie = again.cookie.split(';')[0];
      assert.equal((await request('stocks')).data.portfolio.holdings['7203'].quantity, 1);
      const other = await request('login', { ...credentials, accountNumber: '9999999', pin: '4321' }); cookie = other.cookie.split(';')[0];
      assert.deepEqual((await request('stocks')).data.portfolio.holdings, {});
    });
    await t.test('old 30-company data upgrades without losing balances, holdings or bank history', async () => {
      const signedIn=await request('login',credentials); cookie=signedIn.cookie.split(';')[0];
      const before=(await request('stocks')).data, historyBefore=(await request('history')).data.history;
      const oldMarket=structuredClone(before.market), originalIds=companies.slice(0,30).map(c=>c.id);
      oldMarket.updatedAt=Date.now()+3600000;
      for(const id of Object.keys(oldMarket.quotes)) if(!originalIds.includes(id)) delete oldMarket.quotes[id];
      await pool.execute(`UPDATE ${table('bank_stock_market')} SET payload=? WHERE market_id=?`,[JSON.stringify(oldMarket),'jp-stocks']);
      const upgraded=await request('stocks'); assert.equal(upgraded.status,200);
      assert.equal(Object.keys(upgraded.data.market.quotes).length,100);
      for(const id of originalIds) assert.deepEqual(upgraded.data.market.quotes[id],oldMarket.quotes[id]);
      for(const key of ['day','tick','updatedAt','news']) assert.deepEqual(upgraded.data.market[key],oldMarket[key]);
      assert.equal(upgraded.data.account.balance,before.account.balance);
      assert.deepEqual(upgraded.data.portfolio,before.portfolio);
      assert.deepEqual((await request('history')).data.history,historyBefore);
      const corrupted=structuredClone(upgraded.data.market); corrupted.quotes['7203'].price=0;
      await pool.execute(`UPDATE ${table('bank_stock_market')} SET payload=? WHERE market_id=?`,[JSON.stringify(corrupted),'jp-stocks']);
      assert.equal((await request('stocks')).status,503);
      assert.equal((await request('session')).data.account.balance,before.account.balance);
      const [[stored]]=await pool.execute(`SELECT payload FROM ${table('bank_stock_market')} WHERE market_id=?`,['jp-stocks']);
      assert.deepEqual(JSON.parse(stored.payload),corrupted);
      await pool.execute(`UPDATE ${table('bank_stock_market')} SET payload=? WHERE market_id=?`,[JSON.stringify(upgraded.data.market),'jp-stocks']);
    });
    await t.test('a budget-funded purchase and later profitable sale persist net profit in the bank account',async()=>{
      const snapshot=(await request('stocks')).data, symbol='9432', market=structuredClone(snapshot.market);
      const candle={open:150,high:150,low:150,close:150,volume:0,day:market.day,tick:market.tick};
      market.updatedAt=Date.now()+3600000;
      market.quotes[symbol]={price:150,previousClose:150,open:150,high:150,low:150,volume:0,candles:[candle]};
      await pool.execute(`UPDATE ${table('bank_stock_market')} SET payload=? WHERE market_id=?`,[JSON.stringify(market),'jp-stocks']);
      const budget=1000,price=bookFor(market.quotes[symbol]).ask,quantity=quantityForBudget(budget,price);
      const input={symbol,side:'buy',type:'market',unit:1,quantity,expectedPrice:price,budget,pin:credentials.pin};
      assert.equal((await request('stock-order',{...input,quantity:quantity+1})).status,409);
      for(const badBudget of [0,-1,1.5,'1000']) assert.equal((await request('stock-order',{...input,budget:badBudget})).status,400);
      const bought=await request('stock-order',input); assert.equal(bought.status,200);
      const cost=price*quantity+feeFor(price*quantity);
      assert.ok(cost<=budget); assert.equal(bought.data.account.balance,snapshot.account.balance-cost);
      assert.equal(bought.data.order.budget,budget); assert.equal(bought.data.portfolio.holdings[symbol].cost,cost);
      market.quotes[symbol].price=180; market.quotes[symbol].high=180;
      market.quotes[symbol].candles=[{...candle,close:180,high:180}];
      await pool.execute(`UPDATE ${table('bank_stock_market')} SET payload=? WHERE market_id=?`,[JSON.stringify(market),'jp-stocks']);
      const sellPrice=bookFor(market.quotes[symbol]).bid;
      const {budget:ignoredBudget,...sell}=input;
      const sold=await request('stock-order',{...sell,side:'sell',expectedPrice:sellPrice}); assert.equal(sold.status,200);
      const profit=sellPrice*quantity-feeFor(sellPrice*quantity)-cost;
      assert.ok(profit>0); assert.equal(sold.data.order.profit,profit);
      assert.equal(sold.data.account.balance,snapshot.account.balance+profit);
      assert.equal(sold.data.portfolio.realized,snapshot.portfolio.realized+profit);
      assert.deepEqual(sold.data.portfolio.holdings[symbol],{quantity:0,cost:0});
      assert.equal((await request('session')).data.account.balance,snapshot.account.balance+profit);
      assert.equal((await request('stocks')).data.portfolio.realized,snapshot.portfolio.realized+profit);
      const history=(await request('history')).data.history;
      assert.ok(history.some(entry=>entry.kind==='投資購入'&&entry.amount===price*quantity));
      assert.ok(history.some(entry=>entry.kind==='投資売却'&&entry.amount===sellPrice*quantity));
    });
    const signup = { name: ' 新規 太郎 ', nameKana: 'しんき たろう', pin: '0082', pinConfirmation: '0082' };
    let registered;
    await t.test('registration validates names, kana, PIN confirmation and same-origin requests', async () => {
      await request('logout', {}); cookie = '';
      for (const patch of [{ name: '' }, { name: 'a'.repeat(101) }, { name: '\n太郎' }, { nameKana: '' }, { nameKana: '漢字' }, { nameKana: 'ーー・' }, { nameKana: 'ヽヾ' }, { pin: '123' }, { pin: 1234 }, { pinConfirmation: '0000' }]) {
        assert.equal((await request('register', { ...signup, ...patch })).status, 400);
      }
      assert.equal((await request('register', signup, { Origin: 'https://other.example' })).status, 403);
      const [[count]] = await pool.execute(`SELECT COUNT(*) AS total FROM ${table('bank_registered_accounts')}`);
      assert.equal(Number(count.total), 0);
    });
    await t.test('anonymous registration creates a zero-balance account with a private hashed PIN and session', async () => {
      const result = await request('register', { ...signup, balance: 999999, accountNumber: credentials.accountNumber, bankCode: '0158', branchCode: '999' });
      assert.equal(result.status, 201);
      registered = result.data.account;
      assert.equal(registered.name, '新規 太郎'); assert.equal(registered.nameKana, 'シンキ タロウ');
      assert.equal(registered.balance, 0); assert.equal(registered.bankCode, '0000'); assert.equal(registered.branchCode, '001');
      assert.match(registered.accountNumber, /^\d{7}$/); assert.match(registered.id, /^[a-f0-9]{20}$/);
      assert.ok(!('pin' in registered)); assert.ok(!('pinHash' in registered)); assert.ok(!('token' in result.data));
      assert.match(result.cookie, /HttpOnly; SameSite=Strict/);
      cookie = result.cookie.split(';')[0];
      assert.deepEqual((await request('session')).data.account, registered);
      const [[stored]] = await pool.execute(`SELECT a.pin, r.pin_hash FROM ${table('kouza_master')} a JOIN ${table('bank_registered_accounts')} r ON r.account_id=a.account_id WHERE a.account_id=?`, [registered.id]);
      assert.equal(stored.pin, 'WEB'); assert.match(stored.pin_hash, /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
      assert.notEqual(stored.pin_hash, signup.pin);
      assert.deepEqual((await request('history')).data.history, []);
      assert.deepEqual((await request('statements')).data.entries, []);
      assert.deepEqual((await request('stocks')).data.portfolio.holdings, {});
    });
    await t.test('registered accounts log in again and can deposit, withdraw, set limits and buy stocks using their PIN', async () => {
      await request('logout', {}); cookie = '';
      const input = { bankCode: registered.bankCode, branchCode: registered.branchCode, accountNumber: registered.accountNumber, pin: signup.pin };
      assert.equal((await request('login', { ...input, pin: '0000' })).status, 401);
      const result = await request('login', input); assert.equal(result.status, 200); cookie = result.cookie.split(';')[0];
      assert.equal((await request('deposit', { amount: 10000 })).data.account.balance, 10000);
      assert.equal((await request('withdraw', { amount: 10, pin: '0000' })).status, 401);
      assert.equal((await request('withdraw', { amount: 10, pin: signup.pin })).data.account.balance, 9990);
      assert.equal((await request('settings', { limit: 100, pin: '0000' })).status, 401);
      assert.equal((await request('settings', { limit: 100, pin: signup.pin })).data.settings.limit, 100);
      const legacyQuote = (await request('investment')).data.market.price;
      assert.equal((await request('invest-buy', { quantity: 1, price: legacyQuote, pin: signup.pin })).status, 200);
      const snapshot = (await request('stocks')).data;
      const price = bookFor(snapshot.market.quotes['9432']).ask;
      const order = { symbol: '9432', side: 'buy', type: 'market', unit: 1, quantity: 1, expectedPrice: price, pin: signup.pin };
      assert.equal((await request('stock-order', { ...order, pin: '0000' })).status, 401);
      const bought = await request('stock-order', order); assert.equal(bought.status, 200);
      assert.equal(bought.data.portfolio.holdings['9432'].quantity, 1);
      const ownHistoryIds = new Set((await request('history')).data.history.map(entry => entry.id));
      assert.equal(ownHistoryIds.size, 4);
      await request('logout', {}); cookie = '';
      const old = await request('login', credentials); assert.equal(old.status, 200); cookie = old.cookie.split(';')[0];
      assert.ok((await request('history')).data.history.every(entry => !ownHistoryIds.has(entry.id)));
      await request('logout', {}); cookie = '';
    });
    await t.test('concurrent registrations with identical names and PINs get different accounts and salts', async () => {
      const results = await Promise.all([1, 2].map(() => request('register', { ...signup, nameKana: 'しんきヽヾ たろう' })));
      results.forEach(result => assert.equal(result.status, 201));
      results.forEach(result => assert.equal(result.data.account.nameKana, 'シンキヽヾ タロウ'));
      const accounts = [registered, ...results.map(result => result.data.account)];
      assert.equal(new Set(accounts.map(account => account.id)).size, 3);
      assert.equal(new Set(accounts.map(account => account.accountNumber)).size, 3);
      const [rows] = await pool.execute(`SELECT pin_hash FROM ${table('bank_registered_accounts')}`);
      assert.equal(new Set(rows.map(row => row.pin_hash)).size, 3);
    });
    await t.test('a session creation failure rolls back the entire registration', async () => {
      const counts = async () => {
        const totals = [];
        for (const name of ['kokyaku_master', 'kouza_master', 'bank_registered_accounts']) {
          const [[row]] = await pool.execute(`SELECT COUNT(*) AS total FROM ${table(name)}`); totals.push(Number(row.total));
        }
        return totals;
      };
      const before = await counts();
      const renamed = postgres ? `${database}.bank_web_sessions_unavailable` : 'bank_web_sessions_unavailable';
      await pool.execute(`ALTER TABLE ${table('bank_web_sessions')} RENAME TO bank_web_sessions_unavailable`);
      try { assert.equal((await request('register', signup)).status, 503); }
      finally { await pool.execute(`ALTER TABLE ${renamed} RENAME TO bank_web_sessions`); }
      assert.deepEqual(await counts(), before);
      assert.equal((await request('login', { bankCode: registered.bankCode, branchCode: registered.branchCode, accountNumber: registered.accountNumber, pin: signup.pin })).status, 200);
    });
    await t.test('registration rate limiting does not block existing account login', async () => {
      assert.equal((await request('register', signup)).status, 201);
      assert.equal((await request('register', signup)).status, 429);
      assert.equal((await request('login', credentials)).status, 200);
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
