/**
 * Ports of production CheckAlt Edge Functions.
 * Source: supabase/functions/checkalt-* /index.ts and _shared/checkalt.ts
 *
 * Image pipeline is architecture A, matching successful Lovable deposits:
 *   Browser prepareCheckAltDeposit → AWS downloads prepared storage bytes →
 *   Base64 only. Submit never re-encodes. Client frontImage/rearImage is ignored.
 *
 * Staging uses CHECKALT_UAT_* against https://uatapi.checkalt.com.
 * Auth body remains { userName, password }.
 * Depositor identity is never the API login.
 * Production checkalt_tenant_accounts rows are not overwritten.
 */
import { formatCheckAltUserAmount } from '../amounts.mjs';
import { CHECKALT_UAT_HOST } from '../../sandbox-credentials.mjs';
import { isPlatformAdmin, jsonResult, fail, checkAltParityContext } from './caller.mjs';
import {
  buildDepositProcessBody,
  buildRegisterPayload,
  checkAltFetch,
  extractSsoKey,
  getCheckAltJwt,
  getDepositAccountInfo,
  getUserAccountInfo,
  uatConfigOverlay,
} from './checkalt-client.mjs';
import {
  inspectOriented,
  isAllowedPreparedPath,
  isAlreadyDepositReady,
  isJpegMagic,
  isRasterPath,
  isReusablePreparedCache,
  toDepositPath,
} from './checkalt-image.mjs';

const jwtCache = { token: null, expiresAt: null };
const MAX_TOTAL_B64_CHARS = 1_600_000;

const bytesToBase64 = (bytes) => Buffer.from(bytes).toString('base64');

const isSvgPath = (path) => /\.svg(\?|$)/i.test(String(path || ''));

