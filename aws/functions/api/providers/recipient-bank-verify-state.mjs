/**
 * Durable recipient bank-verify initiation claim + MV attempt limiter.
 * Production uses DynamoDB CAS. Tests inject a Map-backed store with the same
 * compare-and-swap semantics. Never stores MV codes or raw pay-setup tokens.
 */
import { createHash, randomUUID } from 'node:crypto';
import { RECIPIENT_VERIFY_MAX_ATTEMPTS } from './moov-recipient-tos-policy.mjs';
import {
  dynamoJsonRequest,
  dynamoN,
  dynamoS,
  fromDynamo,
} from './dynamodb-json.mjs';

export const BANK_VERIFY_STATES = Object.freeze({
  NOT_STARTED: 'not_started',
  INITIATION_CLAIMED: 'initiation_claimed',
  VERIFICATION_PENDING: 'verification_pending',
  VERIFIED: 'verified',
  UNCERTAIN: 'uncertain',
});

export const MV_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
export const BANK_VERIFY_CLAIM_TTL_SECONDS = 90 * 24 * 60 * 60;
export const BANK_VERIFY_MV_TTL_SECONDS = Math.floor(MV_ATTEMPT_WINDOW_MS / 1000) + 3600;
export const BANK_VERIFY_STATE_TABLE_ENV = 'AWS_RECIPIENT_BANK_VERIFY_STATE_TABLE';

const AUDIT_DROP_KEYS = /account_number|routing_number|secret|password|token|authorization|ssn|code|mv_|secure_token|iban/i;

export const ttlEpochSeconds = (nowMs, ttlSeconds) => (
  Math.floor(Number(nowMs) / 1000) + Number(ttlSeconds)
);

export const isBankVerifyClaimExpired = (item, nowMs = Date.now()) => {
  const ttl = Number(item?.ttl);
  if (!Number.isFinite(ttl) || ttl <= 0) return false;
  return ttl <= Math.floor(Number(nowMs) / 1000);
};

export const tenantScopeMismatch = (item, tenantId) => {
  const stored = String(item?.tenant_id || '').trim();
  const incoming = String(tenantId || '').trim();
  return Boolean(stored && incoming && stored !== incoming);
};

export const redactBankVerifyAudit = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.length > 240 ? `${value.slice(0, 240)}…` : value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactBankVerifyAudit(item));
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    out[key] = AUDIT_DROP_KEYS.test(key) ? '[redacted]' : redactBankVerifyAudit(nested);
  }
  return out;
};

const ALLOWED_TRANSITIONS = Object.freeze({
  [BANK_VERIFY_STATES.NOT_STARTED]: [
    BANK_VERIFY_STATES.INITIATION_CLAIMED,
    BANK_VERIFY_STATES.VERIFICATION_PENDING,
    BANK_VERIFY_STATES.VERIFIED,
    BANK_VERIFY_STATES.UNCERTAIN,
  ],
  [BANK_VERIFY_STATES.INITIATION_CLAIMED]: [
    BANK_VERIFY_STATES.VERIFICATION_PENDING,
    BANK_VERIFY_STATES.UNCERTAIN,
    BANK_VERIFY_STATES.VERIFIED,
  ],
  [BANK_VERIFY_STATES.VERIFICATION_PENDING]: [
    BANK_VERIFY_STATES.VERIFICATION_PENDING,
    BANK_VERIFY_STATES.UNCERTAIN,
    BANK_VERIFY_STATES.VERIFIED,
  ],
  [BANK_VERIFY_STATES.UNCERTAIN]: [
    BANK_VERIFY_STATES.VERIFICATION_PENDING,
    BANK_VERIFY_STATES.UNCERTAIN,
    BANK_VERIFY_STATES.VERIFIED,
  ],
  [BANK_VERIFY_STATES.VERIFIED]: [
    BANK_VERIFY_STATES.VERIFIED,
  ],
});

export const canTransitionBankVerifyState = (from, to) => {
  const current = from || BANK_VERIFY_STATES.NOT_STARTED;
  const next = to || BANK_VERIFY_STATES.NOT_STARTED;
  return (ALLOWED_TRANSITIONS[current] || []).includes(next);
};

