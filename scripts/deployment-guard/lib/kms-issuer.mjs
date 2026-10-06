import { execFileSync } from 'node:child_process';
import { canonicalReceiptPayload } from './issuer.mjs';
import { CODES, GuardError } from './errors.mjs';

const KMS_ALGORITHM = 'ECDSA_SHA_256';

export function validateKmsSignerConfig(env = process.env) {
  const keyArn = String(env.CHECKSOPS_DEPLOYMENT_GUARD_KMS_KEY_ARN || '').trim();
  if (!/^arn:aws:kms:us-east-1:[0-9]{12}:key\/[0-9a-f-]+$/i.test(keyArn)) {
    throw new GuardError(CODES.RECEIPT_FORGED, 'staging KMS deployment-guard key ARN is missing or invalid');
  }
  return { keyArn };
}

export function signReceiptWithKms(receipt, {
  env = process.env,
  execFile = execFileSync,
} = {}) {
  const { keyArn } = validateKmsSignerConfig(env);
  const payload = canonicalReceiptPayload({ ...receipt, kms_key_arn: keyArn });
  const encoded = Buffer.from(payload).toString('base64');
  let raw;
  try {
    raw = execFile('aws', [
      'kms', 'sign',
      '--region', 'us-east-1',
      '--key-id', keyArn,
      '--message-type', 'RAW',
      '--signing-algorithm', KMS_ALGORITHM,
      '--message', encoded,
      '--cli-binary-format', 'base64',
      '--output', 'json',
    ], { encoding: 'utf8', env });
  } catch (error) {
    throw new GuardError(CODES.RECEIPT_FORGED, 'KMS receipt signing failed closed', {
      error: error?.name || error?.message || String(error),
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new GuardError(CODES.RECEIPT_FORGED, 'KMS receipt signing returned invalid JSON');
  }
  if (!parsed?.Signature || parsed?.KeyId !== keyArn || parsed?.SigningAlgorithm !== KMS_ALGORITHM) {
    throw new GuardError(CODES.RECEIPT_FORGED, 'KMS receipt signing response did not match the authorized key/algorithm');
  }
  return {
    ...receipt,
    kms_key_arn: keyArn,
    kms_signature: parsed.Signature,
  };
}
