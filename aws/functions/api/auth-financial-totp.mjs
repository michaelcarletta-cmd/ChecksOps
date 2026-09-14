/**
 * Application-level financial TOTP handlers.
 * Does not call Cognito software-token or MFA-preference APIs.
 * Login remains EMAIL_OTP / WebAuthn. Money flags stay off.
 */
import { flagTrue } from './ops-readiness.mjs';
import { evaluatePrivilegedEnrollment, privilegedAuthPolicy } from './privileged-auth.mjs';
import { normalizeTotpCode, totpUserFailureMessage } from './auth-totp-code.mjs';
import { getSecretStringFromAws } from './secrets.mjs';
import { withIdentityWrite } from './data.mjs';
import { loginSessionIdFromClaims } from './cognito.mjs';
import {
  encryptSecret,
  decryptSecret,
  enrollmentResponseWithoutSecret,
  evaluateFinancialTotpEnrollment,
  generateTotpSecret,
  otpauthUri,
  verifyFinancialTotp,
  wrapKeyFromHex,
} from './financial-totp.mjs';

const parseBody = (event) => {
  if (!event?.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (typeof raw !== 'string') return raw && typeof raw === 'object' ? raw : {};
  try { return JSON.parse(raw); } catch { return {}; }
};

const financialGate = () => ({
  financialPermissionsActivated: flagTrue('AWS_FINANCIAL_PERMISSIONS_ACTIVATED'),
  providerExecutionEnabled: flagTrue('AWS_PROVIDER_EXECUTION_ENABLED'),
  cognitoMfaPreferred: flagTrue('AWS_COGNITO_MFA_PREFERRED'),
  moneyMovementUnlocked: false,
});

const productionEnv = () => {
  const env = String(process.env.CHECKSOPS_ENV || '');
  return env === 'production' || env === 'production-prep';
};

export const parseWrapKeySecret = (raw) => {
  const text = String(raw || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) {
    return { key: wrapKeyFromHex(text), keyId: 'financial-totp-v1' };
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  const hex = parsed?.key || parsed?.wrapKey || parsed?.hex;
  if (!hex) throw new Error('invalid_wrap_key');
  return {
    key: wrapKeyFromHex(hex),
    keyId: String(parsed.keyId || parsed.key_id || 'financial-totp-v1'),
  };
};

export const loadFinancialTotpWrapKey = async (getSecretString = getSecretStringFromAws) => {
  const arn = process.env.FINANCIAL_TOTP_WRAP_KEY_ARN;
  if (arn) return parseWrapKeySecret(await getSecretString(arn));
  if (productionEnv()) {
    const error = new Error('wrap_key_unconfigured');
    error.statusCode = 503;
    throw error;
  }
  if (process.env.FINANCIAL_TOTP_WRAP_KEY) {
    return { key: wrapKeyFromHex(process.env.FINANCIAL_TOTP_WRAP_KEY), keyId: 'financial-totp-v1' };
  }
  const error = new Error('wrap_key_unconfigured');
  error.statusCode = 503;
  throw error;
};

const schemaMissing = (error) => {
  const message = String(error?.message || '');
  return error?.code === '42883' || /does not exist|financial_totp_/i.test(message);
};

const wrapFail = (error) => {
  const missingSchema = schemaMissing(error);
  const missingWrap = error.message === 'wrap_key_unconfigured';
  const missingRate = error.message === 'rate_limit_unavailable';
  return {
    ok: false,
    statusCode: error.statusCode || (missingSchema || missingWrap || missingRate ? 503 : 401),
    error: missingSchema
      ? 'financial_totp_schema_unapplied'
      : (missingWrap ? 'wrap_key_unconfigured' : (missingRate ? 'rate_limit_unavailable' : 'financial_totp_failed')),
    message: missingWrap
      ? 'Financial TOTP wrap key is not configured.'
      : (missingSchema
        ? 'Financial TOTP schema is not applied.'
        : (missingRate
          ? 'Financial TOTP rate-limit storage is unavailable.'
          : totpUserFailureMessage(error))),
    ...financialGate(),
  };
};

const consumeRate = async (client, userId, action) => {
  const result = await client.query(
    'SELECT allowed, count, retry_after_seconds FROM public.consume_financial_totp_rate_limit($1::uuid, $2, $3::int, $4::int)',
    [userId, action, 5, 300],
  );
  const row = result.rows[0];
  if (!row) {
    const error = new Error('rate_limit_unavailable');
    error.statusCode = 503;
    throw error;
  }
  if (row.allowed !== true) {
    return {
      ok: false,
      statusCode: 429,
      error: 'rate_limited',
      retryAfterSec: Number(row.retry_after_seconds || 1),
      ...financialGate(),
    };
  }
  return { ok: true };
};

const statusRow = async (client, userId) => {
  const result = await client.query(
    'SELECT enrolled_at, verified_at FROM public.financial_totp_status($1::uuid)',
    [userId],
  );
  return result.rows[0] || null;
};

const loadEnrollment = async (client, userId) => {
  const result = await client.query(
    `SELECT ciphertext, nonce, key_id, last_used_timestep, verified_at, failed_attempts, locked_until
     FROM public.financial_totp_get_enrollment($1::uuid)`,
    [userId],
  );
  return result.rows[0] || null;
};

const listPasskeys = async (accessToken) => {
  if (!accessToken) return 0;
  try {
    const response = await fetch('https://cognito-idp.us-east-1.amazonaws.com/', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'AWSCognitoIdentityProviderService.ListWebAuthnCredentials',
      },
      body: JSON.stringify({ AccessToken: accessToken }),
    });
    const body = JSON.parse(await response.text() || '{}');
    return Array.isArray(body.Credentials) ? body.Credentials.length : 0;
  } catch {
    return 0;
  }
};