export const tokenFingerprint = (token) => {
  const raw = String(token || '').trim();
  if (!raw) return 'missing';
  return createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
};

export const claimPartitionKey = ({ recipientId, accountId, bankId } = {}) => (
  `CLAIM#${String(recipientId || '').trim()}#${String(accountId || '').trim()}#${String(bankId || '').trim()}`
);

export const mvPartitionKey = ({ recipientId, accountId, bankId, tokenFp } = {}) => (
  `MV#${String(recipientId || '').trim()}#${String(accountId || '').trim()}#${String(bankId || '').trim()}#${String(tokenFp || '').trim()}#confirm`
);

export const mvWindowSortKey = (nowMs, windowMs = MV_ATTEMPT_WINDOW_MS) => (
  `W#${Math.floor(Number(nowMs) / windowMs) * windowMs}`
);

const emptyClaim = (ids = {}) => ({
  pk: claimPartitionKey(ids),
  sk: 'STATE',
  state: BANK_VERIFY_STATES.NOT_STARTED,
  claimant_id: null,
  idempotency_key: null,
  token_fp: null,
  tenant_id: ids.tenantId || null,
  recipient_id: ids.recipientId || null,
  account_id: ids.accountId || null,
  bank_id: ids.bankId || null,
  ttl: null,
});

const unavailable = (operation) => {
  const error = new Error('bank_verify_state_unavailable');
  error.code = 'bank_verify_state_unavailable';
  error.operation = operation;
  return error;
};

const asClaim = (item, ids, nowMs = Date.now()) => {
  if (!item) return emptyClaim(ids);
  if (item.state !== BANK_VERIFY_STATES.VERIFIED && isBankVerifyClaimExpired(item, nowMs)) {
    return emptyClaim(ids);
  }
  return {
    pk: item.pk || claimPartitionKey(ids),
    sk: item.sk || 'STATE',
    state: item.state || BANK_VERIFY_STATES.NOT_STARTED,
    claimant_id: item.claimant_id || null,
    claimed_at: item.claimed_at || null,
    idempotency_key: item.idempotency_key || null,
    token_fp: item.token_fp || null,
    updated_at: item.updated_at || null,
    verified_at: item.verified_at || null,
    tenant_id: item.tenant_id || ids.tenantId || null,
    recipient_id: item.recipient_id || ids.recipientId || null,
    account_id: item.account_id || ids.accountId || null,
    bank_id: item.bank_id || ids.bankId || null,
    ttl: item.ttl ?? null,
  };
};

