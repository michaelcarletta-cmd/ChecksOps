import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { CODES, errorEntry, failMany, ok } from './errors.mjs';

export const DEFAULT_CONSUMED_PREFIX = 'assets/__deployment_guard__/consumed-receipts';

function safeKeyPart(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9._:-]/g, '_');
}

export function consumedReceiptObjectKey({
  target_id,
  receipt_mac,
  prefix = DEFAULT_CONSUMED_PREFIX,
} = {}) {
  const mac = String(receipt_mac || '').trim();
  const target = safeKeyPart(target_id || 'unknown-target');
  const base = String(prefix || DEFAULT_CONSUMED_PREFIX).replace(/\/+$/, '');
  return `${base}/${target}/${mac}.json`;
}

function sha256Json(value) {
  const text = JSON.stringify(value ?? null);
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isPreconditionFailed(error) {
  const status = error?.$metadata?.httpStatusCode;
  return status === 412 || error?.name === 'PreconditionFailed' || error?.Code === 'PreconditionFailed';
}

export function createS3ConsumedReceiptRegistry({
  bucket,
  region,
  prefix = DEFAULT_CONSUMED_PREFIX,
  client = null,
} = {}) {
  const s3 = client || new S3Client({ region });
  const bucketName = String(bucket || '').trim();
  if (!bucketName) throw new Error('createS3ConsumedReceiptRegistry requires bucket');
  return {
    kind: 's3-consumed-receipts',
    bucket: bucketName,
    prefix,
    async consumeOnce({
      receipt,
      target,
      now = Date.now(),
      actor = null,
      script = null,
    } = {}) {
      const mac = String(receipt?.mac || '').trim();
      if (!/^[0-9a-f]{64}$/.test(mac)) {
        return failMany([errorEntry(
          CODES.INVALID_MANIFEST,
          'receipt is missing a valid mac; cannot enforce single-use consumption',
        )], CODES.INVALID_MANIFEST);
      }
      const key = consumedReceiptObjectKey({
        target_id: target?.id,
        receipt_mac: mac,
        prefix,
      });
      const payload = {
        schema_version: 1,
        kind: 'deployment-guard-consumed-receipt',
        consumed_at: new Date(now).toISOString(),
        actor: actor || null,
        script: script || null,
        target: target?.id || null,
        receipt: {
          mac,
          workstream_id: receipt.workstream_id,
          commit: receipt.commit,
          target_environment: receipt.target_environment,
          target_component: receipt.target_component,
          deployment_type: receipt.deployment_type,
          expiry: receipt.expiry,
        },
      };
      try {
        const res = await s3.send(new PutObjectCommand({
          Bucket: bucketName,
          Key: key,
          Body: JSON.stringify(payload),
          ContentType: 'application/json; charset=utf-8',
          CacheControl: 'private,no-store',
          // Atomic create: if the object already exists, only one caller wins.
          IfNoneMatch: '*',
        }));
        return ok({
          consumed: true,
          bucket: bucketName,
          key,
          etag: (res?.ETag || '').replaceAll('"', '') || null,
          s3_version_id: res?.VersionId || null,
          payload_sha256: sha256Json(payload),
        });
      } catch (error) {
        if (isPreconditionFailed(error)) {
          return failMany([errorEntry(
            CODES.RECEIPT_REUSED,
            'deployment guard receipt has already been consumed; issue a fresh receipt before retrying',
            { bucket: bucketName, key },
          )], CODES.RECEIPT_REUSED);
        }
        return failMany([errorEntry(
          CODES.DEPLOYMENT_COLLISION,
          'failed to record shared receipt consumption; refusing production mutation',
          {
            bucket: bucketName,
            key,
            error: error?.name || error?.code || error?.message || String(error),
          },
        )], CODES.DEPLOYMENT_COLLISION);
      }
    },
  };
}