export const handleMfaStatus = async (event, deps = {}) => {
  const identity = deps.withIdentityWrite || withIdentityWrite;
  return identity(event, async ({ client, mapping, claims }) => {
    try {
      const row = await statusRow(client, mapping.application_user_id);
      // Cognito MFA list is injected as enabled to prove enrollment ignores it.
      const enrollment = evaluateFinancialTotpEnrollment({
        verifiedAt: row?.verified_at || null,
        userMfaSettingList: ['SOFTWARE_TOKEN_MFA'],
        preferredMfaSetting: 'SOFTWARE_TOKEN_MFA',
      });
      const body = parseBody(event);
      const accessToken = String(body.accessToken || body.access_token || '').trim();
      const passkeyCount = await (deps.listPasskeys || listPasskeys)(accessToken);
      const publicStatus = enrollmentResponseWithoutSecret({
        verifiedAt: row?.verified_at,
        enrolledAt: row?.enrolled_at,
      });
      const { loadRecentSessionStepUp, TOTP_STEPUP_TTL_MS } = await import(
        './providers/production/checkalt-authz.mjs'
      );
      const loginSessionId = loginSessionIdFromClaims(claims);
      const sessionRows = await loadRecentSessionStepUp(client, {
        userId: mapping.application_user_id,
        loginSessionId,
        sinceMs: TOTP_STEPUP_TTL_MS,
      });
      return {
        ok: true,
        statusCode: 200,
        totpEnrolled: enrollment.totpEnrolled,
        passkeyCount,
        preferredMfa: null,
        factors: enrollment.totpEnrolled ? [{ id: 'financial-totp', factorType: 'totp', status: 'verified' }] : [],
        privilegedAuth: privilegedAuthPolicy(),
        enrollment: evaluatePrivilegedEnrollment({
          totpEnrolled: enrollment.totpEnrolled,
          passkeyCount,
        }),
        source: 'financial_totp_enrollments',
        stepUpSession: {
          verified: Boolean(sessionRows[0]),
          ttlMs: TOTP_STEPUP_TTL_MS,
          boundToLoginSession: Boolean(loginSessionId),
          cognitoMfaIgnored: true,
        },
        ...publicStatus,
        ...financialGate(),
      };
    } catch (error) {
      return wrapFail(error);
    }
  }, deps);
};

