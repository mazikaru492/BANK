import { test } from 'node:test';
import assert from 'node:assert/strict';
import { japanDate, saveWithdrawalLimit, tradeInvestment, addCardEntry } from '../lib/bank.mjs';

test('daily allowance uses the Japanese midnight boundary', () => {
  assert.equal(japanDate(new Date('2026-10-14T14:59:59Z')), '2026-10-14');
  assert.equal(japanDate(new Date('2026-10-14T15:00:00Z')), '2026-10-15');
});

test('invalid feature requests are rejected before any database operation', async () => {
  const account = { id: 'test' };
  for (const limit of [undefined, -1, 0.5, '100', Infinity]) {
    await assert.rejects(saveWithdrawalLimit(account, { limit }, 'test'), { status: 400 });
  }
  for (const quantity of [0, -1, 0.5, '1', Infinity]) {
    await assert.rejects(tradeInvestment(account, 'invest-buy', { quantity, price: 1000 }, 'test'), { status: 400 });
  }
  const entry = { cardType: 'virtual-card', date: '2026-01-01', merchant: 'test', amount: 10 };
  for (const patch of [{ date: '2026-02-30' }, { date: '2026-13-01' }, { date: '9999-01-01' }, { amount: 0 }, { merchant: ' ' }, { cardType: 'invalid' }]) {
    await assert.rejects(addCardEntry('test', { ...entry, ...patch }), { status: 400 });
  }
});
