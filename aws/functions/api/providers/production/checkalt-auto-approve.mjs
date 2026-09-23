/**
 * Post-process CheckAlt auto-approval (legacy Lovable parity, fail-closed ceiling).
 *
 * CheckAlt process status 40 always requires a second /deposit/approve call.
 * ChecksOps may make that call only after a successful process that parked the
 * item, when tenant-over-global auto_approve_enabled is true, the item is clean,
 * and auto_approve_max_cents is an integer ceiling in cents with amount <= ceiling.
 *
 * NULL ceiling does NOT mean unlimited. Legacy Lovable treated null as no limit.
 * Isolated production currently has Freedom enabled=true with null cents while
 * the operator intends $2,000. AWS therefore skips with missing_auto_approve_ceiling
 * instead of auto-approving every clean deposit.
 *
 * Never POSTs /deposit/process. Never inserts a deposit. Existing reference stays
 * authoritative. Provider/lock ambiguity leaves pending_approval.
 */

export const AUTO_APPROVE_MAX_ATTEMPTS = 5;
export const AUTO_APPROVE_BACKOFF_MS = Object.freeze([1500, 2500, 4000, 6000, 8000]);

const FLAG_TEXT_RE = /duplicate|fraud|risk|exception|warning|hold|suspect|mismatch|unreadable/;

export const asOptionalCents = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const cents = Number(value);
  if (!Number.isInteger(cents) || cents < 0) return null;
  return cents;
};

export const resolveAutoApprovePolicy = (tenant = null, globalCfg = null) => {
  const enabled = tenant?.auto_approve_enabled ?? globalCfg?.auto_approve_enabled ?? false;
  const maxCents = asOptionalCents(tenant?.auto_approve_max_cents)
    ?? asOptionalCents(globalCfg?.auto_approve_max_cents);
  return {
    enabled: Boolean(enabled),
    maxCents,
    source: tenant ? 'checkalt_tenant_accounts' : (globalCfg ? 'checkalt_config' : 'none'),
  };
};

export const depositIsFlagged = (providerJson = {}) => {
  const json = providerJson && typeof providerJson === 'object' ? providerJson : {};
  if (Array.isArray(json.exceptions) && json.exceptions.length > 0) return true;
  if (Array.isArray(json.warnings) && json.warnings.length > 0) return true;
  if (Array.isArray(json.riskFactors) && json.riskFactors.length > 0) return true;
  if (Array.isArray(json.errors) && json.errors.length > 0) return true;
  if (json.amountDiscrepancyDetected === true || json.amountDiscrepancyDetected === 'true') return true;
  const riskRating = json.riskRating;
  if (typeof riskRating === 'number' && riskRating > 0) return true;
  const flagText = [
    json.statusDescription,
    json.riskRating,
    json.riskRatingDescription,
    JSON.stringify(json.warnings ?? ''),
    JSON.stringify(json.exceptions ?? ''),
    JSON.stringify(json.messages ?? ''),
    JSON.stringify(json.errors ?? ''),
  ].join(' ').toLowerCase();
  return FLAG_TEXT_RE.test(flagText);
};

export const decideAutoApprove = ({
  processRequiresApproval = false,
  reference = null,
  enabled = false,
  maxCents = null,
  amountCents = null,
  flagged = false,
} = {}) => {
  if (!processRequiresApproval) {
    return { approve: false, skipReason: 'not_pending_approval' };
  }
  if (!reference) {
    return { approve: false, skipReason: 'missing_reference' };
  }
  if (!enabled) {
    return { approve: false, skipReason: 'auto_approve_disabled' };
  }
  if (flagged) {
    return { approve: false, skipReason: 'flagged_by_checkalt' };
  }
  if (!Number.isInteger(Number(amountCents))) {
    return { approve: false, skipReason: 'invalid_amount' };
  }
  if (maxCents == null) {
    return { approve: false, skipReason: 'missing_auto_approve_ceiling' };
  }
  if (!Number.isInteger(Number(maxCents)) || Number(maxCents) < 0) {
    return { approve: false, skipReason: 'missing_auto_approve_ceiling' };
  }
  if (Number(amountCents) > Number(maxCents)) {
    return { approve: false, skipReason: 'over_max_amount' };
  }
  return { approve: true, skipReason: null };
};

