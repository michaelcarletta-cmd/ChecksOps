import { formatCheckAltUserAmount, rejectUntrustedAmountFields, validateProviderCents } from '../amounts.mjs';
import { ignoredOwnershipSpoof, verifyOwnershipChain } from '../../financial-ownership.mjs';
import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { isProviderNetworkError } from '../../sandbox-credentials.mjs';
import { buildDepositProcessBody, checkAltFetch, getCheckAltJwt } from '../parity/checkalt-client.mjs';
import { authorizeCheckAltProduction } from './checkalt-authz.mjs';
import { loadProductionCheckAltConfig, loadProductionTenantAccount } from './checkalt-config.mjs';
import {
  checkAltIdempotencyKey,
  commitDurableAttempt,
  insertQueuedDeposit,
  loadDepositByIdempotency,
  loadDepositsForCheck,
  markHttpAttempted,
  persistAutoApproveOutcome,
  persistProviderOutcome,
  pickBlockingDeposit,
  replayDepositResponse,
  shouldReconcileInsteadOfPost,
} from './checkalt-idempotency.mjs';
import {
  CHECK_ELIGIBILITY_SELECT,
  evaluateProductionDepositEligibility,
  loadCheckEndorsements,
  loadCheckPayees,
  mapCheckAltImageGateError,
} from './checkalt-eligibility.mjs';
import { loadProductionDepositImages } from './checkalt-images.mjs';
import { loadProductionCheckAltSecrets } from './checkalt-secrets.mjs';
import { reconcileProductionCheckAltDeposit, resolveSsoKey } from './checkalt-poll.mjs';

const jwtCache = { token: null, expiresAt: null };

const membershipsOf = async (client, userId) => {
  const rows = (await client.query(TENANT_MEMBERSHIP_SQL, [userId])).rows;
  return rows.map((row) => ({
    tenant_id: row.tenant_id,
    role: row.role,
    tenant_name: row.tenant_name,
    tenant_slug: row.tenant_slug,
  }));
};

const fail = (error, statusCode, extra = {}) => ({
  ok: false,
  statusCode,
  error,
  provider: 'checkalt',
  liveProviderCalled: false,
  productionExecution: extra.productionExecution === true,
  ...extra,
});

const parseProviderJson = async (resp) => {
  const raw = await resp.text();
  let json;
  try { json = JSON.parse(raw); } catch { json = { raw: String(raw).slice(0, 500) }; }
  return { raw, json };
};

const referenceOf = (json) => {
  if (json?.referenceNumber != null) return String(json.referenceNumber);
  if (json?.reference != null) return String(json.reference);
  return null;
};

/*
 * Post-process auto-approval (Cursor PR #433 port; always on since 2026-10-22).
 *
 * CheckAlt process status 40 (pending_approval) needs a second
 * /fincapture/deposit/approve call. Owner decision 2026-10-22: auto-approve is
 * always on for every organization, with no amount ceiling. The tenant columns
 * checkalt_tenant_accounts.auto_approve_enabled and auto_approve_max_cents stay
 * in place but no longer decide anything. Owner decision 2026-10-24 ("Option A",
 * the legacy Lovable/Supabase behaviour): every deposit CheckAlt parked as
 * pending_approval is approved unless CheckAlt flagged it. There is no "Low Risk"
 * gate any more: CheckAlt's FinCapture Status & Reject Reference documents
 * riskRating as Accepted / Decline / Warning and riskRatingDescription as free
 * text, so an exact "Low Risk" never matched. The submit flow makes the approve
 * call itself only after its own committed /deposit/process parked the item, the
 * reference is a positive integer, the server-side amount is a positive integer,
 * and CheckAlt did not flag it (depositIsFlagged: a duplicate, an amount mismatch,
 * a Decline or Warning risk rating, errors, exceptions, warnings, risk factors, or
 * flag words in the status text). A flagged item stays pending_approval and is
 * handled in the Check Alt portal. It never POSTs /deposit/process, never inserts
 * a deposit, and never requires or satisfies the manual-approve TOTP
 * (checkalt-approve.mjs). Replays never reach it (they return before any provider
 * HTTP). Any provider, lock, timeout or persist ambiguity leaves the row
 * pending_approval.
 *
 * Runs under an overall deadline (API Gateway / Lambda allow 29s) so the user
 * always gets the deposit id, reference and status back instead of a 504.
 */
