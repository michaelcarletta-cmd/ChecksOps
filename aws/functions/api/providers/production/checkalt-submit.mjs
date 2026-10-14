import { formatCheckAltUserAmount, rejectUntrustedAmountFields, validateProviderCents } from '../amounts.mjs';
import { ignoredOwnershipSpoof, verifyOwnershipChain } from '../../financial-ownership.mjs';
import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { isProviderNetworkError } from '../../sandbox-credentials.mjs';
import { buildDepositProcessBody, checkAltFetch, extractSsoKey, getCheckAltJwt, getUserAccountInfo } from '../parity/checkalt-client.mjs';
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
import { reconcileProductionCheckAltDeposit } from './checkalt-poll.mjs';

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
 * Post-process auto-approval (Cursor PR #433 port, fail-closed ceiling).
 *
 * CheckAlt process status 40 (pending_approval) needs a second
 * /fincapture/deposit/approve call. The submit flow makes that call itself only
 * after its own committed /deposit/process parked the item, and only when the
 * tenant policy is enabled, auto_approve_max_cents is a set integer ceiling, the
 * server-side amount is at or below it, and CheckAlt did not flag the item.
 * A blank ceiling does NOT mean unlimited. It never POSTs /deposit/process, never
 * inserts a deposit, and never requires or satisfies the manual-approve TOTP (checkalt-approve.mjs).
 * Replays never reach it (they return before any provider HTTP). Any provider,
 * lock or persist ambiguity leaves the row pending_approval for a Manager.
 */
export const AUTO_APPROVE_MAX_ATTEMPTS = 5;
export const AUTO_APPROVE_BACKOFF_MS = Object.freeze([1500, 2500, 4000, 6000, 8000]);

const AUTO_APPROVE_FLAG_TEXT_RE = /duplicate|fraud|risk|exception|warning|hold|suspect|mismatch|unreadable/;

const optionalCents = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const cents = Number(value);
  return Number.isInteger(cents) && cents >= 0 ? cents : null;
};

/** Tenant row wins as a whole when present; the global row is used only without one. */
export const resolveAutoApprovePolicy = (tenant = null, globalCfg = null) => {
  const source = tenant ? 'checkalt_tenant_accounts' : (globalCfg ? 'checkalt_config' : 'none');
  const row = tenant || globalCfg || null;
  return {
    enabled: row?.auto_approve_enabled === true,
    maxCents: optionalCents(row?.auto_approve_max_cents),
    source,
  };
};

export const depositIsFlagged = (providerJson = {}) => {
  const json = providerJson && typeof providerJson === 'object' ? providerJson : {};
  for (const key of ['exceptions', 'warnings', 'riskFactors', 'errors']) {
    if (Array.isArray(json[key]) && json[key].length > 0) return true;
  }
  if (json.amountDiscrepancyDetected === true || json.amountDiscrepancyDetected === 'true') return true;
  // Clean process-40 payloads carry riskRating / riskRatingDescription; do not regex those.
  const flagText = [
    json.statusDescription,
    JSON.stringify(json.warnings ?? ''),
    JSON.stringify(json.exceptions ?? ''),
  ].join(' ').toLowerCase();
  return AUTO_APPROVE_FLAG_TEXT_RE.test(flagText);
};

export const decideAutoApprove = ({
  processRequiresApproval = false,
  reference = null,
  enabled = false,
  maxCents = null,
  amountCents = null,
  flagged = false,
} = {}) => {
  if (!processRequiresApproval) return { approve: false, skipReason: 'not_pending_approval' };
  if (!reference) return { approve: false, skipReason: 'missing_reference' };
  if (enabled !== true) return { approve: false, skipReason: 'auto_approve_disabled' };
  if (flagged) return { approve: false, skipReason: 'flagged_by_checkalt' };
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { approve: false, skipReason: 'invalid_amount' };
  if (!Number.isInteger(maxCents) || maxCents < 0) return { approve: false, skipReason: 'missing_auto_approve_ceiling' };
  if (amountCents > maxCents) return { approve: false, skipReason: 'over_max_amount' };
  return { approve: true, skipReason: null };
};

export const isCheckAltApproveLockError = (status, json = {}) => {
  if (Number(status) !== 404) return false;
  const msg = String(json?.message ?? json?.statusDescription ?? '').toLowerCase();
  return msg.includes('locate transaction') || msg.includes('locked');
};