export const handleMfaAssociate = async (event, deps = {}) => {
  const identity = deps.withIdentityWrite || withIdentityWrite;
  return identity(event, async ({ client, mapping, claims, body, spoof }) => {
    try {
      const rate = await consumeRate(client, mapping.application_user_id, 'enroll_start');
      if (!rate.ok) return rate;
      const existing = await statusRow(client, mapping.application_user_id);
      if (existing?.verified_at) {
        return {
          ok: false,
          statusCode: 409,
          error: 'enrollment_reset_required',
          message: 'Verified financial TOTP cannot be overwritten. An explicit reset is required.',
          spoofFieldsIgnored: spoof,
          ...financialGate(),
        };
      }
      const wrap = await (deps.loadWrapKey || loadFinancialTotpWrapKey)();
      const secret = generateTotpSecret();
      const wrapped = encryptSecret(secret, wrap.key, wrap.keyId);
      await client.query(
        'SELECT public.financial_totp_upsert_enrollment($1::uuid, $2::bytea, $3::bytea, $4)',
        [mapping.application_user_id, wrapped.ciphertext, wrapped.nonce, wrapped.keyId],
      );
      const email = mapping.email || claims.email || body.email || null;
      return {
        ok: true,
        statusCode: 200,
        id: 'financial-totp',
        totp: {
          secret,
          qr_code: null,
          otpauth_uri: otpauthUri(secret, email),
        },
        preferredMfaEnabled: false,
        spoofFieldsIgnored: spoof,
        ...financialGate(),
      };
    } catch (error) {
      if (String(error?.message || '') === 'verified_enrollment_exists') {
        return {
          ok: false,
          statusCode: 409,
          error: 'enrollment_reset_required',
          message: 'Verified financial TOTP cannot be overwritten. An explicit reset is required.',
          spoofFieldsIgnored: spoof,
          ...financialGate(),
        };
      }
      return wrapFail(error);
    }
  }, deps);
};

const verifyAgainstStore = async ({ client, mapping, code, wrap, nowMs, consumeTimestep = true }) => {
  const row = await loadEnrollment(client, mapping.application_user_id);
  if (!row?.ciphertext) {
    return { ok: false, statusCode: 403, error: 'totp_not_enrolled', ...financialGate() };
  }
  if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
    return { ok: false, statusCode: 429, error: 'rate_limited', ...financialGate() };
  }
  const secret = decryptSecret({ ciphertext: row.ciphertext, nonce: row.nonce, key: wrap.key });
  const verified = verifyFinancialTotp({
    secret,
    code,
    nowMs,
    lastUsedTimestep: row.last_used_timestep,
  });
  if (!verified.ok) {
    return {
      ok: false,
      statusCode: 401,
      error: verified.error === 'totp_mismatch' ? 'mfa_step_up_failed' : verified.error,
      verified: false,
      message: totpUserFailureMessage({ name: 'CodeMismatchException' }),
      ...financialGate(),
    };
  }
  const marked = await client.query(
    'SELECT public.financial_totp_mark_verified($1::uuid, $2::bigint) AS claimed',
    [mapping.application_user_id, consumeTimestep ? verified.timestep : null],
  );
  if (consumeTimestep && marked.rows[0]?.claimed !== true) {
    return {
      ok: false,
      statusCode: 401,
      error: 'mfa_step_up_failed',
      verified: false,
      message: totpUserFailureMessage({ name: 'CodeMismatchException' }),
      ...financialGate(),
    };
  }
  return { ok: true, timestep: verified.timestep };
};

export const handleMfaVerify = async (event, deps = {}) => {
  const body = parseBody(event);
  const normalized = normalizeTotpCode(body.code ?? body.userCode);
  if (!normalized.ok) {
    return {
      ok: false,
      statusCode: 400,
      error: normalized.error,
      message: totpUserFailureMessage({ message: normalized.error }),
      ...financialGate(),
    };
  }
  const identity = deps.withIdentityWrite || withIdentityWrite;
  return identity(event, async (ctx) => {
    try {
      const rate = await consumeRate(ctx.client, ctx.mapping.application_user_id, 'enroll_confirm');
      if (!rate.ok) return rate;
      const wrap = await (deps.loadWrapKey || loadFinancialTotpWrapKey)();
      const verified = await verifyAgainstStore({
        client: ctx.client,
        mapping: ctx.mapping,
        code: normalized.code,
        wrap,
        nowMs: deps.nowMs,
        consumeTimestep: false,
      });
      if (!verified.ok) return verified;
      return {
        ok: true,
        statusCode: 200,
        verified: true,
        enrollment: true,
        recorded: false,
        preferredMfaEnabled: false,
        preferredMfa: null,
        source: 'financial_totp_enrollments',
        remaining: 'Financial TOTP is enrolled without Cognito login MFA. EMAIL_OTP login is unchanged.',
        spoofFieldsIgnored: ctx.spoof,
        ...financialGate(),
      };
    } catch (error) {
      return wrapFail(error);
    }
  }, deps);
};

