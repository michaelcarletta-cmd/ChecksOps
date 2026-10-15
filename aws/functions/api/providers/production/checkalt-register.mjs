/**
 * Production Check Alt depositor onboarding (platform owner only).
 *
 *   checkalt-register-account  POST /fincapture/useraccount/register on the
 *     live production FinCapture host, then getUserAccountInformation for the
 *     ssoKey, then writes the tenant's production checkalt_tenant_accounts row
 *     through public.aws_register_checkalt_tenant_account (SQL 81).
 *   checkalt-verify-account    action "status": the stored registration
 *     (no provider call). action "user" / "account": Check Alt's live
 *     getUserAccountInformation / getDepositAccountInformation answer, shown
 *     to the owner at that moment. Verify persists nothing.
 *
 * Mirrors the UAT parity handlers (providers/parity/checkalt-functions.mjs)
 * and the Lovable writer (supabase/functions/checkalt-register-account).
 * Credentials, FI key, merchant and host are server-derived (Secrets Manager
 * + checkalt_config); the browser cannot pick them. Every response carries
 * the deposit account number as the last four digits only.
 *
 * Submit is unchanged: it still needs sso_user_id + deposit_account_number +
 * enabled (loadProductionTenantAccount).
 */
import { IS_PLATFORM_OWNER_SQL } from '../../data.mjs';
import { isUuid } from '../../financial-ownership.mjs';
import {
  accountLast4,
  maskAccountNumber,
  maskCheckAltPayload,
  normalizeDepositAccountNumber,
} from '../checkalt-account-mask.mjs';
import {
  buildRegisterPayload,
  checkAltFetch,
  extractSsoKey,
  getDepositAccountInfo,
  getUserAccountInfo,
} from '../parity/checkalt-client.mjs';
import { loadProductionCheckAltConfig } from './checkalt-config.mjs';
import { loadProductionCheckAltSecrets } from './checkalt-secrets.mjs';

const jwtCache = { token: null, expiresAt: null };

const fail = (error, statusCode, extra = {}) => ({
  ok: false,
  success: false,
  statusCode,
  error,
  provider: 'checkalt',
  liveProviderCalled: false,
  productionExecution: true,
  ...extra,
});

const ok = (data) => ({
  ok: true,
  statusCode: 200,
  success: true,
  provider: 'checkalt',
  environment: 'production',
  productionExecution: true,
  ...data,
});

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SSO_RE = /^[\x21-\x7E]{1,64}$/;

const UNTRUSTED_CONFIG_KEYS = [
  'merchant', 'fi_key', 'fiKey', 'base_url', 'environment', 'username', 'password',
  'routing_number', 'routingNumber', 'depositor_account_id',
];

export const requireCheckAltPlatformOwner = async (client) => {
  const row = (await client.query(IS_PLATFORM_OWNER_SQL)).rows[0];
  if (row?.is_owner) return null;
  return fail('not_authorized', 403, {
    productionExecution: false,
    message: 'Only the platform owner can register or verify a tenant\'s Check Alt depositor.',
  });
};

const textField = (body, key, max) => {
  const value = body?.[key];
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length >= 1 && text.length <= max ? text : null;
};

/** Server-side validation of the register form. */
export const validateRegisterBody = (body = {}) => {
  const tenantId = body.tenant_id;
  if (!isUuid(tenantId)) return { error: fail('invalid_uuid', 400, { field: 'tenant_id', productionExecution: false }) };
  const ssoUserId = textField(body, 'sso_user_id', 64);
  if (!ssoUserId || !SSO_RE.test(ssoUserId)) {
    return { error: fail('invalid_field', 400, { field: 'sso_user_id', productionExecution: false, message: 'User ID is required (1-64 characters, no spaces).' }) };
  }
  const firstName = textField(body, 'first_name', 100);
  if (!firstName) return { error: fail('invalid_field', 400, { field: 'first_name', productionExecution: false }) };
  const lastName = textField(body, 'last_name', 100);
  if (!lastName) return { error: fail('invalid_field', 400, { field: 'last_name', productionExecution: false }) };
  const email = textField(body, 'email', 254);
  if (!email || !EMAIL_RE.test(email)) return { error: fail('invalid_field', 400, { field: 'email', productionExecution: false }) };
  const depositAccountNumber = normalizeDepositAccountNumber(body.deposit_account_number);
  if (!depositAccountNumber) {
    return {
      error: fail('invalid_deposit_account_number', 400, {
        field: 'deposit_account_number',
        productionExecution: false,
        message: 'Deposit account number must be 5 to 17 digits, with no spaces, dashes or letters.',
      }),
    };
  }
  return { tenantId, ssoUserId, firstName, lastName, email, depositAccountNumber };
};

