import { randomBytes, createHash, timingSafeEqual, randomInt } from 'node:crypto';
import { getPool, table, usesPostgres } from './db.mjs';
import { createPinHash, verifyPinHash } from './credentials.mjs';
import { companyById, createMarket, upgradeMarket, advanceMarket, emptyPortfolio, validPortfolio, validMarket, reservedCash, placeOrder, settleOrders, cancelOrder, StockError } from '../assets/stocks.mjs';

export class BankError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const reject = (status, message) => { throw new BankError(status, message); };
const hash = token => createHash('sha256').update(token).digest('hex');
const code = (value, length) => String(value ?? '').padStart(length, '0');
const accountColumns = 'a.account_id, a.bank_code, a.branch_id, a.account_number, a.balance, c.name, c.name_kana';
const publicAccount = row => ({
  id: row.account_id, bankCode: code(row.bank_code, 4), branchCode: code(row.branch_id, 3),
  accountNumber: code(row.account_number, 7), name: row.name, nameKana: row.name_kana,
  balance: safeBalance(row.balance)
});
function safeBalance(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) reject(422, '残高が取り扱い可能な範囲を超えています。');
  return number;
}
function checkPin(value, stored) {
  if (typeof value !== 'string' || !/^\d{4}$/.test(value)) reject(400, '暗証番号は4桁で入力してください。');
  const expected = Buffer.from(code(stored, 4));
  const supplied = Buffer.from(value);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) reject(401, '暗証番号が違います。');
}
async function verifyAccountPin(connection, accountId, value, legacyPin) {
  if (typeof value !== 'string' || !/^\d{4}$/.test(value)) reject(400, '暗証番号は4桁で入力してください。');
  const [[credentials]] = await connection.execute(`SELECT pin_hash FROM ${table('bank_registered_accounts')} WHERE account_id=?`, [accountId]);
  if (!credentials) return checkPin(value, legacyPin);
  if (!await verifyPinHash(value, credentials.pin_hash)) reject(401, '暗証番号が違います。');
}

function registrationInput(input) {
  if (typeof input.name !== 'string' || !input.name.trim() || [...input.name.trim()].length > 100 || /[\u0000-\u001f\u007f]/u.test(input.name)) reject(400, 'お名前を100文字以内で入力してください。');
  if (typeof input.nameKana !== 'string') reject(400, 'フリガナを100文字以内のカタカナで入力してください。');
  const nameKana = input.nameKana.normalize('NFKC').trim().replace(/[\u3041-\u3096]/g, letter => String.fromCharCode(letter.charCodeAt(0) + 0x60));
  if (!nameKana || [...nameKana].length > 100 || !/^[\u30a1-\u30fa\u30fd-\u30feー・ ]+$/u.test(nameKana) || !/[\u30a1-\u30fa]/u.test(nameKana)) reject(400, 'フリガナを100文字以内のカタカナで入力してください。');
  if (typeof input.pin !== 'string' || !/^\d{4}$/.test(input.pin)) reject(400, '暗証番号は4桁で入力してください。');
  if (input.pinConfirmation !== input.pin) reject(400, '確認用の暗証番号が一致しません。');
  return { name: input.name.trim(), nameKana, pin: input.pin };
}

const registrations = new Map();
function registrationAttempt(address) {
  const now = Date.now();
  for (const [key, value] of registrations) if (value.expires <= now) registrations.delete(key);
  const value = registrations.get(address) || { count: 0, expires: now + 15 * 60 * 1000 };
  if (value.count >= 5 || registrations.size >= 10000 && !registrations.has(address)) reject(429, '新規登録の回数が多すぎます。15分後にお試しください。');
  value.count++;
  registrations.set(address, value);
}

