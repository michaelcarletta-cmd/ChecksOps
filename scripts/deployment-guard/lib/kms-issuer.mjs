import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  // KMS signs at most 4096 bytes of RAW message, and a receipt that carries live key policies is
  // larger. Send the SHA-256 digest of the same canonical payload instead: with ECDSA_SHA_256 the
  // signature over the digest is the signature over the payload, so verifyReceiptKmsSignature is
  // unchanged.
  const encoded = createHash('sha256').update(Buffer.from(payload)).digest('base64');
  let raw;
  try {
    raw = execFile('aws', [
      'kms', 'sign',
      '--region', 'us-east-1',
      '--key-id', keyArn,
      '--message-type', 'DIGEST',
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
