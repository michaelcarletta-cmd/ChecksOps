import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { localStateDir } from './paths.mjs';

export const ISSUER_KEY_NAME = 'issuer.key';

export function issuerKeyPath(root) {
  return path.join(localStateDir(root), ISSUER_KEY_NAME);
}

export function loadIssuerKey(root) {
  const file = issuerKeyPath(root);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const key = fs.readFileSync(file);
    return key.length >= 32 ? key : null;
  } catch {
    return null;
  }
}

export function loadOrCreateIssuerKey(root) {
  const existing = loadIssuerKey(root);
  if (existing) return existing;
  const file = issuerKeyPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const key = randomBytes(32);
  try {
    const fd = fs.openSync(file, 'wx');
    try {
      fs.writeSync(fd, key);
    } finally {
      fs.closeSync(fd);
    }
    try { fs.chmodSync(file, 0o600); } catch { /* best-effort */ }
    return key;
  } catch (error) {
    if (error.code === 'EEXIST') {
      const raced = loadIssuerKey(root);
      if (raced) return raced;
    }
    throw error;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalReceiptPayload(receipt) {
  const { mac, ...rest } = receipt || {};
  return canonicalJson(rest);
}

export function signReceipt(root, receipt) {
  const key = loadOrCreateIssuerKey(root);
  const mac = createHmac('sha256', key).update(canonicalReceiptPayload(receipt)).digest('hex');
  return { ...receipt, mac };
}

export function verifyReceiptMac(root, receipt) {
  const key = loadIssuerKey(root);
  if (!key || !receipt?.mac || !/^[0-9a-f]{64}$/.test(String(receipt.mac))) return false;
  const expected = createHmac('sha256', key).update(canonicalReceiptPayload(receipt)).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(receipt.mac), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