export function createMemoryBankVerifyStore(backing = new Map()) {
  const map = backing;

  const getClaim = async (ids) => asClaim(map.get(claimPartitionKey(ids)), ids, ids.nowMs);

  const claimInitiation = async ({
    recipientId,
    accountId,
    bankId,
    tenantId,
    claimantId = randomUUID(),
    idempotencyKey,
    tokenFp,
    nowMs = Date.now(),
  } = {}) => {
    const ids = { recipientId, accountId, bankId, tenantId, nowMs };
    const key = claimPartitionKey(ids);
    const raw = map.get(key);
    if (raw && tenantScopeMismatch(raw, tenantId)) {
      return { ok: false, claimed: false, error: 'tenant_scope_mismatch', reason: 'tenant_scope_mismatch', item: asClaim(raw, ids, nowMs) };
    }
    const existing = asClaim(raw, ids, nowMs);
    if (existing.state === BANK_VERIFY_STATES.VERIFIED) {
      return { ok: true, claimed: false, reason: 'verified', item: existing };
    }
    if (existing.state !== BANK_VERIFY_STATES.NOT_STARTED) {
      return { ok: true, claimed: false, reason: existing.state, item: existing };
    }
    const item = {
      pk: key,
      sk: 'STATE',
      state: BANK_VERIFY_STATES.INITIATION_CLAIMED,
      claimant_id: String(claimantId),
      claimed_at: Number(nowMs),
      idempotency_key: idempotencyKey || null,
      token_fp: tokenFp || null,
      updated_at: Number(nowMs),
      tenant_id: tenantId || null,
      recipient_id: recipientId || null,
      account_id: accountId || null,
      bank_id: bankId || null,
      ttl: ttlEpochSeconds(nowMs, BANK_VERIFY_CLAIM_TTL_SECONDS),
    };
    map.set(key, item);
    return { ok: true, claimed: true, reason: 'claimed', item };
  };

  const transitionClaim = async ({
    recipientId,
    accountId,
    bankId,
    tenantId,
    to,
    nowMs = Date.now(),
    extra = {},
  } = {}) => {
    const ids = { recipientId, accountId, bankId, tenantId, nowMs };
    const key = claimPartitionKey(ids);
    const raw = map.get(key);
    if (raw && tenantScopeMismatch(raw, tenantId)) {
      return { ok: false, error: 'tenant_scope_mismatch', item: asClaim(raw, ids, nowMs) };
    }
    const existing = asClaim(raw, ids, nowMs);
    if (!canTransitionBankVerifyState(existing.state, to)) {
      return {
        ok: false,
        error: existing.state === BANK_VERIFY_STATES.VERIFIED
          ? 'verified_no_regression'
          : 'invalid_transition',
        item: existing,
      };
    }
    const item = {
      ...existing,
      ...extra,
      pk: key,
      sk: 'STATE',
      state: to,
      updated_at: Number(nowMs),
      tenant_id: existing.tenant_id || tenantId || null,
      recipient_id: existing.recipient_id || recipientId || null,
      account_id: existing.account_id || accountId || null,
      bank_id: existing.bank_id || bankId || null,
      verified_at: to === BANK_VERIFY_STATES.VERIFIED
        ? (existing.verified_at || Number(nowMs))
        : existing.verified_at || extra.verified_at || null,
      ttl: to === BANK_VERIFY_STATES.VERIFIED
        ? null
        : (extra.ttl || ttlEpochSeconds(nowMs, BANK_VERIFY_CLAIM_TTL_SECONDS)),
    };
    map.set(key, item);
    return { ok: true, item };
  };

  const consumeMvAttempt = async ({
    recipientId,
    accountId,
    bankId,
    tenantId,
    tokenFp,
    nowMs = Date.now(),
    windowMs = MV_ATTEMPT_WINDOW_MS,
    max = RECIPIENT_VERIFY_MAX_ATTEMPTS,
  } = {}) => {
    if (!recipientId || !accountId || !bankId || !tokenFp) {
      return { ok: false, error: 'bank_verify_limiter_unavailable', remaining: 0, locked: true };
    }
    const windowStart = Math.floor(Number(nowMs) / windowMs) * windowMs;
    const key = `${mvPartitionKey({ recipientId, accountId, bankId, tokenFp })}#${mvWindowSortKey(nowMs, windowMs)}`;
    const current = map.get(key) || { attempts: 0, window_start: windowStart };
    if (current.tenant_id && tenantScopeMismatch(current, tenantId)) {
      return { ok: false, error: 'tenant_scope_mismatch', remaining: 0, locked: true };
    }
    if (Number(current.attempts || 0) >= max) {
      return {
        ok: false,
        error: 'max_attempts_exceeded',
        count: Number(current.attempts),
        remaining: 0,
        locked: true,
        window_start: windowStart,
      };
    }
    const count = Number(current.attempts || 0) + 1;
    map.set(key, {
      attempts: count,
      window_start: windowStart,
      token_fp: tokenFp,
      tenant_id: tenantId || current.tenant_id || null,
      updated_at: Number(nowMs),
      ttl: ttlEpochSeconds(nowMs, BANK_VERIFY_MV_TTL_SECONDS),
    });
    return {
      ok: true,
      count,
      remaining: Math.max(0, max - count),
      locked: count >= max,
      window_start: windowStart,
    };
  };

  return {
    kind: 'memory',
    backing: map,
    getClaim,
    claimInitiation,
    transitionClaim,
    consumeMvAttempt,
  };
}

