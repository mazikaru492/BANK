const REGISTRY_KEY = 'manabi-demo-accounts-v1';
const PIN_ITERATIONS = 100_000;
const REGISTRY_LIMIT = 2_000_000;

const fail = (message) => { throw new Error(message); };
const invalidRegistry = () => fail('保存されている口座情報を読み込めません。データを削除せず、管理者に確認してください。');

function storageFor(options) {
  const storage = options.storage ?? globalThis.localStorage;
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') {
    fail('このブラウザでは口座情報を保存できません。');
  }
  return storage;
}

function cryptoFor(options) {
  const crypto = options.crypto ?? globalThis.crypto;
  if (!crypto?.subtle || typeof crypto.getRandomValues !== 'function') {
    fail('この環境では暗証番号を安全に保存できません。HTTPS または localhost で開いてください。');
  }
  return crypto;
}

function readItem(storage, key) {
  try { return storage.getItem(key); }
  catch { fail('口座情報を読み込めません。ブラウザの保存設定を確認してください。'); }
}

function normalizeName(value) {
  if (typeof value !== 'string') fail('名前を入力してください。');
  const name = value.trim();
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/u.test(name)) {
    fail('名前は 1〜100 文字で入力してください。');
  }
  return name;
}

function normalizeKana(value) {
  if (typeof value !== 'string') fail('名前のフリガナを入力してください。');
  const kana = value.normalize('NFKC').replace(/[\u3041-\u3096]/gu, character => String.fromCharCode(character.charCodeAt(0) + 0x60)).trim();
  if (!kana || kana.length > 100 || !/^[\u30a1-\u30fa\u30fd-\u30feー・ ]+$/u.test(kana) || !/[\u30a1-\u30fa]/u.test(kana)) {
    fail('フリガナはカタカナで 1〜100 文字入力してください。');
  }
  return kana;
}

function validatePin(pin) {
  if (typeof pin !== 'string' || !/^[0-9]{4}$/.test(pin)) fail('暗証番号は数字 4 桁で入力してください。');
}

const toHex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const fromHex = value => Uint8Array.from(value.match(/../g), byte => parseInt(byte, 16));

async function hashPin(pin, salt, crypto) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PIN_ITERATIONS }, key, 256);
  return new Uint8Array(bits);
}

function readRegistry(storage) {
  const raw = readItem(storage, REGISTRY_KEY);
  if (raw === null) return { raw, accounts: [] };
  if (typeof raw !== 'string' || raw.length > REGISTRY_LIMIT) invalidRegistry();
  let value;
  try { value = JSON.parse(raw); } catch { invalidRegistry(); }
  if (!value || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.accounts) || value.accounts.length > 10_000 || Object.keys(value).some(key => !['version', 'accounts'].includes(key))) invalidRegistry();
  const ids = new Set();
  const numbers = new Set();
  const fields = ['id', 'bankCode', 'branchCode', 'accountNumber', 'name', 'nameKana', 'balance', 'pinSalt', 'pinHash', 'pinIterations'];
  for (const account of value.accounts) {
    if (!account || Array.isArray(account) || Object.keys(account).some(key => !fields.includes(key)) ||
      typeof account.accountNumber !== 'string' || !/^[0-9]{7}$/.test(account.accountNumber) || account.id !== `demo-${account.accountNumber}` ||
      account.bankCode !== '0000' || account.branchCode !== '001' || account.balance !== 0 ||
      typeof account.name !== 'string' || typeof account.nameKana !== 'string' ||
      typeof account.pinSalt !== 'string' || !/^[0-9a-f]{32}$/.test(account.pinSalt) ||
      typeof account.pinHash !== 'string' || !/^[0-9a-f]{64}$/.test(account.pinHash) ||
      account.pinIterations !== PIN_ITERATIONS || ids.has(account.id) || numbers.has(account.accountNumber)) invalidRegistry();
    try {
      if (normalizeName(account.name) !== account.name || normalizeKana(account.nameKana) !== account.nameKana) invalidRegistry();
    } catch { invalidRegistry(); }
    ids.add(account.id);
    numbers.add(account.accountNumber);
  }
  return { raw, accounts: value.accounts };
}

