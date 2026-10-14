import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { registerDemoAccount, listDemoAccounts, authenticateDemoAccount, demoStorageKey } from '../assets/demo-accounts.mjs';

const REGISTRY_KEY = 'manabi-demo-accounts-v1';
const input = { name: ' 山田 太郎 ', nameKana: 'やまだ たろう', pin: '0123', pinConfirmation: '0123' };

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: key => { values.delete(key); },
    values
  };
}

const optionsFor = storage => ({ storage, crypto: webcrypto });

test('registration persists a zero-balance account and only salted PIN hashes', async () => {
  const storage = memoryStorage();
  const options = optionsFor(storage);
  const account = await registerDemoAccount(input, { balance: 9999, portfolio: { holdings: [] }, toJSON: () => ({ balance: 9999 }) }, options);
  assert.match(account.id, /^demo-[0-9]{7}$/);
  assert.equal(account.name, '山田 太郎');
  assert.equal(account.nameKana, 'ヤマダ タロウ');
  assert.equal(account.balance, 0);
  assert.deepEqual(Object.keys(account).sort(), ['accountNumber', 'balance', 'bankCode', 'branchCode', 'id', 'name', 'nameKana'].sort());
  assert.equal(JSON.parse(storage.getItem(demoStorageKey(account.id))).balance, 0);
  const record = JSON.parse(storage.getItem(REGISTRY_KEY)).accounts[0];
  assert.match(record.pinSalt, /^[0-9a-f]{32}$/);
  assert.match(record.pinHash, /^[0-9a-f]{64}$/);
  assert.equal('pin' in record, false);
  assert.equal('pinConfirmation' in record, false);
  assert.deepEqual(listDemoAccounts(options), [account]);
  // A fresh options object simulates reloading the page with persistent storage.
  assert.deepEqual(await authenticateDemoAccount(account.id, '0123', optionsFor(storage)), account);
  await assert.rejects(authenticateDemoAccount(account.id, '0124', options), /正しくありません/);
  await assert.rejects(authenticateDemoAccount('demo-9999999', '0123', options), /正しくありません/);
});

test('different accounts retain isolated balances and independently salted credentials', async () => {
  const storage = memoryStorage();
  const options = optionsFor(storage);
  const first = await registerDemoAccount(input, { balance: 0 }, options);
  storage.setItem(demoStorageKey(first.id), JSON.stringify({ balance: 750 }));
  const second = await registerDemoAccount({ ...input, name: '佐藤 花子', nameKana: 'ｻﾄｳ ﾊﾅｺ' }, { balance: 0 }, options);
  assert.notEqual(first.id, second.id);
  assert.notEqual(demoStorageKey(first.id), demoStorageKey(second.id));
  assert.equal(JSON.parse(storage.getItem(demoStorageKey(first.id))).balance, 750);
  assert.equal(JSON.parse(storage.getItem(demoStorageKey(second.id))).balance, 0);
  assert.equal(second.nameKana, 'サトウ ハナコ');
  const records = JSON.parse(storage.getItem(REGISTRY_KEY)).accounts;
  assert.notEqual(records[0].pinSalt, records[1].pinSalt);
  assert.notEqual(records[0].pinHash, records[1].pinHash);
  assert.equal(listDemoAccounts(options).length, 2);
  assert.deepEqual(await authenticateDemoAccount(first.id, '0123', options), first);
});

test('invalid registration input is rejected without writing account data', async () => {
  const storage = memoryStorage();
  const options = optionsFor(storage);
  for (const patch of [
    { name: '' }, { name: 'あ'.repeat(101) }, { name: '😀'.repeat(51) }, { name: '山田\n太郎' },
    { nameKana: '' }, { nameKana: '山田' }, { nameKana: 'ー・' }, { nameKana: 'ア'.repeat(101) },
    { pin: '123' }, { pin: '１２３４' }, { pin: 1234 }, { pinConfirmation: '4321' }
  ]) {
    await assert.rejects(registerDemoAccount({ ...input, ...patch }, { balance: 0 }, options));
    assert.equal(storage.values.size, 0);
  }
  assert.throws(() => demoStorageKey('../other-data'), /口座/);
});

test('account number collisions are retried without overwriting existing state', async () => {
  const storage = memoryStorage();
  const orphanKey = demoStorageKey('demo-1000000');
  storage.setItem(orphanKey, JSON.stringify({ balance: 800 }));
  let sequence = 0;
  const crypto = {
    subtle: webcrypto.subtle,
    getRandomValues: values => {
      if (values instanceof Uint32Array) { values[0] = sequence++; return values; }
      return webcrypto.getRandomValues(values);
    }
  };
  const options = { storage, crypto };
  const first = await registerDemoAccount(input, { balance: 0 }, options);
  assert.equal(first.accountNumber, '1000001');
  sequence = 1;
  const second = await registerDemoAccount(input, { balance: 0 }, options);
  assert.equal(second.accountNumber, '1000002');
  assert.equal(JSON.parse(storage.getItem(orphanKey)).balance, 800);
  assert.equal(listDemoAccounts(options).length, 2);
});

