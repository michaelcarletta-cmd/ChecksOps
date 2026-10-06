import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CODES, errorEntry, failMany, ok } from './errors.mjs';
import { localStateDir } from './paths.mjs';

export const CONSUMED_RECEIPTS_DIRNAME = 'consumed-receipts';

export function consumedReceiptsDir(root) {
  return path.join(localStateDir(root), CONSUMED_RECEIPTS_DIRNAME);
}

function receiptConsumptionToken(receipt) {
  const mac = String(receipt?.mac || '').trim();
  if (/^[0-9a-f]{64}$/.test(mac)) return mac;
  const signature = String(receipt?.kms_signature || '').trim();
  const keyArn = String(receipt?.kms_key_arn || '').trim();
  if (!signature || !keyArn) return null;
  return createHash('sha256').update(`${keyArn}\n${signature}`, 'utf8').digest('hex');
}

export function consumedReceiptFile(root, receipt) {
  const token = receiptConsumptionToken(receipt);
  if (!token) return null;
  return path.join(consumedReceiptsDir(root), `${token}.json`);
}

export function consumeReceiptOnce(root, receipt, {
  now = Date.now(),
  actor = null,
  script = null,
} = {}) {
  const file = consumedReceiptFile(root, receipt);
  if (!file) {
    return failMany([errorEntry(
      CODES.INVALID_MANIFEST,
      'receipt is missing a valid mac or KMS signature; cannot enforce single-use consumption',
    )], CODES.INVALID_MANIFEST);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    consumed_at: new Date(now).toISOString(),
    actor: actor || null,
    script: script || null,
    receipt_identity: {
      mac: receipt.mac,
      workstream_id: receipt.workstream_id,
      commit: receipt.commit,
      target_environment: receipt.target_environment,
      target_component: receipt.target_component,
      deployment_type: receipt.deployment_type,
      expiry: receipt.expiry,
    },
  };
  try {
    const fd = fs.openSync(file, 'wx');
    try {
      fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    return ok({ consumed: true, file });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      return failMany([errorEntry(
        CODES.RECEIPT_REUSED,
        'deployment guard receipt has already been consumed; issue a fresh receipt before retrying',
        { file },
      )], CODES.RECEIPT_REUSED);
    }
    throw error;
  }
}

