import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '@/env';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface EncryptedBlob {
  iv: string;   // base64
  ct: string;   // base64 — ciphertext
  tag: string;  // base64 — GCM auth tag
}

function getKey(): Buffer {
  const k = env.SETTINGS_ENC_KEY;
  if (!k) throw new Error('SETTINGS_ENC_KEY is not set (fail-closed)');
  const buf = Buffer.from(k, 'base64');
  if (buf.length !== KEY_BYTES) {
    throw new Error(`SETTINGS_ENC_KEY must decode to ${KEY_BYTES} bytes (got ${buf.length})`);
  }
  return buf;
}

export function encrypt(plaintext: string): EncryptedBlob {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: tag.toString('base64'),
  };
}

export function decrypt(blob: EncryptedBlob): string {
  const key = getKey();
  const iv = Buffer.from(blob.iv, 'base64');
  const ct = Buffer.from(blob.ct, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