export const isCheckAltApproveLockError = (status, json = {}) => {
  if (Number(status) !== 404) return false;
  const msg = String(json?.message ?? json?.statusDescription ?? '').toLowerCase();
  return msg.includes('locate transaction') || msg.includes('locked');
};

export const approveSucceeded = (resp, json) => Boolean(resp?.ok && json?.success === true);

export async function loadAutoApprovePolicy(client, tenantId) {
  let tenant = null;
  if (tenantId) {
    tenant = (await client.query(
      `SELECT auto_approve_enabled, auto_approve_max_cents
       FROM public.checkalt_tenant_accounts
       WHERE tenant_id = $1::uuid
       LIMIT 1`,
      [tenantId],
    )).rows[0] || null;
  }
  let globalCfg = null;
  try {
    globalCfg = (await client.query(
      `SELECT auto_approve_enabled, auto_approve_max_cents
       FROM public.checkalt_config
       WHERE singleton IS TRUE
       LIMIT 1`,
    )).rows[0] || null;
  } catch {
    globalCfg = null;
  }
  return resolveAutoApprovePolicy(tenant, globalCfg);
}

export async function requestCheckAltApprove({
  checkAltFetch,
  cfg,
  credentials,
  fetchImpl,
  jwtCache,
  reference,
  fiKey,
}) {
  return checkAltFetch({
    cfg,
    credentials,
    path: '/fincapture/deposit/approve',
    body: {
      fiKey,
      referenceNumber: Number(reference),
      action: 1,
    },
    fetchImpl,
    jwtCache,
  });
}

export async function attemptAutoApproveWithLockRetry({
  checkAltFetch,
  cfg,
  credentials,
  fetchImpl,
  jwtCache,
  reference,
  fiKey,
  parseProviderJson,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let lastJson = null;
  let lastStatus = 0;
  for (let attempt = 0; attempt < AUTO_APPROVE_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await sleepFn(AUTO_APPROVE_BACKOFF_MS[attempt - 1] ?? 8000);
    }
    try {
      const resp = await requestCheckAltApprove({
        checkAltFetch,
        cfg,
        credentials,
        fetchImpl,
        jwtCache,
        reference,
        fiKey,
      });
      const parsed = await parseProviderJson(resp);
      lastJson = parsed.json;
      lastStatus = resp.status;
      if (approveSucceeded(resp, lastJson)) {
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

export async function maybeAutoApproveAfterProcess({
  client,
  rowId,
  tenantId,
  amountCents,
  processStatus,
  reference,
  providerJson,
  checkAltFetch,
  cfg,
  credentials,
  fetchImpl,
  jwtCache,
  parseProviderJson,
  persistAutoApproveOutcome,
  sleepFn,
} = {}) {
  const processRequiresApproval = processStatus === 'pending_approval';
  const flagged = depositIsFlagged(providerJson);
  const policy = await loadAutoApprovePolicy(client, tenantId);
  const decision = decideAutoApprove({
    processRequiresApproval,
    reference,
    enabled: policy.enabled,
    maxCents: policy.maxCents,
    amountCents,
    flagged,
  });
  if (!processRequiresApproval || !reference) {
    return {
      attempted: false,
      approved: false,
      skipReason: decision.skipReason,
      approvePosted: false,
      policy,
    };
  }
  if (!decision.approve) {
    const saved = await persistAutoApproveOutcome(client, {
      rowId,
      approved: false,
      skipReason: decision.skipReason,
    }).catch(() => null);
    return {
      attempted: false,
      approved: false,
      skipReason: decision.skipReason,
      approvePosted: false,
      policy,
      saved,
    };
  }
  const result = await attemptAutoApproveWithLockRetry({
    checkAltFetch,
    cfg,
    credentials,
    fetchImpl,
    jwtCache,
    reference,
    fiKey: cfg?.fi_key,
    parseProviderJson,
    sleepFn,
  });
  let saved = null;
  try {
    saved = await persistAutoApproveOutcome(client, {
      rowId,
      approved: result.approved === true,
      skipReason: result.approved ? null : result.skipReason,
      approvePayload: result.json,
    });
  } catch {
    saved = null;
  }
  return {
    attempted: true,
    approved: result.approved === true,
    skipReason: result.approved ? null : result.skipReason,
    approvePosted: true,
    persistFailed: result.approved === true && !saved,
    policy,
    attempts: result.attempts,
    json: result.json,
    saved,
  };
}
