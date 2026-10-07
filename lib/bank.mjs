import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { getPool, table } from './db.mjs';

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
    checkPin(input.pin, rows[0].pin);
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
  const names = { '0': '初期残高', '1': '入金', '2': '出金', '3': '振込', '4': '振込入金' };
  return rows.map(row => ({ id: row.deal_id, date: row.deal_date instanceof Date ? japanDate(row.deal_date) : row.deal_date, kind: names[row.deal_code] || row.deal_code,
    amount: Number(row.price), balance: Number(row.inbank_price), comment: row.comment || '' }));
}

const normalizedName = name => name.normalize('NFKC').replace(/\s/g, '');
function japanDate(date) {
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
      try { checkPin(input.pin, source.pin); }
      catch (error) { failedAttempt(clientAddress); throw error; }
    }
    const before = safeBalance(source.balance);
    const date = new Date();
    if (kind === 'balance') {
      await connection.commit();
      return { account: { ...account, balance: before }, receipt: { kind: '残高照会', amount: before, before, date: date.toISOString() } };
    }
    if (kind !== 'deposit' && amount > before) reject(409, '残高が不足しています。');
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
