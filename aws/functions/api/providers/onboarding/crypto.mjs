/**
 * Field encryption for onboarding PII that ChecksOps keeps (EIN, representative
 * date of birth). KMS Encrypt/Decrypt with a dedicated key whose ARN comes from
 * server config (MOOV_ONBOARDING_PII_KMS_KEY_ARN), bound to the tenant and field
 * through the KMS encryption context. Without a key ARN nothing is stored:
 * callers fail closed instead of writing plaintext.
 *
 * The SSN is never passed here: ChecksOps keeps only its last four digits.
 */

export const PII_KMS_KEY_ENV = 'MOOV_ONBOARDING_PII_KMS_KEY_ARN';
const CIPHER_PREFIX = 'kms:v1:';

export class OnboardingError extends Error {
  constructor(code, statusCode = 400, extra = {}) {
    super(code);
    this.name = 'OnboardingError';
    this.code = code;
    this.statusCode = statusCode;
    this.extra = extra;
  }
}

export const piiKeyArn = () => String(process.env[PII_KMS_KEY_ENV] || '').trim();

let cachedKms = null;
const defaultKms = async () => {
  if (cachedKms) return cachedKms;
  const { KMSClient, EncryptCommand, DecryptCommand } = await import('@aws-sdk/client-kms');
  const client = new KMSClient({ region: process.env.AWS_REGION || 'us-east-1' });
  cachedKms = {
    encrypt: (input) => client.send(new EncryptCommand(input)),
    decrypt: (input) => client.send(new DecryptCommand(input)),
  };
  return cachedKms;
};

const kmsOf = async (deps = {}) => deps.kms || defaultKms();

const contextFor = (tenantId, field, environment) => {
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new OnboardingError('pii_environment_unresolved', 500);
  }
  return {
    app: 'checksops-moov-onboarding',
    environment,
    tenant_id: String(tenantId),
    field: String(field),
  };
};

export async function encryptPii(deps, { tenantId, field, environment, plaintext }) {
  const keyArn = piiKeyArn();
  if (!keyArn) throw new OnboardingError('pii_encryption_unavailable', 503);
  const kms = await kmsOf(deps);
  let out;
  try {
    out = await kms.encrypt({
      KeyId: keyArn,
      Plaintext: Buffer.from(String(plaintext), 'utf8'),
      EncryptionContext: contextFor(tenantId, field, environment),
    });
  } catch {
    throw new OnboardingError('pii_encryption_failed', 503);
  }
  const blob = out?.CiphertextBlob;
  if (!blob || !blob.length) throw new OnboardingError('pii_encryption_failed', 503);
  return { ciphertext: `${CIPHER_PREFIX}${Buffer.from(blob).toString('base64')}`, keyArn: out?.KeyId || keyArn };
}

export async function decryptPii(deps, { tenantId, field, environment, ciphertext }) {
  if (!ciphertext) return null;
  const raw = String(ciphertext);
  if (!raw.startsWith(CIPHER_PREFIX)) throw new OnboardingError('pii_ciphertext_invalid', 500);
  const kms = await kmsOf(deps);
  let out;
  try {
    out = await kms.decrypt({
      CiphertextBlob: Buffer.from(raw.slice(CIPHER_PREFIX.length), 'base64'),
      EncryptionContext: contextFor(tenantId, field, environment),
      ...(piiKeyArn() ? { KeyId: piiKeyArn() } : {}),
    });
  } catch {
    throw new OnboardingError('pii_decryption_failed', 503);
  }
  if (!out?.Plaintext) throw new OnboardingError('pii_decryption_failed', 503);
  return Buffer.from(out.Plaintext).toString('utf8');
}