export const resolveFinancialStepUpBinding = async ({ client, mapping, body, spoof }) => {
  const { TENANT_MEMBERSHIP_SQL } = await import('./identity.mjs');
  const { membershipForTenant } = await import('./financial-ownership.mjs');
  const {
    CHECKALT_TOTP_ACTION,
    isCheckBoundTotpAction,
    isFinancialSessionTotpAction,
    serverAmountCentsFromCheck,
  } = await import('./providers/production/checkalt-authz.mjs');
  const actionKey = String(body.action_key || body.actionKey || CHECKALT_TOTP_ACTION);
  if (!isFinancialSessionTotpAction(actionKey)) {
    return {
      ok: false,
      statusCode: 409,
      error: 'action_mismatch',
      message: 'Financial TOTP step-up action is server-controlled.',
      spoofFieldsIgnored: spoof,
      ...financialGate(),
    };
  }
  if (!isCheckBoundTotpAction(actionKey)) {
    return { ok: true, check: null, amountCents: null, actionKey, tenantId: null };
  }
  const checkId = body.check_intake_item_id || body.check_id || null;
  if (!checkId) {
    return {
      ok: false,
      statusCode: 400,
      error: 'check_intake_item_id is required',
      message: 'Financial TOTP must be bound to a server-side check. Browser tenant_id is ignored.',
      spoofFieldsIgnored: spoof,
      ...financialGate(),
    };
  }
  const check = (await client.query(
    'SELECT id, tenant_id, amount, status FROM public.check_intake_items WHERE id = $1::uuid',
    [checkId],
  )).rows[0];
  if (!check) {
    return { ok: false, statusCode: 404, error: 'Check not found', spoofFieldsIgnored: spoof, ...financialGate() };
  }
  const memberships = (await client.query(TENANT_MEMBERSHIP_SQL, [mapping.application_user_id])).rows;
  if (!membershipForTenant(memberships, check.tenant_id)) {
    return {
      ok: false,
      statusCode: 403,
      error: 'cross_tenant_denied',
      message: 'TOTP step-up tenant is taken from the check. Browser tenant_id is ignored.',
      spoofFieldsIgnored: spoof,
      ...financialGate(),
    };
  }
  const amountCents = serverAmountCentsFromCheck(check);
  if (!Number.isInteger(amountCents)) {
    return {
      ok: false,
      statusCode: 400,
      error: 'invalid_amount',
      message: 'Server-derived check amount is required. Browser amount is ignored.',
      spoofFieldsIgnored: spoof,
      ...financialGate(),
    };
  }
  if (body.amount_cents !== undefined && body.amount_cents !== null && Number(body.amount_cents) !== amountCents) {
    return {
      ok: false,
      statusCode: 409,
      error: 'amount_mismatch',
      message: 'Browser amount is ignored. Server-derived amount does not match the provided amount.',
      spoofFieldsIgnored: spoof,
      ...financialGate(),
    };
  }
  return { ok: true, check, amountCents, actionKey, tenantId: check.tenant_id };
};

export const insertAppStepUpLog = async (client, mapping, bound) => {
  const { CHECKALT_TOTP_ACTION } = await import('./providers/production/checkalt-authz.mjs');
  const row = (await client.query(
    `INSERT INTO public.financial_stepup_log
      (user_id, tenant_id, action_key, factor_type, succeeded, metadata)
     VALUES ($1::uuid, $2::uuid, $3, 'totp', true, $4::jsonb)
     RETURNING id, created_at`,
    [
      mapping.application_user_id,
      bound.check?.tenant_id || bound.tenantId || null,
      bound.actionKey,
      JSON.stringify({
        check_id: bound.check?.id || null,
        amount_cents: bound.amountCents,
        operation: bound.actionKey || CHECKALT_TOTP_ACTION,
        source: 'app_financial_totp',
        session_scope: true,
        login_session_id: bound.loginSessionId || null,
      }),
    ],
  )).rows[0];
  return {
    ok: true,
    statusCode: 200,
    recorded: true,
    stepup_id: row.id,
    check_id: bound.check?.id || null,
    tenant_id: bound.check?.tenant_id || bound.tenantId || null,
    amount_cents: bound.amountCents,
    applicationUserId: mapping.application_user_id,
    session_scope: true,
    login_session_bound: Boolean(bound.loginSessionId),
  };
};

