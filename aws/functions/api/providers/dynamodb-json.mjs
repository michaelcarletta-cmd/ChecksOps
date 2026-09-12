/**
 * Minimal DynamoDB JSON client (SigV4). No AWS SDK dependency.
 * Used only for durable recipient bank-verify claim + MV limiter state.
 */
import { createHash, createHmac } from 'node:crypto';

const hmac = (key, value) => createHmac('sha256', key).update(value, 'utf8').digest();
const sha256Hex = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const amzDate = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

const signingKey = ({ secret, dateStamp, region, service }) => {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
};

export const dynamoCredentialsFromEnv = (env = process.env) => {
  const accessKeyId = String(env.AWS_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(env.AWS_SECRET_ACCESS_KEY || '').trim();
  const sessionToken = String(env.AWS_SESSION_TOKEN || '').trim() || null;
  const region = String(env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1').trim();
  if (!accessKeyId || !secretAccessKey) return null;
  return { accessKeyId, secretAccessKey, sessionToken, region };
};

export async function dynamoJsonRequest({
  target,
  body,
  credentials = dynamoCredentialsFromEnv(),
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  if (!credentials) {
    const error = new Error('dynamodb_credentials_missing');
    error.code = 'dynamodb_credentials_missing';
    throw error;
  }
  const region = credentials.region || 'us-east-1';
  const host = `dynamodb.${region}.amazonaws.com`;
  const payload = JSON.stringify(body ?? {});
  const date = amzDate(now);
  const dateStamp = date.slice(0, 8);
  const payloadHash = sha256Hex(payload);
  const canonicalHeaders = [
    `content-type:application/x-amz-json-1.0`,
    `host:${host}`,
    `x-amz-date:${date}`,
    `x-amz-target:${target}`,
    credentials.sessionToken ? `x-amz-security-token:${credentials.sessionToken}` : null,
  ].filter(Boolean).join('\n') + '\n';
  const signedHeaders = [
    'content-type',
    'host',
    'x-amz-date',
    'x-amz-target',
    credentials.sessionToken ? 'x-amz-security-token' : null,
  ].filter(Boolean).join(';');
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/${region}/dynamodb/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    date,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const signature = createHmac('sha256', signingKey({
    secret: credentials.secretAccessKey,
    dateStamp,
    region,
    service: 'dynamodb',
  })).update(stringToSign, 'utf8').digest('hex');
  const headers = {
    'content-type': 'application/x-amz-json-1.0',
    'x-amz-date': date,
    'x-amz-target': target,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;
  const response = await fetchImpl(`https://${host}/`, {
    method: 'POST',
    headers,
    body: payload,
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { message: text }; }
  if (!response.ok) {
    const type = String(json?.__type || json?.code || '');
    const error = new Error(json?.message || type || `dynamodb_${response.status}`);
    error.status = response.status;
    error.code = type.includes('ConditionalCheckFailedException')
      ? 'ConditionalCheckFailedException'
      : (type.split('#').pop() || 'dynamodb_error');
    error.body = json;
    throw error;
  }
  return json || {};
}

export const dynamoS = (value) => ({ S: String(value) });
export const dynamoN = (value) => ({ N: String(value) });

export const fromDynamo = (item = {}) => {
  const out = {};
  for (const [key, attr] of Object.entries(item || {})) {
    if (attr?.S !== undefined) out[key] = attr.S;
    else if (attr?.N !== undefined) out[key] = Number(attr.N);
    else if (attr?.BOOL !== undefined) out[key] = attr.BOOL;
    else if (attr?.NULL) out[key] = null;
  }
  return out;
};