/** Retries only HTTP 404 + locate/locked (CheckAlt has not accepted the approve). */
export async function attemptAutoApproveWithLockRetry({
  cfg,
  credentials,
  fetchImpl,
  reference,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let lastJson = null;
  let lastStatus = 0;
  for (let attempt = 0; attempt < AUTO_APPROVE_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleepFn(AUTO_APPROVE_BACKOFF_MS[attempt - 1] ?? 8000);
    try {
      const resp = await checkAltFetch({
        cfg,
        credentials,
        path: '/fincapture/deposit/approve',
        body: { fiKey: cfg.fi_key, referenceNumber: Number(reference), action: 1 },
        fetchImpl,
        jwtCache,
      });
      lastJson = (await parseProviderJson(resp)).json;
      lastStatus = resp.status;
      if (resp.ok && lastJson?.success === true) {
        return { approved: true, json: lastJson, status: lastStatus, attempts: attempt + 1 };
      }
      if (!isCheckAltApproveLockError(lastStatus, lastJson)) {
        return {
          approved: false,
          json: lastJson,
          status: lastStatus,
          attempts: attempt + 1,
          skipReason: `auto_approve_failed:${lastJson?.statusDescription ?? lastJson?.message ?? lastStatus}`,
        };
      }
    } catch (error) {
      return {
        approved: false,
        json: lastJson,
        status: lastStatus,
        attempts: attempt + 1,
        skipReason: `auto_approve_error:${String(error?.message || error).slice(0, 180)}`,
      };
    }
  }
  return {
    approved: false,
    json: lastJson,
    status: lastStatus,
    attempts: AUTO_APPROVE_MAX_ATTEMPTS,
    skipReason: `auto_approve_failed:${lastJson?.statusDescription ?? lastJson?.message ?? lastStatus}`,
  };
}

/** Never throws. Persist failures and provider errors leave pending_approval. */
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
} = {}) {
  const policy = resolveAutoApprovePolicy(acct || null, null);
  const decision = decideAutoApprove({
    processRequiresApproval: row?.status === 'pending_approval',
    reference: row?.checkalt_reference || null,
    enabled: policy.enabled,
    maxCents: policy.maxCents,
    amountCents,
    flagged: depositIsFlagged(providerJson),
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
      saved = await persistAutoApproveOutcome(client, {
        rowId: row.id,
        phase: 'skipped',
        skipReason: decision.skipReason,
        maxCents: policy.maxCents,
      });
      await commit();
    } catch {
      saved = null;
    }
    return result({ saved });
  }

  // Durable evidence before the approve POST. If it cannot be written, do not POST.
  try {
    await persistAutoApproveOutcome(client, { rowId: row.id, phase: 'attempting', maxCents: policy.maxCents });
    await commit();
  } catch {
    return result({ skipReason: 'auto_approve_persist_failed' });
  }

  const outcome = await attemptAutoApproveWithLockRetry({
    cfg,
    credentials,
    fetchImpl,
    reference: row.checkalt_reference,
    sleepFn,
  });
  let saved = null;
  try {
    saved = await persistAutoApproveOutcome(client, {
      rowId: row.id,
      phase: 'outcome',
      approved: outcome.approved === true,
      skipReason: outcome.approved ? null : outcome.skipReason,
      approvePayload: outcome.json,
      attempts: outcome.attempts,
      maxCents: policy.maxCents,
    });
    await commit();
  } catch {
    saved = null;
  }
  return result({
    attempted: true,
    approved: outcome.approved === true,
    approvePosted: true,
    skipReason: outcome.approved ? null : outcome.skipReason,
    attempts: outcome.attempts,
    persistFailed: !saved,
    saved,
  });
}

async function resolveSsoKey({ cfg, credentials, acct, fetchImpl }) {
  if (acct.sso_key && acct.sso_key !== acct.sso_user_id) return acct.sso_key;
  try {
    const info = await getUserAccountInfo({
      cfg,
      credentials,
      ssoUserId: acct.sso_user_id,
      fetchImpl,
      jwtCache,
    });
    const extracted = extractSsoKey(info.json, acct.deposit_account_number);
    if (extracted) return extracted;
  } catch {
    /* depositor lookup is best-effort; sso_user_id is the production fallback */
  }
  return acct.sso_key || acct.sso_user_id;
}

export async function handleProductionCheckAltSubmit({
  client,
  mapping,
  claims,
  body,
  spoof,
  fetchImpl = fetch,
  deps = {},
} = {}) {
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