export async function register(input, clientAddress) {
  const details = registrationInput(input);
  registrationAttempt(clientAddress);
  const pinHash = await createPinHash(details.pin);
  const connection = await getPool().getConnection();
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      await connection.beginTransaction();
      try {
        const account = { id: randomBytes(10).toString('hex'), bankCode: '0000', branchCode: '001', accountNumber: String(randomInt(1000000, 10000000)), name: details.name, nameKana: details.nameKana, balance: 0 };
        const customerId = randomBytes(10).toString('hex');
        const [[existing]] = await connection.execute(`SELECT account_id FROM ${table('kouza_master')} WHERE bank_code=? AND branch_id=? AND account_number=?`, [account.bankCode, account.branchCode, account.accountNumber]);
        if (existing) { await connection.rollback(); continue; }
        await connection.execute(`INSERT INTO ${table('kokyaku_master')} (customer_id, name, name_kana, gender, phone_number, postal_code, prefecture, address, birth_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [customerId, account.name, account.nameKana, '', '', '', '', '', '1900-01-01']);
        await connection.execute(`INSERT INTO ${table('kouza_master')} (account_id, branch_id, account_number, customer_id, pin, bank_code, balance)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, [account.id, account.branchCode, account.accountNumber, customerId, 'WEB', account.bankCode, 0]);
        await connection.execute(`INSERT INTO ${table('bank_registered_accounts')} (account_id, bank_code, branch_code, account_number, pin_hash)
          VALUES (?, ?, ?, ?, ?)`, [account.id, account.bankCode, account.branchCode, account.accountNumber, pinHash]);
        const token = randomBytes(32).toString('hex');
        await connection.execute(`INSERT INTO ${table('bank_web_sessions')} (token_hash, account_id, expires_at) VALUES (?, ?, ?)`, [hash(token), account.id, new Date(Date.now() + 8 * 60 * 60 * 1000)]);
        await connection.commit();
        return { token, account };
      } catch (error) {
        await connection.rollback();
        if (error.code === 'ER_DUP_ENTRY' || error.code === '23505') continue;
        throw error;
      }
    }
    reject(503, '口座番号を発行できませんでした。しばらくしてからお試しください。');
  } finally { connection.release(); }
}
function checkAccountInput(input) {
  if (typeof input.bankCode !== 'string' || !/^\d{4}$/.test(input.bankCode)
    || typeof input.branchCode !== 'string' || !/^\d{3}$/.test(input.branchCode)
    || typeof input.accountNumber !== 'string' || !/^\d{7}$/.test(input.accountNumber)) {
    reject(400, '銀行コード4桁・支店コード3桁・口座番号7桁を入力してください。');
  }
}
const attempts = new Map();
function checkAttempts(key) {
  const now = Date.now();
  for (const [entry, value] of attempts) if (value.expires < now) attempts.delete(entry);
  const value = attempts.get(key);
  if (value?.count >= 10) reject(429, '暗証番号の確認回数が多すぎます。15分後にお試しください。');
  if (attempts.size > 10000) reject(429, 'しばらくしてからお試しください。');
}
function failedAttempt(key) {
  const value = attempts.get(key) || { count: 0, expires: Date.now() + 15 * 60 * 1000 };
  value.count++; attempts.set(key, value);
}

export async function login(input, clientAddress) {
  checkAccountInput(input);
  checkAttempts(clientAddress);
  const pool = getPool();
  const [rows] = await pool.execute(`SELECT ${accountColumns}, a.pin
    FROM ${table('kouza_master')} a JOIN ${table('kokyaku_master')} c ON c.customer_id=a.customer_id
    WHERE a.bank_code=? AND a.branch_id=? AND a.account_number=?`,
  [input.bankCode, input.branchCode, input.accountNumber]);
  try {
    if (rows.length !== 1) reject(401, '口座情報または暗証番号が違います。');
    await verifyAccountPin(pool, rows[0].account_id, input.pin, rows[0].pin);
  } catch (error) {
    failedAttempt(clientAddress);
    if (error.status === 401) reject(401, '口座情報または暗証番号が違います。');
    throw error;
  }
  const account = publicAccount(rows[0]);
  const token = randomBytes(32).toString('hex');
  await pool.execute(`DELETE FROM ${table('bank_web_sessions')} WHERE expires_at < ?`, [new Date()]);
  await pool.execute(`INSERT INTO ${table('bank_web_sessions')} (token_hash, account_id, expires_at) VALUES (?, ?, ?)`, [hash(token), account.id, new Date(Date.now() + 8 * 60 * 60 * 1000)]);
  return { token, account };
}

