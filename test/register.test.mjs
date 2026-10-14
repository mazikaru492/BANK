import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPinHash, verifyPinHash } from '../lib/credentials.mjs';
import { clientAddress } from '../api/bank.mjs';

test('registered PINs use salted hashes, preserve leading zeros and reject incorrect PINs', async () => {
  const first = await createPinHash('0082');
  const second = await createPinHash('0082');
  assert.notEqual(first, second);
  assert.match(first, /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.equal(await verifyPinHash('0082', first), true);
  assert.equal(await verifyPinHash('0000', first), false);
  assert.equal(await verifyPinHash('82', first), false);
  await assert.rejects(verifyPinHash('0082', 'corrupted credentials'));
});

test('rate limits use Vercel client IPs only on Vercel and ignore spoofed local forwarding headers', () => {
  const original = process.env.VERCEL;
  const request = { headers: { 'x-vercel-forwarded-for': '203.0.113.1', 'x-forwarded-for': '198.51.100.1' }, socket: { remoteAddress: '127.0.0.1' } };
  try {
    delete process.env.VERCEL;
    assert.equal(clientAddress(request), '127.0.0.1');
    process.env.VERCEL = '0';
    assert.equal(clientAddress(request), '127.0.0.1');
    process.env.VERCEL = '1';
    assert.equal(clientAddress(request), '203.0.113.1');
    assert.equal(clientAddress({ ...request, headers: { 'x-vercel-forwarded-for': '203.0.113.2' } }), '203.0.113.2');
    assert.equal(clientAddress({ ...request, headers: { 'x-vercel-forwarded-for': '2001:db8::1' } }), '2001:db8::1');
    for (const value of ['', 'fake-ip', '203.0.113.1, 198.51.100.1', ['203.0.113.1']]) {
      assert.equal(clientAddress({ ...request, headers: { 'x-vercel-forwarded-for': value } }), '127.0.0.1');
    }
    assert.equal(clientAddress({ ...request, headers: { 'x-forwarded-for': '198.51.100.1' } }), '127.0.0.1');
    assert.equal(clientAddress({ headers: {} }), 'unknown');
  } finally {
    if (original === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = original;
  }
});