test('concurrent contexts serialize registration and reload the registry inside the shared lock', async () => {
  const storage = memoryStorage();
  const readsInsideLock = [];
  const requests = [];
  let active = false;
  let queue = Promise.resolve();
  const locks = {
    request(name, options, callback) {
      requests.push({ name, mode: options.mode });
      const task = queue.then(async () => {
        assert.equal(active, false);
        active = true;
        try { return await callback(); }
        finally { active = false; }
      });
      queue = task.catch(() => {});
      return task;
    }
  };
  const contextStorage = () => ({
    getItem(key) {
      const raw = storage.getItem(key);
      if (key === REGISTRY_KEY && active) readsInsideLock.push(raw === null ? 0 : JSON.parse(raw).accounts.length);
      return raw;
    },
    setItem(key, value) {
      assert.equal(active, true, 'all registration writes must be inside the exclusive lock');
      storage.setItem(key, value);
    },
    removeItem(key) {
      assert.equal(active, true);
      storage.removeItem(key);
    }
  });
  const [first, second] = await Promise.all([
    registerDemoAccount(input, { balance: 0 }, { storage: contextStorage(), crypto: webcrypto, locks }),
    registerDemoAccount({ ...input, name: '佐藤 花子' }, { balance: 0 }, { storage: contextStorage(), crypto: webcrypto, locks })
  ]);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(requests, [{ name: REGISTRY_KEY, mode: 'exclusive' }, { name: REGISTRY_KEY, mode: 'exclusive' }]);
  assert.deepEqual(readsInsideLock, [0, 1]);
  assert.deepEqual(new Set(listDemoAccounts(optionsFor(storage)).map(account => account.id)), new Set([first.id, second.id]));
  assert.equal(JSON.parse(storage.getItem(demoStorageKey(first.id))).balance, 0);
  assert.equal(JSON.parse(storage.getItem(demoStorageKey(second.id))).balance, 0);
});

test('failed storage writes roll back only the attempted registration', async () => {
  for (const failureStage of ['state', 'registry']) {
    const storage = memoryStorage();
    const options = optionsFor(storage);
    const existing = await registerDemoAccount(input, { balance: 0 }, options);
    storage.setItem(demoStorageKey(existing.id), JSON.stringify({ balance: 600 }));
    storage.setItem('manabi-demo-v2', JSON.stringify({ balance: 900 }));
    const before = new Map(storage.values);
    const setItem = storage.setItem;
    let failed = false;
    storage.setItem = (key, value) => {
      const matches = failureStage === 'registry' ? key === REGISTRY_KEY : key.startsWith('manabi-demo-v2:');
      if (matches && !failed) {
        failed = true;
        // Also exercise rollback when a storage adapter throws after writing.
        setItem(key, value);
        throw new Error('storage is full');
      }
      setItem(key, value);
    };
    await assert.rejects(registerDemoAccount(input, { balance: 0 }, options), /保存できませんでした/);
    assert.deepEqual(storage.values, before);
  }
});

test('malformed stored registry is rejected without deleting existing data', async () => {
  const storage = memoryStorage();
  const options = optionsFor(storage);
  const account = await registerDemoAccount(input, { balance: 0 }, options);
  const valid = JSON.parse(storage.getItem(REGISTRY_KEY));
  const malformed = [
    'not json', JSON.stringify({ version: 2, accounts: [] }),
    JSON.stringify({ version: 1, accounts: [{ ...valid.accounts[0], pinHash: 'bad' }] }),
    JSON.stringify({ version: 1, accounts: [{ ...valid.accounts[0], pinIterations: 1_000_000_000 }] }),
    JSON.stringify({ version: 1, accounts: [{ ...valid.accounts[0], accountNumber: Number(valid.accounts[0].accountNumber) }] }),
    JSON.stringify({ version: 1, accounts: [valid.accounts[0], valid.accounts[0]] })
  ];
  for (const raw of malformed) {
    storage.setItem(REGISTRY_KEY, raw);
    const before = new Map(storage.values);
    assert.throws(() => listDemoAccounts(options), /保存されている口座情報/);
    await assert.rejects(authenticateDemoAccount(account.id, '0123', options), /保存されている口座情報/);
    await assert.rejects(registerDemoAccount(input, { balance: 0 }, options), /保存されている口座情報/);
    assert.deepEqual(storage.values, before);
  }
});