export async function sessionAccount(token) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const [rows] = await getPool().execute(`SELECT ${accountColumns}
    FROM ${table('bank_web_sessions')} s JOIN ${table('kouza_master')} a ON a.account_id=s.account_id
    JOIN ${table('kokyaku_master')} c ON c.customer_id=a.customer_id
    WHERE s.token_hash=? AND s.expires_at>?`, [hash(token), new Date()]);
  return rows[0] ? publicAccount(rows[0]) : null;
}

export async function logout(token) {
  if (token && /^[a-f0-9]{64}$/.test(token)) await getPool().execute(`DELETE FROM ${table('bank_web_sessions')} WHERE token_hash=?`, [hash(token)]);
}

export async function history(accountId) {
  const [rows] = await getPool().execute(`SELECT deal_id, deal_date, deal_code, price, inbank_price, comment
    FROM ${table('torihiki_table')} WHERE bank_id=? ORDER BY deal_date DESC, deal_id DESC LIMIT 20`, [accountId]);
  const names = { '0': '初期残高', '1': '入金', '2': '出金', '3': '振込', '4': '振込入金', '5': '投資購入', '6': '投資売却' };
  return rows.map(row => ({ id: row.deal_id, date: row.deal_date instanceof Date ? japanDate(row.deal_date) : row.deal_date, kind: names[row.deal_code] || row.deal_code,
    amount: Number(row.price), balance: Number(row.inbank_price), comment: row.comment || '' }));
}

