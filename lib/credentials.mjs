import { randomBytes, scrypt as nativeScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(nativeScrypt);

export async function createPinHash(pin) {
  const salt = randomBytes(16).toString('hex');
  const digest = await scrypt(pin, salt, 32);
  return `scrypt$${salt}$${digest.toString('hex')}`;
}

export async function verifyPinHash(pin, value) {
  if (typeof value !== 'string' || !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(value)) throw new Error('Invalid registered account credentials');
  const [, salt, digest] = value.split('$');
  const supplied = await scrypt(pin, salt, 32);
  return timingSafeEqual(Buffer.from(digest, 'hex'), supplied);
}