function publicAccount(account) {
  const { id, bankCode, branchCode, accountNumber, name, nameKana, balance } = account;
  return { id, bankCode, branchCode, accountNumber, name, nameKana, balance };
}

export function demoStorageKey(accountId) {
  if (typeof accountId !== 'string' || !/^demo-[0-9]{7}$/.test(accountId)) fail('口座を選択してください。');
  return `manabi-demo-v2:${accountId}`;
}

export function listDemoAccounts(options = {}) {
  return readRegistry(storageFor(options)).accounts.map(publicAccount);
}

export async function registerDemoAccount(input, initialState, options = {}) {
  const storage = storageFor(options);
  const crypto = cryptoFor(options);
  if (!input || typeof input !== 'object') fail('登録情報を入力してください。');
  const name = normalizeName(input.name);
  const nameKana = normalizeKana(input.nameKana);
  validatePin(input.pin);
  if (input.pin !== input.pinConfirmation) fail('確認用の暗証番号が一致しません。');
  if (!initialState || typeof initialState !== 'object' || Array.isArray(initialState)) fail('口座の初期データを用意できません。');
  let state;
  try {
    const initial = { ...initialState, balance: 0 };
    delete initial.toJSON;
    state = JSON.stringify(initial);
  }
  catch { fail('口座の初期データを保存できません。'); }
  // Check for unreadable user data before performing the slower PIN derivation.
  readRegistry(storage);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPin(input.pin, salt, crypto);
  const createAccount = () => {
    // Reload inside the lock: another tab may have registered during PIN derivation.
    const registry = readRegistry(storage);
    let account;
    for (let attempt = 0; attempt < 32; attempt++) {
      const random = crypto.getRandomValues(new Uint32Array(1))[0];
      const accountNumber = String(1_000_000 + random % 9_000_000);
      const id = `demo-${accountNumber}`;
      if (!registry.accounts.some(item => item.accountNumber === accountNumber) && readItem(storage, demoStorageKey(id)) === null) {
        account = { id, bankCode: '0000', branchCode: '001', accountNumber, name, nameKana, balance: 0, pinSalt: toHex(salt), pinHash: toHex(hash), pinIterations: PIN_ITERATIONS };
        break;
      }
    }
    if (!account) fail('新しい口座番号を発行できませんでした。もう一度お試しください。');
    const key = demoStorageKey(account.id);
    const nextRegistry = JSON.stringify({ version: 1, accounts: [...registry.accounts, account] });
    if (nextRegistry.length > REGISTRY_LIMIT) fail('保存できる口座数の上限に達しました。');
    let registryWriteStarted = false;
    try {
      storage.setItem(key, state);
      registryWriteStarted = true;
      storage.setItem(REGISTRY_KEY, nextRegistry);
    } catch {
      try { storage.removeItem(key); } catch { /* Best effort: never clear unrelated user data. */ }
      if (registryWriteStarted) {
        try {
          if (registry.raw === null) storage.removeItem(REGISTRY_KEY);
          else storage.setItem(REGISTRY_KEY, registry.raw);
        } catch { /* Existing account state is not altered. */ }
      }
      fail('口座情報を保存できませんでした。ブラウザの保存容量や設定を確認してください。');
    }
    return publicAccount(account);
  };
  const locks = options.locks ?? globalThis.navigator?.locks;
  if (typeof locks?.request === 'function') return locks.request(REGISTRY_KEY, { mode: 'exclusive' }, async () => createAccount());
  // Browsers without Web Locks retain synchronous writes, without cross-tab exclusion.
  return createAccount();
}

export async function authenticateDemoAccount(accountId, pin, options = {}) {
  validatePin(pin);
  const registry = readRegistry(storageFor(options));
  const account = registry.accounts.find(item => item.id === accountId);
  if (!account) fail('口座または暗証番号が正しくありません。');
  const hash = await hashPin(pin, fromHex(account.pinSalt), cryptoFor(options));
  const expected = fromHex(account.pinHash);
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected[index] ^ hash[index];
  if (difference !== 0) fail('口座または暗証番号が正しくありません。');
  return publicAccount(account);
}