const normalizedName = name => name.normalize('NFKC').replace(/\s/g, '');
export function japanDate(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
async function record(connection, accountId, kind, amount, balance, comment, date) {
  const id = String(Date.now()) + randomBytes(4).toString('hex').slice(0, 7);
  await connection.execute(`INSERT INTO ${table('torihiki_table')} (deal_id, bank_id, deal_date, deal_code, price, inbank_price, comment)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, accountId, japanDate(date), kind, amount, balance, comment]);
  return id;
}

export async function transact(account, kind, input, clientAddress) {
  if (!['balance', 'deposit', 'withdraw', 'transfer'].includes(kind)) reject(400, '取引区分が不正です。');
  const amount = input.amount;
  if (kind !== 'balance' && (!Number.isSafeInteger(amount) || amount < 1)) reject(400, '金額は1円以上の整数で入力してください。');
  if (kind === 'transfer') {
    checkAccountInput(input);
    if (typeof input.recipientName !== 'string' || !input.recipientName.trim() || input.recipientName.length > 255) reject(400, '振込先名義を入力してください。');
  }
  if (kind !== 'deposit') checkAttempts(clientAddress);
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    let target;
    if (kind === 'transfer') {
      const [destinations] = await connection.execute(`SELECT a.account_id, c.name, c.name_kana
        FROM ${table('kouza_master')} a JOIN ${table('kokyaku_master')} c ON c.customer_id=a.customer_id
        WHERE a.bank_code=? AND a.branch_id=? AND a.account_number=?`, [input.bankCode, input.branchCode, input.accountNumber]);
      if (destinations.length !== 1) reject(404, '振込先口座が見つかりません。');
      target = destinations[0];
      if (target.account_id === account.id) reject(400, '同じ口座への振込はできません。');
      if (![target.name, target.name_kana].some(name => normalizedName(name) === normalizedName(input.recipientName))) reject(400, '振込先の口座名義が一致しません。');
    }
    // Always lock both accounts in the same order, including opposite-direction transfers.
    const [rows] = await connection.execute(`SELECT account_id, balance, pin FROM ${table('kouza_master')}
      WHERE account_id IN (?, ?) ORDER BY account_id FOR UPDATE`, [account.id, target?.account_id || account.id]);
    const source = rows.find(row => row.account_id === account.id);
    if (!source) reject(401, '口座が見つかりません。再度ログインしてください。');
    if (kind !== 'deposit') {
      try { await verifyAccountPin(connection, account.id, input.pin, source.pin); }
      catch (error) { failedAttempt(clientAddress); throw error; }
    }
    const before = safeBalance(source.balance);
    const date = new Date();
    if (kind === 'balance') {
      await connection.commit();
      return { account: { ...account, balance: before }, receipt: { kind: '残高照会', amount: before, before, date: date.toISOString() } };
    }
    if (kind !== 'deposit' && amount > before) reject(409, '残高が不足しています。');
    if (['withdraw', 'transfer'].includes(kind) && amount > before - await stockReservation(connection, account.id)) reject(409, '未約定の株式注文で拘束中の金額は出金・振込できません。注文を取消すか、金額を減らしてください。');
    if (kind === 'withdraw') {
      const settings = await withdrawalSettings(account.id, connection, date);
      if (settings.limit !== null && amount > settings.remaining) reject(409, '1日の引き出し上限を超えます。今日の残り: ' + settings.remaining.toLocaleString('ja-JP') + ' 円');
    }
    const after = before + (kind === 'deposit' ? amount : -amount);
    safeBalance(after);
    await connection.execute(`UPDATE ${table('kouza_master')} SET balance=? WHERE account_id=?`, [after, account.id]);
    const names = { deposit: '入金', withdraw: '出金', transfer: '振込' };
    const kinds = { deposit: '1', withdraw: '2', transfer: '3' };
    let destination;
    if (target) {
      const recipient = rows.find(row => row.account_id === target.account_id);
      if (!recipient) reject(404, '振込先口座が見つかりません。');
      const targetAfter = safeBalance(safeBalance(recipient.balance) + amount);
      await connection.execute(`UPDATE ${table('kouza_master')} SET balance=? WHERE account_id=?`, [targetAfter, target.account_id]);
      await record(connection, target.account_id, '4', amount, targetAfter, `振込元: ${account.bankCode}/${account.branchCode}/${account.accountNumber}`, date);
      destination = { bankCode: input.bankCode, branchCode: input.branchCode, accountNumber: input.accountNumber, recipientName: target.name };
    }
    const id = await record(connection, account.id, kinds[kind], amount, after,
      destination ? `振込先: ${destination.bankCode}/${destination.branchCode}/${destination.accountNumber}` : '', date);
    await connection.commit();
    return { account: { ...account, balance: after }, receipt: { id, kind: names[kind], amount, before, date: date.toISOString(), destination } };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

export async function withdrawalSettings(accountId, connection = getPool(), date = new Date()) {
  const [preferences] = await connection.execute(`SELECT withdrawal_limit FROM ${table('bank_preferences')} WHERE account_id=?`, [accountId]);
  const [[row]] = await connection.execute(`SELECT COALESCE(SUM(price), 0) AS total FROM ${table('torihiki_table')}
    WHERE bank_id=? AND deal_code='2' AND deal_date=?`, [accountId, japanDate(date)]);
  const limit = preferences[0]?.withdrawal_limit == null ? null : safeBalance(preferences[0].withdrawal_limit);
  const used = safeBalance(row.total);
  return { limit, used, remaining: limit === null ? null : Math.max(0, limit - used), date: japanDate(date) };
}

export async function saveWithdrawalLimit(account, input, clientAddress) {
  const limit = input.limit;
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) reject(400, '上限額は0円以上の整数で入力してください。');
  checkAttempts(clientAddress);
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [[row]] = await connection.execute(`SELECT pin FROM ${table('kouza_master')} WHERE account_id=? FOR UPDATE`, [account.id]);
    if (!row) reject(401, 'ログインが必要です。');
    try { await verifyAccountPin(connection, account.id, input.pin, row.pin); } catch (error) { failedAttempt(clientAddress); throw error; }
    await connection.execute(`DELETE FROM ${table('bank_preferences')} WHERE account_id=?`, [account.id]);
    await connection.execute(`INSERT INTO ${table('bank_preferences')} (account_id, withdrawal_limit) VALUES (?, ?)`, [account.id, limit]);
    const settings = await withdrawalSettings(account.id, connection);
    await connection.commit();
    return { settings };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

async function marketRow(connection, advance = false) {
  const initial = [1000];
  const conflict = usesPostgres() ? 'ON CONFLICT (market_id) DO NOTHING' : 'ON DUPLICATE KEY UPDATE market_id=market_id';
  await connection.execute(`INSERT INTO ${table('bank_market')} (market_id, price, prices, updated_at) VALUES (?, ?, ?, ?)
    ${conflict}`,
  ['manabi', 1000, JSON.stringify(initial), Date.now()]);
  const [[row]] = await connection.execute(`SELECT price, prices, updated_at FROM ${table('bank_market')} WHERE market_id=? FOR UPDATE`, ['manabi']);
  let price = safeBalance(row.price);
  let prices = JSON.parse(row.prices);
  let updatedAt = Number(row.updated_at);
  if (advance && Date.now() - updatedAt >= 3000) {
    const change = randomInt(-200, 201);
    price = Math.max(1, Math.min(1000000, price + (Math.round(price * change / 10000) || (change < 0 ? -1 : 1))));
    prices = [...prices, price].slice(-40); updatedAt = Date.now();
    await connection.execute(`UPDATE ${table('bank_market')} SET price=?, prices=?, updated_at=? WHERE market_id=?`, [price, JSON.stringify(prices), updatedAt, 'manabi']);
  }
  return { price, prices, updatedAt };
}

export async function investment(account) {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const market = await marketRow(connection, true);
    const [[holding]] = await connection.execute(`SELECT quantity, cost FROM ${table('bank_holdings')} WHERE account_id=?`, [account.id]);
    await connection.commit();
    return { market, holding: { quantity: safeBalance(holding?.quantity || 0), cost: safeBalance(holding?.cost || 0) } };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

export async function tradeInvestment(account, kind, input, clientAddress) {
  if (!['invest-buy', 'invest-sell'].includes(kind)) reject(400, '売買区分が不正です。');
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) reject(400, '数量は1口以上の整数で入力してください。');
  if (!Number.isSafeInteger(input.price) || input.price < 1) reject(400, '価格が不正です。');
  checkAttempts(clientAddress);
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [[source]] = await connection.execute(`SELECT balance, pin FROM ${table('kouza_master')} WHERE account_id=? FOR UPDATE`, [account.id]);
    if (!source) reject(401, 'ログインが必要です。');
    try { await verifyAccountPin(connection, account.id, input.pin, source.pin); } catch (error) { failedAttempt(clientAddress); throw error; }
    const market = await marketRow(connection);
    if (input.price !== market.price) reject(409, '価格が変わりました。最新の価格と合計金額を確認して、再度操作してください。');
    const amount = safeBalance(market.price * input.quantity);
    const [[holding]] = await connection.execute(`SELECT quantity, cost FROM ${table('bank_holdings')} WHERE account_id=?`, [account.id]);
    const quantity = safeBalance(holding?.quantity || 0), cost = safeBalance(holding?.cost || 0);
    const buy = kind === 'invest-buy';
    const before = safeBalance(source.balance);
    if (buy && amount > before) reject(409, '残高が不足しています。');
    if (buy && amount > before - await stockReservation(connection, account.id)) reject(409, '未約定の株式注文で拘束中の金額は利用できません。');
    if (!buy && input.quantity > quantity) reject(409, '保有数量が不足しています。');
    const after = safeBalance(before + (buy ? -amount : amount));
    const nextQuantity = safeBalance(quantity + (buy ? input.quantity : -input.quantity));
    const nextCost = buy ? safeBalance(cost + amount) : nextQuantity === 0 ? 0 : cost - Math.floor(cost * (input.quantity / quantity));
    await connection.execute(`UPDATE ${table('kouza_master')} SET balance=? WHERE account_id=?`, [after, account.id]);
    await connection.execute(`DELETE FROM ${table('bank_holdings')} WHERE account_id=?`, [account.id]);
    await connection.execute(`INSERT INTO ${table('bank_holdings')} (account_id, quantity, cost) VALUES (?, ?, ?)`, [account.id, nextQuantity, nextCost]);
    const date = new Date();
    const id = await record(connection, account.id, buy ? '5' : '6', amount, after, `MANABI インデックス ${input.quantity}口 / ${market.price}円`, date);
    await connection.commit();
    return { account: { ...account, balance: after }, market, holding: { quantity: nextQuantity, cost: nextCost },
      receipt: { id, kind: buy ? '投資購入' : '投資売却', amount, before, date: date.toISOString() } };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

async function stockReservation(connection, accountId) {
  const [[row]] = await connection.execute(`SELECT state FROM ${table('bank_stock_accounts')} WHERE account_id=?`, [accountId]);
  return row ? reservedCash(JSON.parse(row.state)) : 0;
}

// Lock account first, then the shared market, for every read/fill/order/cancellation.
async function stockOperation(account, input, clientAddress, cancelId) {
  if (input) checkAttempts(clientAddress);
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [[source]] = await connection.execute(`SELECT balance, pin FROM ${table('kouza_master')} WHERE account_id=? FOR UPDATE`, [account.id]);
    if (!source) reject(401, 'ログインが必要です。');
    if (input) {
      try { await verifyAccountPin(connection, account.id, input.pin, source.pin); } catch (error) { failedAttempt(clientAddress); throw error; }
    }
    const conflict = usesPostgres() ? 'ON CONFLICT (market_id) DO NOTHING' : 'ON DUPLICATE KEY UPDATE market_id=market_id';
    const [[existingMarket]] = await connection.execute(`SELECT payload FROM ${table('bank_stock_market')} WHERE market_id=?`, ['jp-stocks']);
    let market;
    if (existingMarket) {
      const [[locked]] = await connection.execute(`SELECT payload FROM ${table('bank_stock_market')} WHERE market_id=? FOR UPDATE`, ['jp-stocks']);
      market = JSON.parse(locked.payload);
    }
    else {
      market = createMarket();
      await connection.execute(`INSERT INTO ${table('bank_stock_market')} (market_id, payload) VALUES (?, ?) ${conflict}`, ['jp-stocks', JSON.stringify(market)]);
      // Re-read under lock if a different account initialized the market first.
      const [[row]] = await connection.execute(`SELECT payload FROM ${table('bank_stock_market')} WHERE market_id=? FOR UPDATE`, ['jp-stocks']);
      market = JSON.parse(row.payload);
    }
    market = upgradeMarket(market);
    if (!validMarket(market)) reject(503, '練習市場の保存データを確認してください。');
    market = advanceMarket(market);
    await connection.execute(`UPDATE ${table('bank_stock_market')} SET payload=? WHERE market_id=?`, [JSON.stringify(market), 'jp-stocks']);
    const [[row]] = await connection.execute(`SELECT state FROM ${table('bank_stock_accounts')} WHERE account_id=?`, [account.id]);
    let state = row ? JSON.parse(row.state) : emptyPortfolio();
    if (!validPortfolio(state)) reject(503, '保有株・注文の保存データを確認してください。');
    const before = safeBalance(source.balance);
    let result = settleOrders(state, market, before), balance = result.balance, fills = result.fills, order;
    state = result.state;
    if (cancelId) state = cancelOrder(state, cancelId);
    if (input) {
      result = placeOrder(state, input, market, balance, randomBytes(10).toString('hex'));
      state = result.state; balance = result.balance; order = result.order; fills = [...fills, ...result.fills];
    }
    await connection.execute(`UPDATE ${table('kouza_master')} SET balance=? WHERE account_id=?`, [balance, account.id]);
    await connection.execute(`DELETE FROM ${table('bank_stock_accounts')} WHERE account_id=?`, [account.id]);
    await connection.execute(`INSERT INTO ${table('bank_stock_accounts')} (account_id, state) VALUES (?, ?)`, [account.id, JSON.stringify(state)]);
    let runningBalance = before;
    for (const fill of fills) {
      runningBalance += fill.side === 'buy' ? -fill.amount - fill.fee : fill.amount - fill.fee;
      await record(connection, account.id, fill.side === 'buy' ? '5' : '6', fill.amount, runningBalance,
        `${fill.symbol} ${companyById(fill.symbol).name} ${fill.quantity}株 / ${fill.price}円 / 手数料${fill.fee}円`, new Date(fill.filledAt));
    }
    const [[oldHolding]] = await connection.execute(`SELECT quantity, cost FROM ${table('bank_holdings')} WHERE account_id=?`, [account.id]);
    const [[oldMarket]] = await connection.execute(`SELECT price FROM ${table('bank_market')} WHERE market_id=?`, ['manabi']);
    await connection.commit();
    return { account: { ...account, balance }, market, portfolio: state, order, fills,
      legacy: { quantity: safeBalance(oldHolding?.quantity || 0), cost: safeBalance(oldHolding?.cost || 0), price: safeBalance(oldMarket?.price || 1000) } };
  } catch (error) {
    await connection.rollback();
    if (error instanceof StockError) throw new BankError(error.status, error.message);
    throw error;
  } finally { connection.release(); }
}
export const stockInvestment = account => stockOperation(account);
export const orderStock = (account, input, address) => stockOperation(account, input, address);
export function cancelStockOrder(account, input) {
  if (typeof input.id !== 'string' || !/^[a-f0-9]{20}$/.test(input.id)) reject(400, '注文番号が不正です。');
  return stockOperation(account, null, null, input.id);
}

export async function cardStatements(accountId) {
  const [rows] = await getPool().execute(`SELECT entry_id, card_type, used_on, merchant, amount FROM ${table('bank_card_entries')}
    WHERE account_id=? ORDER BY used_on DESC, entry_id DESC`, [accountId]);
  return rows.map(row => ({ id: row.entry_id, cardType: row.card_type, date: row.used_on instanceof Date ? japanDate(row.used_on) : row.used_on,
    merchant: row.merchant, amount: safeBalance(row.amount), sample: false }));
}

export async function addCardEntry(accountId, input) {
  if (!['virtual-card', 'physical-card'].includes(input.cardType)) reject(400, 'カードの種類が不正です。');
  if (typeof input.merchant !== 'string' || !input.merchant.trim() || input.merchant.trim().length > 100) reject(400, '利用先は100文字以内で入力してください。');
  if (!Number.isSafeInteger(input.amount) || input.amount < 1) reject(400, '利用額は1円以上の整数で入力してください。');
  if (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)
    || !Number.isFinite(Date.parse(input.date)) || new Date(input.date).toISOString().slice(0, 10) !== input.date
    || input.date < '1900-01-01' || input.date > japanDate()) reject(400, '利用日を今日以前の正しい日付で入力してください。');
  const id = String(Date.now()) + randomBytes(4).toString('hex').slice(0, 7);
  await getPool().execute(`INSERT INTO ${table('bank_card_entries')} (entry_id, account_id, card_type, used_on, merchant, amount)
    VALUES (?, ?, ?, ?, ?, ?)`, [id, accountId, input.cardType, input.date, input.merchant.trim(), input.amount]);
  return { entry: { id, cardType: input.cardType, date: input.date, merchant: input.merchant.trim(), amount: input.amount, sample: false } };
}