async function downloadClaimFileBytes(path, deps = {}) {
  if (!path) return null;
  if (typeof deps.downloadClaimFile === 'function') return deps.downloadClaimFile(path);
  const { GetObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
  const { s3KeyFor } = await import('../../storage-paths.mjs');
  const bucket = process.env.FILES_BUCKET;
  if (!bucket) throw new Error('FILES_BUCKET is not configured');
  const key = s3KeyFor('claim-files', path);
  if (!key) throw new Error(`invalid claim-files path: ${path}`);
  const s3 = deps.s3 || new S3Client({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1' });
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const chunk of out.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function downloadPreparedAsB64(bytes, label) {
  if (!bytes || !bytes.length) return null;
  if (!isJpegMagic(bytes)) {
    throw Object.assign(new Error(`${label} prepared image is not a JPEG`), { statusCode: 400, code: 'invalid_jpeg' });
  }
  return bytesToBase64(bytes);
}

async function reusablePreparedBytes(path, deps = {}) {
  const bytes = await downloadClaimFileBytes(path, deps).catch(() => null);
  if (!bytes || bytes.length === 0) return null;
  const info = await inspectOriented(bytes);
  if (!isReusablePreparedCache(info)) return null;
  return bytes;
}

const uatCfg = (uat) => uatConfigOverlay({
  base_url: CHECKALT_UAT_HOST,
  merchant: uat.merchant,
  fi_key: uat.fiKey,
  default_enabled: true,
  cached_jwt: null,
  cached_jwt_expires_at: null,
}, uat);

const credentialsOf = (uat) => ({
  username: uat.username || uat.userId,
  password: uat.password,
  allowConfigJwt: false,
});

const loadUatTenantAccount = async (client, tenantId) => {
  const sandbox = (await client.query(
    `SELECT sandbox_provider_id, metadata
     FROM public.aws_provider_sandbox_objects
     WHERE tenant_id = $1::uuid AND provider = 'checkalt' AND object_type = 'uat_tenant_account'
     ORDER BY created_at DESC NULLS LAST LIMIT 1`,
    [tenantId],
  )).rows[0];
  if (sandbox?.metadata?.sso_user_id && sandbox?.metadata?.deposit_account_number) {
    return {
      tenant_id: tenantId,
      sso_user_id: sandbox.metadata.sso_user_id,
      deposit_account_number: sandbox.metadata.deposit_account_number,
      sso_key: sandbox.metadata.sso_key || sandbox.metadata.sso_user_id,
      source: 'uat_isolated_row',
    };
  }
  return null;
};

const wrap = (handler) => async (event, deps = {}) => {
  const { withIdentityWrite } = await import('../../data.mjs');
  return withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    // Isolated UAT rows live behind request.provider_sandbox RLS (sql/70).
    await client.query('SELECT set_config($1, $2, true)', ['request.provider_sandbox', '1']);
    const ctx = await checkAltParityContext({
      client,
      mapping,
      body,
      requireAdmin: handler.requireAdmin === true,
      loadSandbox: deps.loadSandboxCredentials,
    });
    if (ctx.error) return { ...ctx, spoofFieldsIgnored: spoof, applicationUserId: mapping.application_user_id };
    try {
      const result = await handler.run({
        client, mapping, claims, body, spoof, ctx, fetchImpl: deps.fetchImpl || fetch, deps,
      });
      return {
        ...result,
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
        authUid: mapping.application_user_id,
        cognitoSub: claims.sub,
        productionExecution: false,
        checkaltHost: CHECKALT_UAT_HOST,
      };
    } catch (error) {
      const { isProviderNetworkError, providerEgressFailure } = await import('../../sandbox-credentials.mjs');
      if (isProviderNetworkError(error)) {
        return {
          ...providerEgressFailure('checkalt'),
          spoofFieldsIgnored: spoof,
          applicationUserId: mapping.application_user_id,
        };
      }
      return fail(error.message, 500, {
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
      });
    }
  }, deps);
};

const testConnection = {
  requireAdmin: true,
  run: async ({ ctx, fetchImpl, mapping, client }) => {
    const admin = ctx.isAdmin || await isPlatformAdmin(client, mapping.application_user_id);
    if (!admin) return fail('Admins only', 403);
    const cfg = uatCfg(ctx.uat);
    const creds = credentialsOf(ctx.uat);
    try {
      const jwt = await getCheckAltJwt({ cfg, credentials: creds, fetchImpl, jwtCache });
      return jsonResult({
        success: true,
        message: 'CheckAlt authentication succeeded',
        token_preview: `${String(jwt).slice(0, 12)}\u2026`,
        base_url: cfg.base_url,
        merchant: cfg.merchant,
        liveProviderCalled: true,
        authPath: '/public/fincapture/authenticate',
        authBodyKeys: ['userName', 'password'],
      });
    } catch (e) {
      return jsonResult({ success: false, error: e.message, liveProviderCalled: true }, 200);
    }
  },
};

const registerAccount = {
  requireAdmin: true,
  run: async ({ client, mapping, body, ctx, fetchImpl }) => {
    const tenantId = body.tenant_id || ctx.tenantId;
    if (!tenantId) return fail('tenant_id is required', 400);
    const ssoUserId = String(body.sso_user_id || body.ssoUserId || '').trim()
      || `aws-uat-test-${crypto.randomUUID()}`;
    const fromSecret = String(ctx.uat.depositAccountNumber || '').trim();
    const depositAccountNumber = String(body.deposit_account_number || fromSecret || '').trim();
    if (!depositAccountNumber) {
      return fail('blocked_by_checkalt_test_configuration', 409, {
        classification: 'BLOCKED BY CHECKALT TEST CONFIGURATION',
        message: 'CheckAlt has not provided an approved UAT test deposit account number. Do not invent one. Do not copy production checkalt_tenant_accounts or reuse a production sso_user_id.',
        liveProviderCalled: false,
      });
    }
    if (!ssoUserId) {
      return fail('sso_user_id is required', 400);
    }
    if (ssoUserId === (ctx.uat.username || ctx.uat.userId)) {
      return fail('uat_depositor_must_not_be_api_login', 400, {
        message: 'Production uses a registered FinCapture user id, not CHECKALT_UAT_USER_ID.',
      });
    }
    const cfg = uatCfg(ctx.uat);
    if (!cfg.fi_key) return fail('checkalt_config.fi_key not set', 400);
    const creds = credentialsOf(ctx.uat);
    const payload = buildRegisterPayload({
      fiKey: cfg.fi_key,
      ssoUserId,
      firstName: body.first_name || 'UAT',
      lastName: body.last_name || 'Depositor',
      email: body.email || mapping.email || 'uat@example.com',
      depositAccountNumber,
    });
    const resp = await checkAltFetch({
      cfg, credentials: creds, path: '/fincapture/useraccount/register', body: payload, fetchImpl, jwtCache,
    });
    const respText = await resp.text();
    let respJson;
    try { respJson = JSON.parse(respText); } catch { respJson = { raw: respText }; }
    if (!resp.ok) {
      return fail('CheckAlt registration failed', 502, { status: resp.status, details: respJson, liveProviderCalled: true });
    }
    let ssoKey = null;
    let userAccountPayload = null;
    try {
      const info = await getUserAccountInfo({
        cfg, credentials: creds, ssoUserId, fetchImpl, jwtCache,
      });
      userAccountPayload = info.json;
      if (info.ok) ssoKey = extractSsoKey(info.json, depositAccountNumber);
    } catch { /* non-fatal, same as production */ }
    await client.query(
      `INSERT INTO public.aws_provider_sandbox_objects
        (tenant_id, provider, object_type, sandbox_provider_id, metadata)
       VALUES ($1::uuid, 'checkalt', 'uat_tenant_account', $2, $3::jsonb)
       ON CONFLICT (tenant_id, provider, object_type, sandbox_provider_id)
       DO UPDATE SET metadata = EXCLUDED.metadata`,
      [tenantId, ssoUserId, JSON.stringify({
        sso_user_id: ssoUserId,
        deposit_account_number: depositAccountNumber,
        sso_key: ssoKey,
        first_name: body.first_name,
        last_name: body.last_name,
        email: body.email,
        register_response_keys: respJson && typeof respJson === 'object' ? Object.keys(respJson) : [],
        production_table_written: false,
        isolation: 'aws_provider_sandbox_objects only; production checkalt_tenant_accounts not overwritten',
      })],
    );
    return jsonResult({
      success: true,
      sso_user_id: ssoUserId,
      sso_key: ssoKey,
      liveProviderCalled: true,
      productionRecordsMutated: false,
      warning: ssoKey ? undefined : 'Registration succeeded but CheckAlt did not return an ssoKey. The userId will be used as ssoKey for deposits.',
    });
  },
};

const verifyAccount = {
  requireAdmin: true,
  run: async ({ client, body, ctx, fetchImpl }) => {
    const tenantId = body.tenant_id || ctx.tenantId;
    const action = body.action === 'account' ? 'account' : 'user';
    const acct = await loadUatTenantAccount(client, tenantId);
    if (!acct?.sso_user_id) {
      return fail('No registered CheckAlt UAT account for this tenant. Register in Integration Settings first.', 409, {
        error: 'account_unregistered',
      });
    }
    const cfg = uatCfg(ctx.uat);
    const creds = credentialsOf(ctx.uat);
    const result = action === 'account'
      ? await getDepositAccountInfo({
        cfg, credentials: creds, ssoUserId: acct.sso_user_id, accountNumber: acct.deposit_account_number, fetchImpl, jwtCache,
      })
      : await getUserAccountInfo({
        cfg, credentials: creds, ssoUserId: acct.sso_user_id, fetchImpl, jwtCache,
      });
    return jsonResult({ ...result, success: result.ok, liveProviderCalled: true, userIdSource: 'uat_tenant_sso_user_id' });
  },
};

const accountStatus = {
  run: async ({ client, ctx, fetchImpl }) => {
    const acct = ctx.tenantId ? await loadUatTenantAccount(client, ctx.tenantId) : null;
    if (!acct) {
      return jsonResult({
        success: true,
        registered: false,
        liveProviderCalled: false,
        message: 'No UAT depositor. Production checkalt_tenant_accounts were not used.',
      });
    }
    const cfg = uatCfg(ctx.uat);
    const creds = credentialsOf(ctx.uat);
    const info = await getUserAccountInfo({
      cfg, credentials: creds, ssoUserId: acct.sso_user_id, fetchImpl, jwtCache,
    });
    return jsonResult({
      success: info.ok,
      registered: true,
      liveProviderCalled: true,
      has_sso_key: Boolean(extractSsoKey(info.json, acct.deposit_account_number) || acct.sso_key),
      userIdSource: 'uat_tenant_sso_user_id',
    });
  },
};

const depositHistory = {
  run: async ({ client, ctx, body, fetchImpl }) => {
    const tenantId = body.tenant_id || ctx.tenantId;
    const acct = tenantId ? await loadUatTenantAccount(client, tenantId) : null;
    if (!acct) return fail('No tenant resolved for user', 400);
    const cfg = uatCfg(ctx.uat);
    const creds = credentialsOf(ctx.uat);
    const ssoKey = acct.sso_key || acct.sso_user_id;
    const resp = await checkAltFetch({
      cfg,
      credentials: creds,
      path: '/fincapture/deposit/history',
      body: {
        fiKey: cfg.fi_key,
        ssoKey,
        startDate: body.start_date || undefined,
        endDate: body.end_date || undefined,
      },
      fetchImpl,
      jwtCache,
    });
    const raw = await resp.text();
    let json;
    try { json = JSON.parse(raw); } catch { json = { raw }; }
    return jsonResult({ success: resp.ok, data: json, liveProviderCalled: true, ssoKeySource: 'uat_tenant_account' });
  },
};

const resolvePollStatus = (json) => {
  const numeric = Number(json?.statusCode ?? json?.status);
  if (numeric === 40) return 'pending_approval';
  if (numeric === 120) return 'rejected';
  if (numeric === 127) return 'submitted';
  if (numeric === 200) return 'cleared';
  const raw = String(json?.status ?? '').toLowerCase();
  if (['submitted', 'pending'].includes(raw)) return 'submitted';
  if (raw === 'pending_approval') return 'pending_approval';
  if (['approved', 'cleared', 'settled'].includes(raw)) return 'cleared';
  if (raw === 'returned') return 'returned';
  if (['rejected', 'declined'].includes(raw)) return 'rejected';
  return null;
};

const pollStatus = {
  run: async ({ client, ctx, fetchImpl }) => {
    const acct = ctx.tenantId ? await loadUatTenantAccount(client, ctx.tenantId) : null;
    const ops = (await client.query(
      `SELECT id, provider_reference, metadata FROM public.aws_provider_sandbox_operations
       WHERE provider = 'checkalt' AND tenant_id = $1::uuid AND provider_reference IS NOT NULL
       ORDER BY created_at DESC NULLS LAST LIMIT 50`,
      [ctx.tenantId],
    )).rows;
    const cfg = uatCfg(ctx.uat);
    const creds = credentialsOf(ctx.uat);
    let polled = 0;
    let updated = 0;
    let errors = 0;
    for (const op of ops) {
      polled += 1;
      try {
        const ssoKey = op.metadata?.sso_key || acct?.sso_key || acct?.sso_user_id;
        const itemBody = {
          fiKey: cfg.fi_key,
          ...(ssoKey ? { ssoKey } : {}),
          referenceNumber: Number(op.provider_reference),
        };
        const resp = await checkAltFetch({
          cfg, credentials: creds, path: '/fincapture/deposit/item', body: itemBody, fetchImpl, jwtCache,
        });
        const raw = await resp.text();
        let json;
        try { json = JSON.parse(raw); } catch { json = { raw }; }
        let status = resolvePollStatus(json);
        if (!status) {
          const hist = await checkAltFetch({
            cfg,
            credentials: creds,
            path: '/fincapture/deposit/history',
            body: { fiKey: cfg.fi_key, ...(ssoKey ? { ssoKey } : {}) },
            fetchImpl,
            jwtCache,
          });
          const histRaw = await hist.text();
          let histJson;
          try { histJson = JSON.parse(histRaw); } catch { histJson = { raw: histRaw }; }
          const items = histJson?.items || histJson?.data || histJson?.deposits || [];
          const match = Array.isArray(items)
            ? items.find((row) => String(row?.referenceNumber ?? row?.reference) === String(op.provider_reference))
            : null;
          if (match) {
            json = { ...json, history: match };
            status = resolvePollStatus(match);
          }
        }
        if (resp.ok || status) {
          updated += 1;
          await client.query(
            `UPDATE public.aws_provider_sandbox_operations
             SET status = $2, metadata = metadata || $3::jsonb, updated_at = now()
             WHERE id = $1::uuid`,
            [op.id, status || 'submitted', JSON.stringify({ last_poll: json, poll_source: status ? 'item_or_history' : 'item' })],
          ).catch(() => {});
        }
      } catch {
        errors += 1;
      }
    }
    return jsonResult({
      polled, updated, errors, success: true, liveProviderCalled: polled > 0,
      productionRecordsMutated: false,
      note: 'UAT poll uses POST /fincapture/deposit/item with fiKey + ssoKey + referenceNumber, then history fallback like production. Isolated rows only.',
    });
  },
};

const submitDeposit = {
  run: async ({ client, mapping, body, ctx, fetchImpl, deps = {} }) => {
    const checkId = body.check_intake_item_id;
    if (!checkId) return fail('check_intake_item_id is required', 400);
    const check = (await client.query(
      `SELECT id, tenant_id, amount, check_number, front_image_path, back_image_path, back_image_deposit_path, status
       FROM public.check_intake_items WHERE id = $1::uuid`,
      [checkId],
    )).rows[0];
    if (!check) return fail('Check not found', 404);
    if (check.tenant_id !== ctx.tenantId && !ctx.isAdmin) return fail('Forbidden', 403);
    const tenantId = check.tenant_id;
    const acct = await loadUatTenantAccount(client, tenantId);
    if (!acct?.sso_user_id || !acct?.deposit_account_number) {
      return fail('No registered CheckAlt account for this tenant. Register in Integration Settings first.', 409, {
        error: 'account_unregistered',
      });
    }
    const formatted = formatCheckAltUserAmount(check.amount);
    if (formatted?.error) return fail(formatted.message || 'invalid_amount', 400);
    const userAmount = formatted.userAmount;
    const ssoKey = acct.sso_key || acct.sso_user_id;
    const depositFrontPath = body.deposit_front_path || null;
    const depositBackPath = body.deposit_back_path || null;
    if (isSvgPath(check.back_image_path) && !check.back_image_deposit_path && !depositBackPath) {
      return fail('Back image needs an approved deposit JPEG before submission. Generate and approve the deposit image before depositing.', 400);
    }
    if (check.back_image_path && !check.back_image_deposit_path && !depositBackPath && !isRasterPath(check.back_image_path)) {
      return fail('Back image needs an approved deposit JPEG before submission. Generate and approve the deposit image before depositing.', 400);
    }
    // Architecture A: ignore client-supplied image bytes. Lovable BodySchema
    // never accepts frontImage/rearImage; AWS must not either.
    if (depositFrontPath && !isAllowedPreparedPath(check, depositFrontPath)) {
      return fail('Prepared front image path is not allowed for this check', 403, { error: 'prepared_path_denied' });
    }
    if (depositBackPath && !isAllowedPreparedPath(check, depositBackPath)) {
      return fail('Prepared back image path is not allowed for this check', 403, { error: 'prepared_path_denied' });
    }
    const frontPath = depositFrontPath || check.front_image_path;
    const frontBytes = await downloadClaimFileBytes(frontPath, deps);
    if (!frontBytes) return fail('Front image required for CheckAlt submission', 400);
    if (!isJpegMagic(frontBytes)) return fail('Front prepared image is not a JPEG', 400);
    if (!depositFrontPath) {
      const frontInfo = await inspectOriented(frontBytes);
      if (!isAlreadyDepositReady(frontInfo)) {
        return fail(
          'Front check image must be prepared in the browser before submission.',
          400,
          { error: 'browser_prepare_required', side: 'front' },
        );
      }
    }
    let frontImage;
    try {
      frontImage = await downloadPreparedAsB64(frontBytes, 'front');
    } catch (error) {
      return fail(error.message, error.statusCode || 400, { error: error.code || 'invalid_jpeg' });
    }
    let rearImage = null;
    const backPath = depositBackPath || check.back_image_deposit_path || check.back_image_path;
    if (backPath && !isSvgPath(backPath)) {
      const backBytes = await downloadClaimFileBytes(backPath, deps);
      if (backBytes) {
        if (!isJpegMagic(backBytes)) return fail('Back prepared image is not a JPEG', 400);
        if (!depositBackPath) {
          const backInfo = await inspectOriented(backBytes);
          if (!isAlreadyDepositReady(backInfo)) {
            return fail(
              'Back check image must be prepared in the browser before submission.',
              400,
              { error: 'browser_prepare_required', side: 'back' },
            );
          }
        }
        try {
          rearImage = await downloadPreparedAsB64(backBytes, 'back');
        } catch (error) {
          return fail(error.message, error.statusCode || 400, { error: error.code || 'invalid_jpeg' });
        }
      }
    }
    if (!frontImage) return fail('Front image required for CheckAlt submission', 400);
    const totalB64 = String(frontImage).length + String(rearImage || '').length;
    if (totalB64 > MAX_TOTAL_B64_CHARS) {
      return fail('Combined check images still exceed CheckAlt\'s limit after compression. Please reupload smaller front/back images.', 400);
    }
    const queued = (await client.query(
      `INSERT INTO public.aws_provider_sandbox_operations
        (tenant_id, application_user_id, operation_type, provider, amount_cents, currency,
         idempotency_key, status, sandbox_http_called, production_execution, metadata)
       VALUES ($1::uuid, $2::uuid, 'checkalt_submit_deposit', 'checkalt', $3, 'USD', $4, 'queued', false, false, $5::jsonb)
       RETURNING *`,
      [
        tenantId,
        mapping.application_user_id,
        userAmount,
        `checkalt-submit-${checkId}`,
        JSON.stringify({
          check_intake_item_id: checkId,
          userAmount,
          scale: 'integer_cents',
          sso_key: ssoKey,
          production_table_written: false,
          imagePipeline: 'browser_prepare_aws_base64',
        }),
      ],
    )).rows[0];
    const cfg = uatCfg(ctx.uat);
    const creds = credentialsOf(ctx.uat);
    const processBody = buildDepositProcessBody({
      fiKey: cfg.fi_key,
      ssoKey,
      depositAccountNumber: acct.deposit_account_number,
      captureDateTime: new Date().toISOString(),
      userAmount,
      frontImage,
      rearImage,
      performRiskAssessment: true,
    });
    const resp = await checkAltFetch({
      cfg,
      credentials: creds,
      path: '/fincapture/deposit/process',
      body: processBody,
      fetchImpl,
      jwtCache,
    });
    const raw = await resp.text();
    let json;
    try { json = JSON.parse(raw); } catch { json = { raw }; }
    const reference = json?.referenceNumber != null ? String(json.referenceNumber) : (json?.reference ?? null);
    const apiStatus = Number(json?.status ?? json?.statusCode);
    const isRejected = apiStatus === 120 || /^\s*rejected/i.test(String(json?.status ?? ''));
    const status = !resp.ok ? 'error' : isRejected ? 'rejected' : (apiStatus === 40 ? 'pending_approval' : 'submitted');
    await client.query(
      `UPDATE public.aws_provider_sandbox_operations
       SET status = $2, sandbox_http_called = true, provider_reference = $3, metadata = metadata || $4::jsonb, updated_at = now()
       WHERE id = $1::uuid`,
      [queued.id, status, reference, JSON.stringify({ response_keys: json && typeof json === 'object' ? Object.keys(json) : [] })],
    );
    return jsonResult({
      success: resp.ok && !isRejected,
      liveProviderCalled: true,
      productionRecordsMutated: false,
      userAmount,
      scale: 'integer_cents',
      reference,
      status,
      ssoKeySource: 'uat_tenant_account',
      deposit_id: queued.id,
      imagePipeline: 'browser_prepare_aws_base64',
      data: json,
    }, resp.ok ? 200 : 502);
  },
};

const approveDeposit = {
  requireAdmin: true,
  run: async ({ client, body, ctx, fetchImpl }) => {
    const actionName = body.action === 'reject' ? 'reject' : (body.action === 'approve' ? 'approve' : null);
    if (!actionName) return fail('action must be approve or reject', 400);
    let op = null;
    let reference = body.referenceNumber || body.checkalt_reference || null;
    if (body.deposit_id) {
      op = (await client.query(
        `SELECT id, tenant_id, provider_reference, status, metadata
         FROM public.aws_provider_sandbox_operations
         WHERE id = $1::uuid AND provider = 'checkalt' LIMIT 1`,
        [body.deposit_id],
      )).rows[0];
      if (!op) return fail('Deposit not found', 404);
      if (op.tenant_id !== ctx.tenantId && !ctx.isAdmin) return fail('Forbidden', 403);
      reference = op.provider_reference;
      const cancellable = actionName === 'reject' && ['submitted', 'pending', 'processing'].includes(op.status ?? '');
      if (op.status !== 'pending_approval' && !cancellable) {
        return fail(`Deposit is in '${op.status}' status, not pending_approval`, 409);
      }
    }
    if (!reference) return fail('Deposit has no CheckAlt reference yet — cannot approve/reject', 400);
    const cfg = uatCfg(ctx.uat);
    const creds = credentialsOf(ctx.uat);
    const payload = {
      fiKey: cfg.fi_key,
      referenceNumber: Number(reference),
      action: actionName === 'approve' ? 1 : 2,
    };
    if (actionName === 'approve') {
      if (body.approved_amount !== undefined) payload.approvedAmount = body.approved_amount;
      if (body.micr_account_number) payload.checkAccountNumber = body.micr_account_number;
    } else {
      payload.rejectCode = body.reject_code ?? 1721;
      if (body.reject_notes) payload.rejectNotes = body.reject_notes;
    }
    const resp = await checkAltFetch({
      cfg, credentials: creds, path: '/fincapture/deposit/approve', body: payload, fetchImpl, jwtCache,
    });
    const raw = await resp.text();
    let json;
    try { json = JSON.parse(raw); } catch { json = { raw }; }
    if (!resp.ok) {
      return fail('CheckAlt approval call failed', 502, { status: resp.status, details: json, liveProviderCalled: true });
    }
    if (json?.success !== true) {
      return fail('CheckAlt did not confirm the approval', 502, {
        status: json?.status ?? null,
        status_description: json?.statusDescription ?? null,
        details: json,
        liveProviderCalled: true,
      });
    }
    const apiStatusText = `${json?.status ?? ''} ${json?.statusDescription ?? ''}`.toLowerCase();
    let internalStatus = actionName === 'approve' ? 'submitted' : 'rejected';
    if (apiStatusText.includes('reject')) internalStatus = 'rejected';
    else if (apiStatusText.includes('approv') || apiStatusText.includes('submit')) internalStatus = 'submitted';
    if (op) {
      await client.query(
        `UPDATE public.aws_provider_sandbox_operations
         SET status = $2, metadata = metadata || $3::jsonb, updated_at = now()
         WHERE id = $1::uuid`,
        [op.id, internalStatus, JSON.stringify({ last_approve: json, production_table_written: false })],
      ).catch(() => {});
    }
    return jsonResult({
      success: true,
      status: internalStatus,
      status_description: json?.statusDescription ?? null,
      api_status: json?.status ?? null,
      data: json,
      liveProviderCalled: true,
      productionRecordsMutated: false,
    });
  },
};

const prepareImage = {
  run: async ({ client, body, ctx, deps = {} }) => {
    if (!body.check_intake_item_id) return fail('check_intake_item_id is required', 400);
    const side = body.side === 'back' ? 'back' : (body.side === 'front' ? 'front' : null);
    if (!side) return fail('side must be front or back', 400);
    const check = (await client.query(
      `SELECT id, tenant_id, front_image_path, back_image_path, back_image_deposit_path
       FROM public.check_intake_items WHERE id = $1::uuid`,
      [body.check_intake_item_id],
    )).rows[0];
    if (!check) return fail('Check not found', 404);
    if (check.tenant_id !== ctx.tenantId && !ctx.isAdmin) return fail('Forbidden', 403);
    const sourcePath = side === 'front'
      ? check.front_image_path
      : (check.back_image_deposit_path || check.back_image_path);
    if (!sourcePath) return fail(`${side} image path is missing`, 400);
    if (isSvgPath(sourcePath) && side === 'back') {
      return fail('Back image needs an approved deposit JPEG before submission. Generate and approve the deposit image before depositing.', 400);
    }
    if (side === 'back' && !check.back_image_deposit_path && !isRasterPath(sourcePath)) {
      return fail('Back image needs an approved deposit JPEG before submission. Generate and approve the deposit image before depositing.', 400);
    }
    const preparedPath = toDepositPath(sourcePath);
    const cached = await reusablePreparedBytes(preparedPath, deps);
    if (cached) {
      return jsonResult({
        success: true,
        prepared_path: preparedPath,
        cached: true,
        liveProviderCalled: false,
        bytes: cached.length,
      });
    }
    const bytes = await downloadClaimFileBytes(sourcePath, deps);
    if (!bytes) return fail(`${side} image download failed`, 404);
    const sourceInfo = await inspectOriented(bytes);
    // Browser alreadyGood: return the original storage path, do not re-encode.
    if (isAlreadyDepositReady(sourceInfo)) {
      return jsonResult({
        success: true,
        prepared_path: sourcePath,
        cached: false,
        passthrough: true,
        liveProviderCalled: false,
        bytes: bytes.length,
        source_bytes: bytes.length,
      });
    }
    // Architecture A: AWS does not clone the browser JPEG encoder. Command
    // Center / deposit ops run prepareCheckAltDeposit in the browser; this
    // function only reuses an already-good original or a cached .deposit2.jpg.
    return fail(
      'Check image must be prepared in the browser before submission.',
      409,
      { error: 'browser_prepare_required', side, source_bytes: bytes.length },
    );
  },
};

export const CHECKALT_PARITY_HANDLERS = {
  'checkalt-test-connection': wrap(testConnection),
  'checkalt-register-account': wrap(registerAccount),
  'checkalt-verify-account': wrap(verifyAccount),
  'checkalt-account-status': wrap(accountStatus),
  'checkalt-deposit-history': wrap(depositHistory),
  'checkalt-poll-status': wrap(pollStatus),
  'checkalt-submit-deposit': wrap(submitDeposit),
  'checkalt-approve-deposit': wrap(approveDeposit),
  'checkalt-prepare-image': wrap(prepareImage),
};
