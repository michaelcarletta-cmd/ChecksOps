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
export const BANK_VERIFY_STATE_TABLE_ENV = 'AWS_RECIPIENT_BANK_VERIFY_STATE_TABLE';

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
});

const unavailable = (operation) => {
  const error = new Error('bank_verify_state_unavailable');
  error.code = 'bank_verify_state_unavailable';
  error.operation = operation;
  return error;
};

const asClaim = (item, ids) => {
  if (!item) return emptyClaim(ids);
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
  };
};

export function createMemoryBankVerifyStore(backing = new Map()) {
  const map = backing;

  const getClaim = async (ids) => asClaim(map.get(claimPartitionKey(ids)), ids);

  const claimInitiation = async ({
    recipientId,
    accountId,
    bankId,
    claimantId = randomUUID(),
    idempotencyKey,
    tokenFp,
    nowMs = Date.now(),
  } = {}) => {
    const ids = { recipientId, accountId, bankId };
    const key = claimPartitionKey(ids);
    const existing = asClaim(map.get(key), ids);
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
    };
    map.set(key, item);
    return { ok: true, claimed: true, reason: 'claimed', item };
  };

  const transitionClaim = async ({
    recipientId,
    accountId,
    bankId,
    to,
    nowMs = Date.now(),
    extra = {},
  } = {}) => {
    const ids = { recipientId, accountId, bankId };
    const key = claimPartitionKey(ids);
    const existing = asClaim(map.get(key), ids);
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
      verified_at: to === BANK_VERIFY_STATES.VERIFIED
        ? (existing.verified_at || Number(nowMs))
        : existing.verified_at || extra.verified_at || null,
    };
    map.set(key, item);
    return { ok: true, item };
  };

  const consumeMvAttempt = async ({
    recipientId,
    accountId,
    bankId,
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
      updated_at: Number(nowMs),
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
      return asClaim(fromDynamo(got.Item), ids);
    } catch (error) {
      throw unavailable(error?.code || error?.message);
    }
  };

  const claimInitiation = async ({
    recipientId,
    accountId,
    bankId,
    claimantId = randomUUID(),
    idempotencyKey,
    tokenFp,
    nowMs = nowMsFn(),
  } = {}) => {
    const ids = { recipientId, accountId, bankId };
    const key = claimPartitionKey(ids);
    const item = {
      pk: dynamoS(key),
      sk: dynamoS('STATE'),
      state: dynamoS(BANK_VERIFY_STATES.INITIATION_CLAIMED),
      claimant_id: dynamoS(claimantId),
      claimed_at: dynamoN(nowMs),
      updated_at: dynamoN(nowMs),
      idempotency_key: dynamoS(idempotencyKey || ''),
      token_fp: dynamoS(tokenFp || ''),
    };
    try {
      await dynamoRequest({
        target: 'DynamoDB_20120810.PutItem',
        body: {
          TableName: table,
          Item: item,
          ConditionExpression: 'attribute_not_exists(pk) OR #s = :not_started',
          ExpressionAttributeNames: { '#s': 'state' },
          ExpressionAttributeValues: { ':not_started': dynamoS(BANK_VERIFY_STATES.NOT_STARTED) },
        },
      });
      return {
        ok: true,
        claimed: true,
        reason: 'claimed',
        item: asClaim(fromDynamo(item), ids),
      };
    } catch (error) {
      if (error?.code === 'ConditionalCheckFailedException') {
        const existing = await getClaim(ids);
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
    to,
    nowMs = nowMsFn(),
    extra = {},
  } = {}) => {
    const ids = { recipientId, accountId, bankId };
    if (to === BANK_VERIFY_STATES.VERIFIED) {
      try {
        const updated = await dynamoRequest({
          target: 'DynamoDB_20120810.UpdateItem',
          body: {
            TableName: table,
            Key: { pk: dynamoS(claimPartitionKey(ids)), sk: dynamoS('STATE') },
            UpdateExpression: 'SET #s = :verified, updated_at = :now, verified_at = if_not_exists(verified_at, :now)',
            ExpressionAttributeNames: { '#s': 'state' },
            ExpressionAttributeValues: {
              ':verified': dynamoS(BANK_VERIFY_STATES.VERIFIED),
              ':now': dynamoN(nowMs),
            },
            ReturnValues: 'ALL_NEW',
          },
        });
        return { ok: true, item: asClaim(fromDynamo(updated.Attributes), ids) };
      } catch (error) {
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
      const names = { '#s': 'state' };
      const values = {
        ':to': dynamoS(to),
        ':now': dynamoN(nowMs),
        ':verified': dynamoS(BANK_VERIFY_STATES.VERIFIED),
        ':not_started': dynamoS(BANK_VERIFY_STATES.NOT_STARTED),
        ':claimed': dynamoS(BANK_VERIFY_STATES.INITIATION_CLAIMED),
        ':pending': dynamoS(BANK_VERIFY_STATES.VERIFICATION_PENDING),
        ':uncertain': dynamoS(BANK_VERIFY_STATES.UNCERTAIN),
      };
      const extraSet = [];
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
          UpdateExpression: `SET #s = :to, updated_at = :now${extraSet.length ? `, ${extraSet.join(', ')}` : ''}`,
          ConditionExpression: 'attribute_not_exists(#s) OR (#s <> :verified AND (#s = :not_started OR #s = :claimed OR #s = :pending OR #s = :uncertain))',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        },
      });
      const item = asClaim(fromDynamo(updated.Attributes), ids);
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
            : 'invalid_transition',
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
          UpdateExpression: 'SET attempts = if_not_exists(attempts, :zero) + :one, window_start = :ws, updated_at = :now, token_fp = :tfp',
          ConditionExpression: 'attribute_not_exists(attempts) OR attempts < :max',
          ExpressionAttributeValues: {
            ':zero': dynamoN(0),
            ':one': dynamoN(1),
            ':max': dynamoN(max),
            ':ws': dynamoN(windowStart),
            ':now': dynamoN(nowMs),
            ':tfp': dynamoS(tokenFp),
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