export const AUTO_APPROVE_BACKOFF_MS = Object.freeze([1000, 2000, 3000]);
export const AUTO_APPROVE_MAX_ATTEMPTS = AUTO_APPROVE_BACKOFF_MS.length + 1;
export const AUTO_APPROVE_DEADLINE_MS = 20000;
export const AUTO_APPROVE_REQUEST_TIMEOUT_MS = 5000;
export const AUTO_APPROVE_MIN_REQUEST_MS = 1000;
/** Headroom kept back when the Lambda context's remaining time is known. */
export const AUTO_APPROVE_LAMBDA_HEADROOM_MS = 5000;

/** Short classified codes only. Raw provider or error text is logged, never stored or returned. */
export const AUTO_APPROVE_SKIP_REASONS = Object.freeze([
  'not_pending_approval',
  'missing_reference',
  'invalid_reference',
  'flagged_by_checkalt',
  // Recorded on rows submitted before 2026-10-24 (the removed "Low Risk" gate); no longer produced.
  'risk_not_low',
  'invalid_amount',
  'provider_declined',
  'locked_exhausted',
  'auth_failed',
  'auto_approve_timeout',
  'auto_approve_error',
  'auto_approve_persist_failed',
]);

const AUTO_APPROVE_FLAG_TEXT_RE = /duplicate|fraud|risk|exception|warning|hold|suspect|mismatch|unreadable/;
const FLAGGED_RISK_RATINGS = new Set(['decline', 'warning']);

export const AUTO_APPROVE_POLICY_SOURCE = 'always_on';

/**
 * Always on for every organization, with no amount ceiling. The tenant and global
 * auto_approve_enabled / auto_approve_max_cents settings are ignored on purpose.
 */
export const resolveAutoApprovePolicy = () => ({
  enabled: true,
  maxCents: null,
  source: AUTO_APPROVE_POLICY_SOURCE,
});

const isTrueFlag = (value) => value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
const isFalseFlag = (value) => value === false || (typeof value === 'string' && value.trim().toLowerCase() === 'false');

export const depositIsFlagged = (providerJson = {}) => {
  const json = providerJson && typeof providerJson === 'object' ? providerJson : {};
  for (const key of ['exceptions', 'warnings', 'riskFactors', 'errors']) {
    if (Array.isArray(json[key]) && json[key].length > 0) return true;
  }
  if (isTrueFlag(json.amountDiscrepancyDetected)) return true;
  // FinCapture Status & Reject Reference: duplicateStatus true marks a duplicate item.
  if (isTrueFlag(json.duplicateStatus)) return true;
  // riskRating is Accepted / Decline / Warning; Decline and Warning are CheckAlt risk flags.
  if (typeof json.riskRating === 'string' && FLAGGED_RISK_RATINGS.has(json.riskRating.trim().toLowerCase())) return true;
  // ocrAmountStatus False: the recognized amount does not match the keyed amount.
  if (isFalseFlag(json.ocrAmountStatus)) return true;
  // riskRatingDescription is free text and is not regexed here.
  const flagText = [
    json.statusDescription,
    JSON.stringify(json.warnings ?? ''),
    JSON.stringify(json.exceptions ?? ''),
  ].join(' ').toLowerCase();
  return AUTO_APPROVE_FLAG_TEXT_RE.test(flagText);
};

