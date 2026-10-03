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
import { maybeAutoApproveAfterProcess } from './checkalt-auto-approve.mjs';
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
    if (saved.status === 'pending_approval' && saved.checkalt_reference) {
      autoApprove = await maybeAutoApproveAfterProcess({
        client,
        rowId: saved.id,
        tenantId: check.tenant_id,
        amountCents: userAmount,
        processStatus: saved.status,
        reference: saved.checkalt_reference,
        providerJson: json,
        checkAltFetch,
        cfg: loadedCfg.cfg,
        credentials: loadedCfg.credentials,
        fetchImpl,
        jwtCache,
        parseProviderJson,
        persistAutoApproveOutcome,
        sleepFn: deps.sleepFn,
      });
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
      auto_approve: autoApprove
        ? {
          attempted: autoApprove.attempted === true,
          approved: autoApprove.approved === true,
          skipReason: autoApprove.skipReason || null,
          approvePosted: autoApprove.approvePosted === true,
          maxCents: autoApprove.policy?.maxCents ?? null,
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