const sessionStepUpResponse = (row, spoof) => ({
  ok: true,
  statusCode: 200,
  verified: true,
  recorded: true,
  reused: true,
  stepup_id: row.id,
  factorType: 'totp',
  source: 'app_financial_totp',
  session_scope: true,
  check_id: row.metadata?.check_id || null,
  tenant_id: row.tenant_id || null,
  amount_cents: row.metadata?.amount_cents ?? null,
  spoofFieldsIgnored: spoof,
  ...financialGate(),
});

export const handleMfaStepUp = async (event, deps = {}) => {
  const body = parseBody(event);
  const normalized = normalizeTotpCode(body.code ?? body.userCode);
  if (!normalized.ok) {
    return {
      ok: false,
      statusCode: 400,
      error: normalized.error,
      message: totpUserFailureMessage({ message: normalized.error }),
      ...financialGate(),
    };
  }
  const identity = deps.withIdentityWrite || withIdentityWrite;
  return identity(event, async (ctx) => {
    try {
      const {
        loadRecentSessionStepUp,
        TOTP_STEPUP_TTL_MS,
      } = await import('./providers/production/checkalt-authz.mjs');
      const loginSessionId = loginSessionIdFromClaims(ctx.claims);
      const existing = await loadRecentSessionStepUp(ctx.client, {
        userId: ctx.mapping.application_user_id,
        loginSessionId,
        sinceMs: TOTP_STEPUP_TTL_MS,
      });
      if (existing[0]) return sessionStepUpResponse(existing[0], ctx.spoof);

      const rate = await consumeRate(ctx.client, ctx.mapping.application_user_id, 'step_up');
      if (!rate.ok) return rate;
      const bound = await resolveFinancialStepUpBinding({
        client: ctx.client,
        mapping: ctx.mapping,
        body,
        spoof: ctx.spoof,
      });
      if (!bound.ok) return bound;
      bound.loginSessionId = loginSessionId;
      const wrap = await (deps.loadWrapKey || loadFinancialTotpWrapKey)();
      const verified = await verifyAgainstStore({
        client: ctx.client,
        mapping: ctx.mapping,
        code: normalized.code,
        wrap,
        nowMs: deps.nowMs,
        consumeTimestep: true,
      });
      if (!verified.ok) return verified;
      const recorded = await insertAppStepUpLog(ctx.client, ctx.mapping, bound);
      if (!recorded?.ok) {
        return {
          ok: false,
          statusCode: recorded?.statusCode || 401,
          error: recorded?.error || 'stepup_log_failed',
          verified: true,
          recorded: false,
          message: recorded?.message || 'TOTP was valid but the server-side step-up log was not recorded.',
          spoofFieldsIgnored: ctx.spoof,
          ...financialGate(),
        };
      }
      return {
        ok: true,
        statusCode: 200,
        verified: true,
        recorded: true,
        reused: false,
        stepup_id: recorded.stepup_id,
        factorType: 'totp',
        source: 'app_financial_totp',
        session_scope: true,
        check_id: recorded.check_id,
        tenant_id: recorded.tenant_id,
        amount_cents: recorded.amount_cents,
        spoofFieldsIgnored: ctx.spoof,
        ...financialGate(),
      };
    } catch (error) {
      return wrapFail(error);
    }
  }, deps);
};

export const handleMfaSetPreference = async () => ({
  ok: false,
  statusCode: 403,
  error: 'cognito_preferred_mfa_disabled',
  message: 'Refusing Cognito login MFA preference changes. Financial TOTP is application-level only.',
  ...financialGate(),
});