export function createUnavailableBankVerifyStore(message = 'bank_verify_state_unavailable') {
  const fail = async () => {
    throw unavailable(message);
  };
  return {
    kind: 'unavailable',
    getClaim: fail,
    claimInitiation: fail,
    transitionClaim: fail,
    consumeMvAttempt: fail,
  };
}

export function createDynamoBankVerifyStore({
  tableName,
  dynamoRequest = dynamoJsonRequest,
  nowMsFn = () => Date.now(),
} = {}) {
  const table = String(tableName || '').trim();
  if (!table) throw unavailable('table_missing');

  const getClaim = async (ids) => {
    try {
      const got = await dynamoRequest({
        target: 'DynamoDB_20120810.GetItem',
        body: {
          TableName: table,
          ConsistentRead: true,
          Key: { pk: dynamoS(claimPartitionKey(ids)), sk: dynamoS('STATE') },
        },
      });
      const item = asClaim(fromDynamo(got.Item), ids, ids.nowMs || nowMsFn());
      if (tenantScopeMismatch(item, ids.tenantId)) {
        throw unavailable('tenant_scope_mismatch');
      }
      return item;
    } catch (error) {
      if (error?.code === 'bank_verify_state_unavailable') throw error;
      throw unavailable(error?.code || error?.message);
    }
  };

  const claimInitiation = async ({
    recipientId,
    accountId,
    bankId,
    tenantId,
    claimantId = randomUUID(),
    idempotencyKey,
    tokenFp,
    nowMs = nowMsFn(),
  } = {}) => {
    const ids = { recipientId, accountId, bankId, tenantId, nowMs };
    const key = claimPartitionKey(ids);
    const ttl = ttlEpochSeconds(nowMs, BANK_VERIFY_CLAIM_TTL_SECONDS);
    const item = {
      pk: dynamoS(key),
      sk: dynamoS('STATE'),
      state: dynamoS(BANK_VERIFY_STATES.INITIATION_CLAIMED),
      claimant_id: dynamoS(claimantId),
      claimed_at: dynamoN(nowMs),
      updated_at: dynamoN(nowMs),
      idempotency_key: dynamoS(idempotencyKey || ''),
      token_fp: dynamoS(tokenFp || ''),
      tenant_id: dynamoS(tenantId || ''),
      recipient_id: dynamoS(recipientId || ''),
      account_id: dynamoS(accountId || ''),
      bank_id: dynamoS(bankId || ''),
      ttl: dynamoN(ttl),
    };
    try {
      await dynamoRequest({
        target: 'DynamoDB_20120810.PutItem',
        body: {
          TableName: table,
          Item: item,
          ConditionExpression: 'attribute_not_exists(pk) OR #s = :not_started OR (attribute_exists(#ttl) AND #ttl <= :nowEpoch AND #s <> :verified)',
          ExpressionAttributeNames: { '#s': 'state', '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':not_started': dynamoS(BANK_VERIFY_STATES.NOT_STARTED),
            ':verified': dynamoS(BANK_VERIFY_STATES.VERIFIED),
            ':nowEpoch': dynamoN(Math.floor(Number(nowMs) / 1000)),
          },
        },
      });
      return {
        ok: true,
        claimed: true,
        reason: 'claimed',
        item: asClaim(fromDynamo(item), ids, nowMs),
      };
    } catch (error) {
      if (error?.code === 'ConditionalCheckFailedException') {
        const existing = await getClaim(ids);
        if (tenantScopeMismatch(existing, tenantId)) {
          return { ok: false, claimed: false, error: 'tenant_scope_mismatch', reason: 'tenant_scope_mismatch', item: existing };
        }
        return {
          ok: true,
          claimed: false,
          reason: existing.state === BANK_VERIFY_STATES.VERIFIED ? 'verified' : existing.state,
          item: existing,
        };
      }
      throw unavailable(error?.code || error?.message);
    }
  };

  const transitionClaim = async ({
    recipientId,
    accountId,
    bankId,
    tenantId,
    to,
    nowMs = nowMsFn(),
    extra = {},
  } = {}) => {
    const ids = { recipientId, accountId, bankId, tenantId, nowMs };
    if (to === BANK_VERIFY_STATES.VERIFIED) {
      try {
        const updated = await dynamoRequest({
          target: 'DynamoDB_20120810.UpdateItem',
          body: {
            TableName: table,
            Key: { pk: dynamoS(claimPartitionKey(ids)), sk: dynamoS('STATE') },
            UpdateExpression: 'SET #s = :verified, updated_at = :now, verified_at = if_not_exists(verified_at, :now) REMOVE #ttl',
            ConditionExpression: 'attribute_not_exists(tenant_id) OR tenant_id = :empty OR tenant_id = :tenant',
            ExpressionAttributeNames: { '#s': 'state', '#ttl': 'ttl' },
            ExpressionAttributeValues: {
              ':verified': dynamoS(BANK_VERIFY_STATES.VERIFIED),
              ':now': dynamoN(nowMs),
              ':empty': dynamoS(''),
              ':tenant': dynamoS(tenantId || ''),
            },
            ReturnValues: 'ALL_NEW',
          },
        });
        return { ok: true, item: asClaim(fromDynamo(updated.Attributes), ids, nowMs) };
      } catch (error) {
        if (error?.code === 'ConditionalCheckFailedException') {
          return { ok: false, error: 'tenant_scope_mismatch', item: await getClaim(ids) };
        }
        throw unavailable(error?.code || error?.message);
      }
    }
    if (!canTransitionBankVerifyState(BANK_VERIFY_STATES.NOT_STARTED, to)
      && !canTransitionBankVerifyState(BANK_VERIFY_STATES.INITIATION_CLAIMED, to)
      && !canTransitionBankVerifyState(BANK_VERIFY_STATES.VERIFICATION_PENDING, to)
      && !canTransitionBankVerifyState(BANK_VERIFY_STATES.UNCERTAIN, to)) {
      return { ok: false, error: 'invalid_transition', item: await getClaim(ids) };
    }
    try {
      const names = { '#s': 'state', '#ttl': 'ttl' };
      const values = {
        ':to': dynamoS(to),
        ':now': dynamoN(nowMs),
        ':verified': dynamoS(BANK_VERIFY_STATES.VERIFIED),
        ':not_started': dynamoS(BANK_VERIFY_STATES.NOT_STARTED),
        ':claimed': dynamoS(BANK_VERIFY_STATES.INITIATION_CLAIMED),
        ':pending': dynamoS(BANK_VERIFY_STATES.VERIFICATION_PENDING),
        ':uncertain': dynamoS(BANK_VERIFY_STATES.UNCERTAIN),
        ':ttl': dynamoN(ttlEpochSeconds(nowMs, BANK_VERIFY_CLAIM_TTL_SECONDS)),
        ':empty': dynamoS(''),
        ':tenant': dynamoS(tenantId || ''),
      };
      const extraSet = ['#ttl = :ttl'];
      if (extra.idempotency_key) {
        extraSet.push('idempotency_key = :idem');
        values[':idem'] = dynamoS(extra.idempotency_key);
      }
      if (extra.token_fp) {
        extraSet.push('token_fp = :tfp');
        values[':tfp'] = dynamoS(extra.token_fp);
      }
      const updated = await dynamoRequest({
        target: 'DynamoDB_20120810.UpdateItem',
        body: {
          TableName: table,
          Key: { pk: dynamoS(claimPartitionKey(ids)), sk: dynamoS('STATE') },
          UpdateExpression: `SET #s = :to, updated_at = :now, ${extraSet.join(', ')}`,
          ConditionExpression: '(attribute_not_exists(tenant_id) OR tenant_id = :empty OR tenant_id = :tenant) AND (attribute_not_exists(#s) OR (#s <> :verified AND (#s = :not_started OR #s = :claimed OR #s = :pending OR #s = :uncertain)))',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        },
      });
      const item = asClaim(fromDynamo(updated.Attributes), ids, nowMs);
      if (item.state === BANK_VERIFY_STATES.VERIFIED && to !== BANK_VERIFY_STATES.VERIFIED) {
        return { ok: false, error: 'verified_no_regression', item };
      }
      return { ok: true, item };
    } catch (error) {
      if (error?.code === 'ConditionalCheckFailedException') {
        const existing = await getClaim(ids);
        return {
          ok: false,
          error: existing.state === BANK_VERIFY_STATES.VERIFIED
            ? 'verified_no_regression'
            : (tenantScopeMismatch(existing, tenantId) ? 'tenant_scope_mismatch' : 'invalid_transition'),
          item: existing,
        };
      }
      throw unavailable(error?.code || error?.message);
    }
  };

  const consumeMvAttempt = async ({
    recipientId,
    accountId,
    bankId,
    tenantId,
    tokenFp,
    nowMs = nowMsFn(),
    windowMs = MV_ATTEMPT_WINDOW_MS,
    max = RECIPIENT_VERIFY_MAX_ATTEMPTS,
  } = {}) => {
    if (!recipientId || !accountId || !bankId || !tokenFp) {
      return { ok: false, error: 'bank_verify_limiter_unavailable', remaining: 0, locked: true };
    }
    const windowStart = Math.floor(Number(nowMs) / windowMs) * windowMs;
    try {
      const updated = await dynamoRequest({
        target: 'DynamoDB_20120810.UpdateItem',
        body: {
          TableName: table,
          Key: {
            pk: dynamoS(mvPartitionKey({ recipientId, accountId, bankId, tokenFp })),
            sk: dynamoS(mvWindowSortKey(nowMs, windowMs)),
          },
          UpdateExpression: 'SET attempts = if_not_exists(attempts, :zero) + :one, window_start = :ws, updated_at = :now, token_fp = :tfp, #ttl = :ttl, tenant_id = if_not_exists(tenant_id, :tenant)',
          ConditionExpression: '(attribute_not_exists(attempts) OR attempts < :max) AND (attribute_not_exists(tenant_id) OR tenant_id = :empty OR tenant_id = :tenant)',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':zero': dynamoN(0),
            ':one': dynamoN(1),
            ':max': dynamoN(max),
            ':ws': dynamoN(windowStart),
            ':now': dynamoN(nowMs),
            ':tfp': dynamoS(tokenFp),
            ':ttl': dynamoN(ttlEpochSeconds(nowMs, BANK_VERIFY_MV_TTL_SECONDS)),
            ':tenant': dynamoS(tenantId || ''),
            ':empty': dynamoS(''),
          },
          ReturnValues: 'ALL_NEW',
        },
      });
      const item = fromDynamo(updated.Attributes);
      const count = Number(item.attempts || 0);
      return {
        ok: true,
        count,
        remaining: Math.max(0, max - count),
        locked: count >= max,
        window_start: windowStart,
      };
    } catch (error) {
      if (error?.code === 'ConditionalCheckFailedException') {
        return {
          ok: false,
          error: 'max_attempts_exceeded',
          count: max,
          remaining: 0,
          locked: true,
          window_start: windowStart,
        };
      }
      throw unavailable(error?.code || error?.message);
    }
  };

  return {
    kind: 'dynamodb',
    tableName: table,
    getClaim,
    claimInitiation,
    transitionClaim,
    consumeMvAttempt,
  };
}

export function openRecipientBankVerifyStore(deps = {}) {
  if (deps.bankVerifyStore) return { ok: true, store: deps.bankVerifyStore };
  const table = String(process.env[BANK_VERIFY_STATE_TABLE_ENV] || deps.tableName || '').trim();
  if (!table) {
    return { ok: false, error: 'bank_verify_state_unconfigured', statusCode: 503 };
  }
  try {
    return {
      ok: true,
      store: createDynamoBankVerifyStore({
        tableName: table,
        dynamoRequest: deps.dynamoRequest || dynamoJsonRequest,
      }),
    };
  } catch (error) {
    return { ok: false, error: 'bank_verify_state_unavailable', statusCode: 503, message: error?.message };
  }
}
