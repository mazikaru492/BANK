import { databaseConfigured } from '../lib/db.mjs';
import { BankError, login, logout, sessionAccount, history, transact } from '../lib/bank.mjs';

const cookieName = 'bank_session';
function sessionToken(req) {
  return (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
}
function setCookie(req, res, token, maxAge) {
  const secure = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}
async function body(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new BankError(415, 'JSON形式で送信してください。');
  if (req.body && typeof req.body === 'object') return req.body;
  let content = '';
  for await (const chunk of req) {
    content += chunk;
    if (Buffer.byteLength(content) > 16384) throw new BankError(413, 'リクエストが大きすぎます。');
  }
  try {
    const value = JSON.parse(content);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new BankError(400, '送信内容が不正です。'); }
}
function send(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const action = new URL(req.url, 'http://localhost').searchParams.get('action') || 'session';
    if (!['GET', 'POST'].includes(req.method)) throw new BankError(405, 'このメソッドは利用できません。');
    if (!databaseConfigured()) {
      if (req.method === 'GET' && action === 'session') return send(res, 200, { mode: 'demo', account: null });
      throw new BankError(503, 'データベース接続が設定されていません。');
    }
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      const proto = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      if (origin !== `${proto}://${req.headers.host}`) throw new BankError(403, 'この送信元からは操作できません。');
    }
    const token = sessionToken(req);
    const address = req.socket?.remoteAddress || 'unknown';
    if (req.method === 'POST' && action === 'login') {
      const result = await login(await body(req), address);
      setCookie(req, res, result.token, 8 * 60 * 60);
      return send(res, 200, { account: result.account });
    }
    if (req.method === 'POST' && action === 'logout') {
      await logout(token);
      setCookie(req, res, '', 0);
      return send(res, 200, { ok: true });
    }
    const account = await sessionAccount(token);
    if (req.method === 'GET' && action === 'session') return send(res, 200, { mode: 'database', account });
    if (!account) throw new BankError(401, 'ログインが必要です。');
    if (req.method === 'GET' && action === 'history') return send(res, 200, { history: await history(account.id) });
    if (req.method === 'POST' && ['balance', 'deposit', 'withdraw', 'transfer'].includes(action)) {
      return send(res, 200, await transact(account, action, await body(req), address));
    }
    throw new BankError(404, '操作が見つかりません。');
  } catch (error) {
    if (error instanceof BankError) return send(res, error.status, { error: error.message });
    console.error('Bank API error:', error.code || error.name);
    return send(res, 503, { error: 'データベースに接続できません。接続設定とデータベースの状態を確認してください。' });
  }
}