const loadSecretsAndConfig = async (client, deps) => {
  const secrets = await (deps.loadProductionSecrets || loadProductionCheckAltSecrets)(deps.getSecrets);
  if (!secrets.ok) return { errorResult: secrets };
  const loadedCfg = await loadProductionCheckAltConfig(client, { credentials: secrets.credentials });
  if (!loadedCfg.ok) return { errorResult: loadedCfg };
  return { loadedCfg };
};

const parseJson = async (resp) => {
  const raw = await resp.text();
  try { return JSON.parse(raw); } catch { return { raw: String(raw).slice(0, 500) }; }
};

const sqlErrorResult = (error) => {
  const code = error?.code;
  if (code === '42501') return fail('not_authorized', 403);
  if (code === 'P0002') return fail('tenant_not_found', 404);
  if (code === '22023') return fail('invalid_field', 400, { field: error?.detail || null });
  if (code === '42883') {
    return fail('register_writer_missing', 503, {
      message: 'SQL 81 (aws_register_checkalt_tenant_account) is not applied in this database.',
    });
  }
  return null;
};

/**
 * Pre-flight before any Check Alt call: the tenant exists (the platform owner
 * reads every tenant under RLS) and this role can execute the SQL 81 writer.
 */
export const REGISTER_PREFLIGHT_SQL = `SELECT
  EXISTS (SELECT 1 FROM public.tenants WHERE id = $1::uuid) AS tenant_exists,
  COALESCE(has_function_privilege(
    to_regprocedure('public.aws_register_checkalt_tenant_account(uuid, jsonb)'), 'EXECUTE'
  ), false) AS writer_ok`;

const loadStoredAccount = async (client, tenantId) => (await client.query(
  `SELECT tenant_id, sso_user_id, deposit_account_number, first_name, last_name, email,
          enabled, registered_at
   FROM public.checkalt_tenant_accounts
   WHERE tenant_id = $1::uuid
   LIMIT 1`,
  [tenantId],
)).rows[0] || null;

/** Status the platform owner sees: Not registered / Registered. Last four only. */
export const publicRegistrationStatus = (row) => {
  const registered = Boolean(row?.registered_at && row?.sso_user_id && row?.deposit_account_number);
  return {
    status: registered ? 'registered' : 'not_registered',
    registered,
    enabled: row ? row.enabled !== false : false,
    registered_at: row?.registered_at || null,
    sso_user_id: row?.sso_user_id || null,
    first_name: row?.first_name || null,
    last_name: row?.last_name || null,
    email: row?.email || null,
    account_last4: accountLast4(row?.deposit_account_number),
    deposit_account_number_masked: row?.deposit_account_number ? maskAccountNumber(row.deposit_account_number) : null,
  };
};