/** CheckAlt references are positive integers sent as JSON numbers. */
export const safeCheckAltReference = (reference) => {
  const text = String(reference ?? '').trim();
  if (!/^[1-9]\d*$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
};

export const decideAutoApprove = ({
  processRequiresApproval = false,
  reference = null,
  amountCents = null,
  flagged = false,
} = {}) => {
  if (!processRequiresApproval) return { approve: false, skipReason: 'not_pending_approval' };
  if (reference === null || reference === undefined || String(reference).trim() === '') {
    return { approve: false, skipReason: 'missing_reference' };
  }
  if (safeCheckAltReference(reference) === null) return { approve: false, skipReason: 'invalid_reference' };
  if (flagged) return { approve: false, skipReason: 'flagged_by_checkalt' };
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { approve: false, skipReason: 'invalid_amount' };
  return { approve: true, skipReason: null };
};

export const isCheckAltApproveLockError = (status, json = {}) => {
  if (Number(status) !== 404) return false;
  const msg = String(json?.message ?? json?.statusDescription ?? '').toLowerCase();
  return msg.includes('locate transaction') || msg.includes('locked');
};

const isTimeoutError = (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError';

const logAutoApprove = (fields) => {
  try {
    console.warn(JSON.stringify({ event: 'checkalt_auto_approve', ...fields }));
  } catch {
    /* logging is best-effort */
  }
};

const providerDetail = (json) => String(json?.statusDescription ?? json?.message ?? '').slice(0, 200);

/**
 * Retries only HTTP 404 + locate/locked (CheckAlt has not accepted the approve),
 * and only while the deadline leaves room for another bounded request.
 */
export async function attemptAutoApproveWithLockRetry({
  cfg,
  credentials,
  fetchImpl,
  reference,
  depositId = null,
  deadline = Date.now() + AUTO_APPROVE_DEADLINE_MS,
  now = Date.now,
  requestTimeoutMs = AUTO_APPROVE_REQUEST_TIMEOUT_MS,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const referenceNumber = safeCheckAltReference(reference);
  let lastJson = null;
  let lastStatus = 0;
  const done = (attempts, extra) => ({ approved: false, json: lastJson, status: lastStatus, attempts, ...extra });
  const timedOut = (attempts, detail) => {
    logAutoApprove({ deposit_id: depositId, code: 'auto_approve_timeout', attempts, http_status: lastStatus, detail });
    return done(attempts, { skipReason: 'auto_approve_timeout' });
  };
  if (referenceNumber === null) return done(0, { skipReason: 'invalid_reference' });
  for (let attempt = 0; attempt < AUTO_APPROVE_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      const wait = AUTO_APPROVE_BACKOFF_MS[attempt - 1];
      if (deadline - now() < wait + AUTO_APPROVE_MIN_REQUEST_MS) return timedOut(attempt, 'deadline_before_retry');
      await sleepFn(wait);
    }
    const remaining = deadline - now();
    if (remaining < AUTO_APPROVE_MIN_REQUEST_MS) return timedOut(attempt, 'deadline_before_request');
    // Equivalent to AbortSignal.timeout, but a referenced timer we clear, so the
    // abort fires even when nothing else holds the event loop open.
    const controller = new AbortController();
    const { signal } = controller;
    const timer = setTimeout(() => {
      controller.abort(new DOMException('CheckAlt approve request timed out', 'TimeoutError'));
    }, Math.max(1, Math.min(requestTimeoutMs, remaining)));
    const boundedFetch = (url, options = {}) => fetchImpl(url, { ...options, signal });
    try {
      const resp = await checkAltFetch({
        cfg,
        credentials,
        path: '/fincapture/deposit/approve',
        body: { fiKey: cfg.fi_key, referenceNumber, action: 1 },
        fetchImpl: boundedFetch,
        jwtCache,
      });
      lastJson = (await parseProviderJson(resp)).json;
      lastStatus = resp.status;
      if (resp.ok && lastJson?.success === true) {
        return { approved: true, json: lastJson, status: lastStatus, attempts: attempt + 1 };
      }
      if (lastStatus === 401 || lastStatus === 403) {
        logAutoApprove({ deposit_id: depositId, code: 'auth_failed', attempts: attempt + 1, http_status: lastStatus, detail: providerDetail(lastJson) });
        return done(attempt + 1, { skipReason: 'auth_failed' });
      }
      if (!isCheckAltApproveLockError(lastStatus, lastJson)) {
        logAutoApprove({ deposit_id: depositId, code: 'provider_declined', attempts: attempt + 1, http_status: lastStatus, detail: providerDetail(lastJson) });
        return done(attempt + 1, { skipReason: 'provider_declined' });
      }
    } catch (error) {
      if (isTimeoutError(error) || signal.aborted) return timedOut(attempt + 1, 'request_timeout');
      logAutoApprove({
        deposit_id: depositId,
        code: 'auto_approve_error',
        attempts: attempt + 1,
        detail: String(error?.message || error).slice(0, 200),
      });
      return done(attempt + 1, { skipReason: 'auto_approve_error' });
    } finally {
      clearTimeout(timer);
    }
  }
  logAutoApprove({ deposit_id: depositId, code: 'locked_exhausted', attempts: AUTO_APPROVE_MAX_ATTEMPTS, http_status: lastStatus, detail: providerDetail(lastJson) });
  return done(AUTO_APPROVE_MAX_ATTEMPTS, { skipReason: 'locked_exhausted' });
}

/** Never throws. Persist failures, timeouts and provider errors leave pending_approval. */
export async function maybeAutoApproveAfterProcess({
  client,
  row,
  acct,
  amountCents,
  providerJson,
  cfg,
  credentials,
  fetchImpl,
  commit = async () => {},
  sleepFn,
  deadline = Date.now() + AUTO_APPROVE_DEADLINE_MS,
  now = Date.now,
  requestTimeoutMs = AUTO_APPROVE_REQUEST_TIMEOUT_MS,
} = {}) {
  const policy = resolveAutoApprovePolicy();
  let decision = decideAutoApprove({
    processRequiresApproval: row?.status === 'pending_approval',
    reference: row?.checkalt_reference ?? null,
    amountCents,
    flagged: depositIsFlagged(providerJson),
  });
  if (decision.approve && deadline - now() < AUTO_APPROVE_MIN_REQUEST_MS) {
    decision = { approve: false, skipReason: 'auto_approve_timeout' };
  }
  const persist = (fields) => persistAutoApproveOutcome(client, {
    rowId: row.id,
    tenantId: row.tenant_id,
    maxCents: policy.maxCents,
    ...fields,
  });
  const result = (extra) => ({
    attempted: false,
    approved: false,
    approvePosted: false,
    skipReason: decision.skipReason,
    maxCents: policy.maxCents,
    policySource: policy.source,
    saved: null,
    ...extra,
  });
  if (!decision.approve) {
    let saved = null;
    try {
      saved = await persist({ phase: 'skipped', skipReason: decision.skipReason });
      await commit();
    } catch {
      saved = null;
    }
    return result({ saved });
  }

  // Durable evidence before the approve POST. If it cannot be written and committed, do not POST.
  try {
    const marked = await persist({ phase: 'attempting' });
    if (!marked) throw new Error('auto_approve_marker_missing');
    await commit();
  } catch {
    return result({ skipReason: 'auto_approve_persist_failed' });
  }

  const outcome = await attemptAutoApproveWithLockRetry({
    cfg,
    credentials,
    fetchImpl,
    reference: row.checkalt_reference,
    depositId: row.id,
    deadline,
    now,
    requestTimeoutMs,
    sleepFn,
  });
  let saved = null;
  try {
    saved = await persist({
      phase: 'outcome',
      approved: outcome.approved === true,
      skipReason: outcome.approved ? null : outcome.skipReason,
      approvePayload: outcome.json,
      attempts: outcome.attempts,
    });
    await commit();
  } catch {
    saved = null;
  }
  return result({
    attempted: true,
    approved: outcome.approved === true,
    approvePosted: outcome.attempts > 0,
    skipReason: outcome.approved ? null : outcome.skipReason,
    attempts: outcome.attempts,
    persistFailed: !saved,
    saved,
  });
}

/**
 * About 20s from handler start. The API Lambda handler does not receive a
 * context today; if a getRemainingTimeInMillis is injected, the earlier bound wins.
 */
export const autoApproveDeadline = ({ startedAt, now = Date.now, deps = {} } = {}) => {
  const budget = Number.isInteger(deps.autoApproveDeadlineMs) ? deps.autoApproveDeadlineMs : AUTO_APPROVE_DEADLINE_MS;
  let deadline = startedAt + budget;
  if (typeof deps.getRemainingTimeInMillis === 'function') {
    const remaining = Number(deps.getRemainingTimeInMillis());
    if (Number.isFinite(remaining)) deadline = Math.min(deadline, now() + remaining - AUTO_APPROVE_LAMBDA_HEADROOM_MS);
  }
  return deadline;
};

export async function handleProductionCheckAltSubmit({
  client,
  mapping,
  claims,
  body,
  spoof,
  fetchImpl = fetch,
  deps = {},
} = {}) {
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const handlerStartedAt = now();
  const amountSpoof = rejectUntrustedAmountFields(body);
  if (amountSpoof) {
    return { ...amountSpoof, liveProviderCalled: false, productionExecution: false, spoofFieldsIgnored: spoof };
  }
  if (body.frontImage || body.rearImage || body.front_image || body.rear_image) {
    return fail('untrusted_image_bytes', 400, {
      message: 'Browser-supplied image bytes are ignored. Server loads deposit JPEGs from S3.',
    });
  }

  const checkId = body.check_intake_item_id || body.check_id;
  if (!checkId) return fail('check_intake_item_id is required', 400);

  if (body.merchant || body.fi_key || body.fiKey || body.base_url || body.environment
    || body.deposit_account_number || body.sso_user_id || body.depositor_account_id) {
    return fail('untrusted_provider_config', 400, {
      message: 'CheckAlt environment, merchant, FI, and destination account are server-derived.',
      ignored: ignoredOwnershipSpoof(body),
    });
  }

  const check = (await client.query(
    `SELECT ${CHECK_ELIGIBILITY_SELECT}
     FROM public.check_intake_items WHERE id = $1::uuid`,
    [checkId],
  )).rows[0];
  if (!check) return fail('Check not found', 404);

  const claimedTenant = body.tenant_id || body.tenantId || null;
  if (claimedTenant && claimedTenant !== check.tenant_id) {
    return fail('cross_tenant_denied', 403, {
      message: 'Browser tenant_id does not match the check tenant and is not used as authority.',
    });
  }
  const claimedUser = body.user_id || body.userId || body.application_user_id || null;
  if (claimedUser && claimedUser !== mapping.application_user_id) {
    return fail('identity_spoof_denied', 403, {
      message: 'Browser user_id is not authorization. Cognito-mapped application UUID is used.',
    });
  }

  const memberships = await membershipsOf(client, mapping.application_user_id);
  const ownership = verifyOwnershipChain({
    applicationUserId: mapping.application_user_id,
    memberships,
    check,
    claimed: body,
  });
  if (!ownership.ok) {
    return fail(ownership.error || 'cross_tenant_denied', ownership.statusCode || 403, {
      field: ownership.field,
      spoofFieldsIgnored: { ...spoof, ignoredOwnership: ownership.ignored },
    });
  }

  const authz = await authorizeCheckAltProduction({
    client,
    mapping,
    claims,
    memberships,
    check,
    requireStepUp: true,
  });
  if (!authz.ok) return { ...authz, spoofFieldsIgnored: spoof };

  const formatted = formatCheckAltUserAmount(check.amount);
  if (formatted?.error) return fail(formatted.message || 'invalid_amount', 400);
  const centsCheck = validateProviderCents(formatted.userAmount);
  if (centsCheck.error) return fail(centsCheck.message || 'invalid_amount', 400);
  const userAmount = centsCheck.cents;

  const idempotencyKey = checkAltIdempotencyKey({
    tenantId: check.tenant_id,
    checkId: check.id,
    amountCents: userAmount,
  });
  const existingForCheck = await loadDepositsForCheck(client, {
    tenantId: check.tenant_id,
    checkId: check.id,
  });
  const blocking = pickBlockingDeposit(existingForCheck);

  const loadSecretsConfigAccount = async () => {
    const secrets = await (deps.loadProductionSecrets || loadProductionCheckAltSecrets)(deps.getSecrets);
    if (!secrets.ok) return { errorResult: { ...secrets, spoofFieldsIgnored: spoof } };
    const loadedCfg = await loadProductionCheckAltConfig(client, { credentials: secrets.credentials });
    if (!loadedCfg.ok) return { errorResult: { ...loadedCfg, spoofFieldsIgnored: spoof } };
    const acct = await loadProductionTenantAccount(client, check.tenant_id);
    if (!acct?.sso_user_id || !acct?.deposit_account_number || acct.enabled === false) {
      return {
        errorResult: fail('account_unregistered', 409, {
          message: 'No registered production CheckAlt depositor for this tenant. Browser cannot choose the destination account.',
        }),
      };
    }
    return { secrets, loadedCfg, acct };
  };

  if (blocking) {
    if (blocking.checkalt_reference && ['submitted', 'pending_approval', 'cleared'].includes(String(blocking.status || ''))) {
      return {
        ...replayDepositResponse(blocking, {
          message: 'Existing CheckAlt deposit for this check reused. A second FinCapture POST was not sent.',
        }),
        duplicate: true,
        replayed: true,
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
      };
    }
    if (blocking.checkalt_reference) {
      const loaded = await loadSecretsConfigAccount();
      if (loaded.errorResult) return loaded.errorResult;
      const reconciled = await reconcileProductionCheckAltDeposit({
        client,
        mapping,
        row: blocking,
        cfg: loaded.loadedCfg.cfg,
        credentials: loaded.loadedCfg.credentials,
        acct: loaded.acct,
        fetchImpl,
      });
      return {
        ...reconciled,
        duplicate: true,
        replayed: true,
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
      };
    }
    return {
      ...replayDepositResponse(blocking, {
        message: 'An existing CheckAlt deposit for this check may already have reached the provider. Reconcile manually. A second FinCapture POST was not sent.',
      }),
      ok: true,
      statusCode: 200,
      success: false,
      duplicate: true,
      replayed: true,
      reconciled: false,
      uncertain: true,
      error: 'reconciliation_required',
      liveProviderCalled: false,
      productionExecution: false,
      spoofFieldsIgnored: spoof,
      applicationUserId: mapping.application_user_id,
    };
  }

  const existing = await loadDepositByIdempotency(client, {
    tenantId: check.tenant_id,
    idempotencyKey,
  });
  if (existing && shouldReconcileInsteadOfPost(existing)) {
    if (existing.checkalt_reference && ['submitted', 'pending_approval', 'cleared'].includes(existing.status)) {
      return {
        ...replayDepositResponse(existing),
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
      };
    }
    const loaded = await loadSecretsConfigAccount();
    if (loaded.errorResult) return loaded.errorResult;
    const reconciled = await reconcileProductionCheckAltDeposit({
      client,
      mapping,
      row: existing,
      cfg: loaded.loadedCfg.cfg,
      credentials: loaded.loadedCfg.credentials,
      acct: loaded.acct,
      fetchImpl,
    });
    return {
      ...reconciled,
      duplicate: true,
      replayed: true,
      spoofFieldsIgnored: spoof,
      applicationUserId: mapping.application_user_id,
    };
  }

  const payees = await loadCheckPayees(client, check.id, check.tenant_id);
  const endorsements = await loadCheckEndorsements(client, check.id, check.tenant_id);
  const eligibility = evaluateProductionDepositEligibility({ check, payees, endorsements });
  if (!eligibility.ok) {
    return fail(eligibility.error, 403, {
      reason: eligibility.reason,
      liveProviderCalled: false,
      productionExecution: false,
    });
  }

  const images = await loadProductionDepositImages(check, {}, deps);
  if (!images.ok) {
    const mapped = mapCheckAltImageGateError(images);
    return {
      ...images,
      ...mapped,
      spoofFieldsIgnored: spoof,
      liveProviderCalled: false,
      productionExecution: false,
    };
  }

  const loaded = await loadSecretsConfigAccount();
  if (loaded.errorResult) return loaded.errorResult;
  const { loadedCfg, acct } = loaded;

  const queued = existing
    ? { ok: true, row: existing, inserted: false }
    : await insertQueuedDeposit(client, {
      check,
      mapping,
      amountCents: userAmount,
      idempotencyKey,
    });
  if (!queued.ok) return { ...queued, spoofFieldsIgnored: spoof };
  if (queued.duplicate && shouldReconcileInsteadOfPost(queued.row)) {
    return {
      ...replayDepositResponse(queued.row),
      spoofFieldsIgnored: spoof,
      applicationUserId: mapping.application_user_id,
    };
  }

  await commitDurableAttempt(client, mapping, claims);
  const claimedHttp = await markHttpAttempted(client, queued.row.id);
  await commitDurableAttempt(client, mapping, claims);
  if (!claimedHttp.claimed) {
    if (claimedHttp.row && shouldReconcileInsteadOfPost(claimedHttp.row)) {
      const reconciled = await reconcileProductionCheckAltDeposit({
        client,
        mapping,
        row: claimedHttp.row,
        cfg: loadedCfg.cfg,
        credentials: loadedCfg.credentials,
        acct,
        fetchImpl,
      });
      return {
        ...reconciled,
        duplicate: true,
        replayed: true,
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
      };
    }
    return {
      ...replayDepositResponse(claimedHttp.row || queued.row, {
        message: 'Another in-flight attempt already claimed this deposit. A second FinCapture POST was not sent.',
      }),
      spoofFieldsIgnored: spoof,
      applicationUserId: mapping.application_user_id,
    };
  }
  const submitting = claimedHttp.row;

  try {
    await getCheckAltJwt({
      cfg: loadedCfg.cfg,
      credentials: loadedCfg.credentials,
      fetchImpl,
      jwtCache,
    });
    const ssoKey = await resolveSsoKey({
      cfg: loadedCfg.cfg,
      credentials: loadedCfg.credentials,
      acct,
      fetchImpl,
      jwtCache,
    });
    const processBody = buildDepositProcessBody({
      fiKey: loadedCfg.cfg.fi_key,
      ssoKey,
      depositAccountNumber: acct.deposit_account_number,
      captureDateTime: new Date().toISOString(),
      userAmount,
      frontImage: images.frontImage,
      rearImage: images.rearImage,
      performRiskAssessment: true,
    });
    const resp = await checkAltFetch({
      cfg: loadedCfg.cfg,
      credentials: loadedCfg.credentials,
      path: '/fincapture/deposit/process',
      body: processBody,
      fetchImpl,
      jwtCache,
    });
    const { json } = await parseProviderJson(resp);
    const reference = referenceOf(json);
    const apiStatus = Number(json?.status ?? json?.statusCode);
    const isRejected = apiStatus === 120 || /^\s*rejected/i.test(String(json?.status ?? ''));
    const status = !resp.ok
      ? 'error'
      : isRejected
        ? 'rejected'
        : (apiStatus === 40 ? 'pending_approval' : 'submitted');
    let saved;
    try {
      saved = await persistProviderOutcome(client, {
        rowId: submitting.id,
        status,
        reference,
        failureClass: resp.ok ? null : 'provider_error',
        lastError: resp.ok ? null : String(json?.statusDescription || json?.error || 'provider_error').slice(0, 300),
        providerPayload: json,
      });
      await commitDurableAttempt(client, mapping, claims);
    } catch (error) {
      return {
        ok: true,
        statusCode: 200,
        success: Boolean(reference),
        duplicate: false,
        replayed: false,
        liveProviderCalled: true,
        productionExecution: true,
        productionRecordsMutated: true,
        deposit_id: submitting.id,
        checkalt_reference: reference,
        status: 'submitting',
        failure_class: 'db_after_provider',
        userAmount,
        scale: 'integer_cents',
        message: 'Provider accepted or responded but the RDS update failed. Reconcile this row. Do not POST again.',
        recovery: 'POST /functions/v1/checkalt-poll-status with deposit_id. Never retry process.',
        pgCode: error?.code || null,
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
      };
    }
    let autoApprove = null;
    if (saved?.status === 'pending_approval') {
      try {
        autoApprove = await maybeAutoApproveAfterProcess({
          client,
          row: saved,
          acct,
          amountCents: userAmount,
          providerJson: json,
          cfg: loadedCfg.cfg,
          credentials: loadedCfg.credentials,
          fetchImpl,
          commit: () => commitDurableAttempt(client, mapping, claims),
          sleepFn: deps.sleepFn,
          now,
          deadline: autoApproveDeadline({ startedAt: handlerStartedAt, now, deps }),
          requestTimeoutMs: Number.isInteger(deps.autoApproveRequestTimeoutMs)
            ? deps.autoApproveRequestTimeoutMs
            : AUTO_APPROVE_REQUEST_TIMEOUT_MS,
        });
      } catch {
        autoApprove = { attempted: false, approved: false, approvePosted: false, skipReason: 'auto_approve_error' };
      }
      if (autoApprove?.saved) saved = autoApprove.saved;
    }
    return {
      ok: resp.ok && !isRejected,
      statusCode: resp.ok ? 200 : 502,
      success: resp.ok && !isRejected,
      liveProviderCalled: true,
      productionExecution: true,
      productionRecordsMutated: true,
      deposit_id: saved.id,
      checkalt_reference: saved.checkalt_reference,
      status: saved.status,
      approved_at: saved.approved_at ?? null,
      auto_approve: autoApprove
        ? {
          attempted: autoApprove.attempted === true,
          approved: autoApprove.approved === true,
          approvePosted: autoApprove.approvePosted === true,
          skipReason: autoApprove.skipReason || null,
          maxCents: autoApprove.maxCents ?? null,
          policySource: autoApprove.policySource || null,
          persistFailed: autoApprove.persistFailed === true,
        }
        : null,
      userAmount,
      scale: 'integer_cents',
      imagePipeline: images.imagePipeline,
      idempotency_key: idempotencyKey,
      ssoKeySource: 'checkalt_tenant_accounts',
      configSource: 'server_checkalt_config',
      spoofFieldsIgnored: spoof,
      applicationUserId: mapping.application_user_id,
      authUid: mapping.application_user_id,
      cognitoSub: claims.sub,
    };
  } catch (error) {
    if (isProviderNetworkError(error)) {
      await persistProviderOutcome(client, {
        rowId: submitting.id,
        status: 'submitting',
        reference: null,
        failureClass: 'provider_timeout',
        lastError: 'provider_egress_or_timeout',
        providerPayload: { error: 'provider_timeout' },
      }).catch(() => null);
      await commitDurableAttempt(client, mapping, claims).catch(() => null);
      return fail('provider_timeout', 503, {
        deposit_id: submitting.id,
        liveProviderCalled: true,
        productionExecution: true,
        productionRecordsMutated: true,
        failure_class: 'provider_timeout',
        message: 'CheckAlt HTTP did not complete. The durable attempt was kept. Reconcile instead of posting again.',
        spoofFieldsIgnored: spoof,
      });
    }
    throw error;
  }
}