export async function handleProductionCheckAltRegister({
  client, body = {}, spoof, fetchImpl = fetch, deps = {},
} = {}) {
  const denied = await requireCheckAltPlatformOwner(client);
  if (denied) return { ...denied, spoofFieldsIgnored: spoof };
  if (UNTRUSTED_CONFIG_KEYS.some((key) => body[key] !== undefined)) {
    return fail('untrusted_provider_config', 400, {
      productionExecution: false,
      message: 'Check Alt host, merchant, FI key and credentials are server-derived. No routing number is accepted (Check Alt binds the bank through the FI key).',
    });
  }
  const input = validateRegisterBody(body);
  if (input.error) return { ...input.error, spoofFieldsIgnored: spoof };

  // Never register with Check Alt when ChecksOps could not save the result.
  const preflight = (await client.query(REGISTER_PREFLIGHT_SQL, [input.tenantId])).rows[0];
  if (!preflight?.writer_ok) {
    return { ...sqlErrorResult({ code: '42883' }), productionExecution: false, spoofFieldsIgnored: spoof };
  }
  if (!preflight.tenant_exists) {
    return { ...sqlErrorResult({ code: 'P0002' }), productionExecution: false, spoofFieldsIgnored: spoof };
  }

  const loaded = await loadSecretsAndConfig(client, deps);
  if (loaded.errorResult) return { ...loaded.errorResult, spoofFieldsIgnored: spoof };
  const { cfg, credentials } = loaded.loadedCfg;
  if (input.ssoUserId === credentials.username) {
    return fail('depositor_must_not_be_api_login', 400, {
      productionExecution: false,
      message: 'The depositor User ID must not be the Check Alt API login.',
    });
  }

  const known = [input.depositAccountNumber];
  const payload = buildRegisterPayload({
    fiKey: cfg.fi_key,
    ssoUserId: input.ssoUserId,
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    depositAccountNumber: input.depositAccountNumber,
  });
  const resp = await checkAltFetch({
    cfg, credentials, path: '/fincapture/useraccount/register', body: payload, fetchImpl, jwtCache,
  });
  const registerJson = await parseJson(resp);
  if (!resp.ok) {
    return fail('checkalt_registration_failed', 502, {
      liveProviderCalled: true,
      providerStatus: resp.status,
      details: maskCheckAltPayload(registerJson, known),
      message: 'Check Alt refused the registration. Nothing was saved.',
      spoofFieldsIgnored: spoof,
    });
  }

  let ssoKey = null;
  let userAccountInfo = null;
  try {
    const info = await getUserAccountInfo({
      cfg, credentials, ssoUserId: input.ssoUserId, fetchImpl, jwtCache,
    });
    userAccountInfo = info.json;
    if (info.ok) ssoKey = extractSsoKey(info.json, input.depositAccountNumber);
  } catch {
    /* non-fatal, same as the Lovable writer: sso_user_id is the fallback ssoKey */
  }

  let saved;
  try {
    saved = (await client.query(
      'SELECT public.aws_register_checkalt_tenant_account($1::uuid, $2::jsonb) AS result',
      [input.tenantId, JSON.stringify({
        sso_user_id: input.ssoUserId,
        first_name: input.firstName,
        last_name: input.lastName,
        email: input.email,
        deposit_account_number: input.depositAccountNumber,
        last_register_payload: {
          register_response: maskCheckAltPayload(registerJson, known),
          user_account_info: maskCheckAltPayload(userAccountInfo, known),
          sso_key: ssoKey,
        },
      })],
    )).rows[0]?.result;
  } catch (error) {
    // Check Alt already accepted: never rethrow, always say so (generic, no SQL text).
    const mapped = sqlErrorResult(error);
    return fail('register_save_failed', mapped?.statusCode || 500, {
      reason: mapped?.error || 'database_error',
      field: mapped?.field || undefined,
      liveProviderCalled: true,
      registeredWithCheckAlt: true,
      productionRecordsMutated: false,
      message: 'Check Alt accepted the registration but ChecksOps did not save it. Nothing was changed in ChecksOps; register again once fixed.',
      spoofFieldsIgnored: spoof,
    });
  }

  return ok({
    ...publicRegistrationStatus({ ...saved, deposit_account_number: input.depositAccountNumber }),
    tenant_id: input.tenantId,
    has_sso_key: Boolean(ssoKey),
    liveProviderCalled: true,
    productionRecordsMutated: true,
    warning: ssoKey
      ? undefined
      : 'Registration succeeded but Check Alt did not return an ssoKey. The User ID will be used as ssoKey for deposits.',
    spoofFieldsIgnored: spoof,
  });
}

export async function handleProductionCheckAltVerify({
  client, body = {}, spoof, fetchImpl = fetch, deps = {},
} = {}) {
  const denied = await requireCheckAltPlatformOwner(client);
  if (denied) return { ...denied, spoofFieldsIgnored: spoof };
  const tenantId = body.tenant_id;
  if (!isUuid(tenantId)) return fail('invalid_uuid', 400, { field: 'tenant_id', productionExecution: false });
  if (!['status', 'user', 'account'].includes(body.action)) {
    return fail('invalid_action', 400, {
      field: 'action',
      productionExecution: false,
      message: 'action must be status, user or account.',
    });
  }
  const { action } = body;

  const row = await loadStoredAccount(client, tenantId);
  const status = publicRegistrationStatus(row);
  if (action === 'status') {
    return ok({ ...status, tenant_id: tenantId, action, liveProviderCalled: false, productionExecution: false, spoofFieldsIgnored: spoof });
  }
  if (!status.registered) {
    return fail('account_unregistered', 409, {
      ...status,
      productionExecution: false,
      message: 'This tenant has no registered production Check Alt depositor. Register it first.',
      spoofFieldsIgnored: spoof,
    });
  }

  const loaded = await loadSecretsAndConfig(client, deps);
  if (loaded.errorResult) return { ...loaded.errorResult, spoofFieldsIgnored: spoof };
  const { cfg, credentials } = loaded.loadedCfg;
  const result = action === 'account'
    ? await getDepositAccountInfo({
      cfg, credentials, ssoUserId: row.sso_user_id, accountNumber: row.deposit_account_number, fetchImpl, jwtCache,
    })
    : await getUserAccountInfo({
      cfg, credentials, ssoUserId: row.sso_user_id, fetchImpl, jwtCache,
    });
  const data = maskCheckAltPayload(result.json, [row.deposit_account_number]);
  return {
    ...status,
    ok: true,
    statusCode: 200,
    success: result.ok,
    provider: 'checkalt',
    environment: 'production',
    tenant_id: tenantId,
    action,
    data,
    ...(result.ok ? {} : { error: 'checkalt_lookup_failed', details: data }),
    liveProviderCalled: true,
    productionExecution: true,
    productionRecordsMutated: false,
    spoofFieldsIgnored: spoof,
  };
}
