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
 *
 * Changing a registered deposit account (security audit finding 13, owner
 * decision 2026-10-30): when the tenant already has a registered account and
 * the new number differs, register needs a fresh code from the platform
 * owner's authenticator app in the same request (totp_code), checked before
 * any Check Alt call or write. First registration and a re-register with the
 * same number need no code. The code draws on the shared code_check rate
 * limit, must be from a newer time step than the last code used (a code is
 * accepted once), is spent and logged in financial_stepup_log before Check
 * Alt is called, and is not the once-per-login financial step-up. After the
 * change is saved, the company is emailed the old and new last four digits.
 * Only exports already live in production are imported (auth-financial-totp,
 * financial-totp, email), so this member deploys on its own.
 */
import { commitWriteTransaction, IS_PLATFORM_OWNER_SQL } from '../../data.mjs';
import { insertAppStepUpLog, loadFinancialTotpWrapKey, TOTP_CODE_CHECK_RATE_ACTION } from '../../auth-financial-totp.mjs';
import { normalizeTotpCode } from '../../auth-totp-code.mjs';
import { platformBranding, resolveEmailBranding } from '../../email-branding.mjs';
import { renderChecksOpsEmail } from '../../email-layout.mjs';
import { sendViaSesOrSink } from '../../email.mjs';
import { decryptSecret, verifyFinancialTotp } from '../../financial-totp.mjs';
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
import { bindCheckAltProductionGucs } from './checkalt-idempotency.mjs';
import { loadProductionCheckAltSecrets } from './checkalt-secrets.mjs';
import { loginSessionBinding } from './moov-fund-authz.mjs';

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

/** Readable reply for each register field Check Alt or SQL 81 can refuse. */
const FIELD_MESSAGES = Object.freeze({
  tenant_id: 'Choose a company first.',
  sso_user_id: 'User ID is required (1-64 characters, no spaces).',
  first_name: 'First name is required (up to 100 characters).',
  last_name: 'Last name is required (up to 100 characters).',
  email: 'Enter a valid email address.',
  deposit_account_number: 'Deposit account number must be 5 to 17 digits, with no spaces, dashes or letters.',
});
const fieldMessage = (field) => FIELD_MESSAGES[field] || 'One of the registration fields is invalid.';

/** Server-side validation of the register form. */
export const validateRegisterBody = (body = {}) => {
  const tenantId = body.tenant_id;
  if (!isUuid(tenantId)) {
    return { error: fail('invalid_uuid', 400, { field: 'tenant_id', productionExecution: false, message: 'Choose a company first.' }) };
  }
  const ssoUserId = textField(body, 'sso_user_id', 64);
  if (!ssoUserId || !SSO_RE.test(ssoUserId)) {
    return { error: fail('invalid_field', 400, { field: 'sso_user_id', productionExecution: false, message: FIELD_MESSAGES.sso_user_id }) };
  }
  const firstName = textField(body, 'first_name', 100);
  if (!firstName) {
    return { error: fail('invalid_field', 400, { field: 'first_name', productionExecution: false, message: FIELD_MESSAGES.first_name }) };
  }
  const lastName = textField(body, 'last_name', 100);
  if (!lastName) {
    return { error: fail('invalid_field', 400, { field: 'last_name', productionExecution: false, message: FIELD_MESSAGES.last_name }) };
  }
  const email = textField(body, 'email', 254);
  if (!email || !EMAIL_RE.test(email)) {
    return { error: fail('invalid_field', 400, { field: 'email', productionExecution: false, message: FIELD_MESSAGES.email }) };
  }
  const depositAccountNumber = normalizeDepositAccountNumber(body.deposit_account_number);
  if (!depositAccountNumber) {
    return {
      error: fail('invalid_deposit_account_number', 400, {
        field: 'deposit_account_number',
        productionExecution: false,
        message: FIELD_MESSAGES.deposit_account_number,
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
  if (code === '42501') {
    return fail('not_authorized', 403, { message: 'Only the platform owner can register a tenant\'s Check Alt depositor.' });
  }
  if (code === 'P0002') return fail('tenant_not_found', 404, { message: 'That company was not found.' });
  if (code === '22023') {
    return fail('invalid_field', 400, { field: error?.detail || null, message: fieldMessage(error?.detail) });
  }
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

/** Step-up action recorded for a deposit account change (financial_stepup_log.action_key). */
export const CHECKALT_ACCOUNT_CHANGE_ACTION = 'checkalt.deposit_account.change';
export const DEPOSIT_ACCOUNT_CHANGED_TEMPLATE = 'checkalt-deposit-account-changed';

const RATE_LIMIT_SQL = 'SELECT allowed, count, retry_after_seconds FROM public.consume_financial_totp_rate_limit($1::uuid, $2, $3::int, $4::int)';
const ENROLLMENT_SQL = `SELECT ciphertext, nonce, key_id, last_used_timestep, verified_at, failed_attempts, locked_until
     FROM public.financial_totp_get_enrollment($1::uuid)`;
const MARK_USED_SQL = 'SELECT public.financial_totp_mark_verified($1::uuid, $2::bigint) AS claimed';

/** A registered account is changed when the new number differs from the stored one. */
export const isDepositAccountChange = (stored, depositAccountNumber) => Boolean(
  stored?.registered_at && stored?.deposit_account_number && stored.deposit_account_number !== depositAccountNumber,
);

const codeFail = (error, statusCode, message, extra = {}) => fail(error, statusCode, {
  productionExecution: false,
  code_required: true,
  message,
  ...extra,
});

/** Commit what this request has done so far and continue in a new transaction with the same identity. */
const commitAndContinue = async (client, mapping, claims) => {
  await commitWriteTransaction(client);
  await client.query('BEGIN');
  await client.query('SET TRANSACTION READ WRITE');
  await bindCheckAltProductionGucs(client, mapping, claims);
};

/**
 * Checks the platform owner's authenticator code for one deposit account change.
 * Same store, rate limit and verifier as the financial step-up (auth-financial-totp.mjs);
 * stricter on replay: the code's time step must be newer than the last one used.
 */
export const verifyAccountChangeCode = async ({ client, mapping, claims, code, tenantId, deps = {} }) => {
  const normalized = normalizeTotpCode(code);
  if (!normalized.ok) return codeFail('invalid_code', 400, 'Enter the 6-digit code from your authenticator app.');
  const loginSession = loginSessionBinding(claims);
  if (!loginSession) return codeFail('login_session_unbound', 401, 'Sign out and sign back in, then try again.');
  const userId = mapping?.application_user_id;
  const rate = (await client.query(RATE_LIMIT_SQL, [userId, TOTP_CODE_CHECK_RATE_ACTION, 5, 300])).rows[0];
  if (!rate) {
    const error = new Error('rate_limit_unavailable');
    error.statusCode = 503;
    throw error;
  }
  if (rate.allowed !== true) {
    return codeFail('rate_limited', 429, 'Too many codes tried. Wait a few minutes and try again.', {
      retryAfterSec: Number(rate.retry_after_seconds || 1),
    });
  }
  // Keep the rate-limit hit: a wrong code fails the request, which rolls back.
  await commitAndContinue(client, mapping, claims);
  const enrollment = (await client.query(ENROLLMENT_SQL, [userId])).rows[0];
  if (!enrollment?.ciphertext) {
    return codeFail('totp_not_enrolled', 403, 'Set up your authenticator app first, then change the deposit account.');
  }
  if (enrollment.locked_until && new Date(enrollment.locked_until).getTime() > Date.now()) {
    return codeFail('rate_limited', 429, 'Too many codes tried. Wait a few minutes and try again.');
  }
  const wrap = await (deps.loadWrapKey || loadFinancialTotpWrapKey)();
  const secret = decryptSecret({ ciphertext: enrollment.ciphertext, nonce: enrollment.nonce, key: wrap.key });
  const lastUsed = enrollment.last_used_timestep === null || enrollment.last_used_timestep === undefined
    ? null
    : Number(enrollment.last_used_timestep);
  const verified = verifyFinancialTotp({ secret, code: normalized.code, nowMs: deps.nowMs, lastUsedTimestep: lastUsed });
  const rejected = codeFail('code_rejected', 401, 'That code was not accepted. Wait for a new code in your authenticator app and try again.');
  if (!verified.ok || (lastUsed !== null && verified.timestep <= lastUsed)) return rejected;
  if ((await client.query(MARK_USED_SQL, [userId, verified.timestep])).rows[0]?.claimed !== true) return rejected;
  const recorded = await insertAppStepUpLog(client, mapping, {
    kind: 'login_session',
    tenantId,
    actionKey: CHECKALT_ACCOUNT_CHANGE_ACTION,
    loginSession,
  });
  if (!recorded?.ok) {
    return codeFail('stepup_log_failed', 500, 'The code was valid but could not be recorded. Nothing was changed; try again.');
  }
  // Spend the code before Check Alt is called: a later failure must not let it be used again.
  await commitAndContinue(client, mapping, claims);
  return { ok: true, stepupId: recorded.stepup_id };
};

/** The company's notice of a deposit account change. Last four digits only. */
export const buildDepositAccountChangedEmail = ({
  tenantName, previousLast4, newLast4, changedAt, changedBy, branding = {},
}) => {
  const name = String(tenantName || 'your company').slice(0, 120);
  const when = (changedAt ? new Date(changedAt) : new Date()).toISOString().replace('T', ' ').slice(0, 16);
  const paragraphs = [
    `The bank account that Check Alt deposits for ${name} are credited to was changed.`,
    `New deposit account: ending in ${newLast4 || '----'}. Previous deposit account: ending in ${previousLast4 || '----'}.`,
    `Changed on ${when} UTC by ${changedBy || 'the ChecksOps platform owner'}.`,
    'If you did not expect this change, contact support@checksops.com right away.',
  ];
  const layout = renderChecksOpsEmail({
    title: 'Your deposit account was changed',
    preview: `Check Alt deposits now go to the account ending in ${newLast4 || '----'}`,
    paragraphs,
    companySubtitle: branding.companySubtitle || name,
    logoUrl: branding.logoUrl || null,
  });
  return {
    subject: `${name}: your Check Alt deposit account was changed`,
    html: layout.html,
    text: ['Your deposit account was changed', ...paragraphs].join('\n'),
  };
};

const emailOf = (value) => {
  const email = String(value || '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
};

/** Runs fn under a savepoint; a failed read or log row never fails the change. */
const optional = async (client, name, fn) => {
  await client.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {});
    return null;
  }
};

/**
 * Recipients: the company's business address (tenants.company_email, SQL 93), else every member
 * of the tenant (users-only roles, SQL 90: there is no owner role to pick instead).
 */
export const resolveDepositAccountChangeRecipients = async (client, tenantId) => {
  const tenant = await optional(client, 'checkalt_change_tenant', async () => (await client.query(
    'SELECT name, company_email FROM public.tenants WHERE id = $1::uuid',
    [tenantId],
  )).rows[0] || null);
  const company = emailOf(tenant?.company_email);
  if (company) return { tenantName: tenant?.name || null, recipients: [{ email: company, source: 'company_email' }] };
  const members = await optional(client, 'checkalt_change_members', async () => (await client.query(
    `SELECT DISTINCT ia.email
       FROM public.tenant_users tu
       JOIN public.identity_accounts ia ON ia.application_user_id = tu.user_id
      WHERE tu.tenant_id = $1::uuid`,
    [tenantId],
  )).rows) || [];
  const emails = [...new Set(members.map((row) => emailOf(row.email)).filter(Boolean))];
  return { tenantName: tenant?.name || null, recipients: emails.map((email) => ({ email, source: 'tenant_member' })) };
};

/** Emails the company after a committed change. Never throws; a failure is logged, not returned as an error. */
export const notifyDepositAccountChange = async ({
  client, tenantId, previousNumber, newNumber, changedBy, stepupId = null, deps = {},
}) => {
  try {
    const { tenantName, recipients } = await resolveDepositAccountChangeRecipients(client, tenantId);
    const branding = await optional(client, 'checkalt_change_branding', () => resolveEmailBranding(client, { tenantId })) || {};
    const email = buildDepositAccountChangedEmail({
      tenantName,
      previousLast4: accountLast4(previousNumber),
      newLast4: accountLast4(newNumber),
      changedAt: deps.nowMs ? new Date(deps.nowMs) : new Date(),
      changedBy,
      branding,
    });
    if (!recipients.length) {
      console.error(JSON.stringify({ service: 'checksops-api', event: 'checkalt_deposit_account_change_email_no_recipient', tenant_id: tenantId }));
      return { status: 'no_recipient', sent: false, recipient_count: 0 };
    }
    const mailer = deps.sendViaSesOrSink || sendViaSesOrSink;
    const platform = platformBranding();
    const outcomes = [];
    for (const recipient of recipients) {
      let outcome;
      try {
        const sent = await mailer({
          to: recipient.email,
          subject: email.subject,
          html: email.html,
          text: email.text,
          from: platform.from,
          replyTo: platform.replyTo,
          tenantId,
          messageCategory: DEPOSIT_ACCOUNT_CHANGED_TEMPLATE,
        });
        const primary = sent?.results?.[0] || {};
        const status = primary.status === 'failed' || !sent?.results?.length
          ? 'failed'
          : (primary.delivery === 'ses' && primary.status === 'sent' ? 'sent' : 'sunk');
        outcome = { status, messageId: primary.messageId || null, error: primary.error || null };
      } catch (error) {
        outcome = { status: 'failed', messageId: null, error: String(error?.message || error).slice(0, 240) };
      }
      outcomes.push(outcome);
      if (outcome.status === 'failed') {
        console.error(JSON.stringify({
          service: 'checksops-api',
          event: 'checkalt_deposit_account_change_email_failed',
          tenant_id: tenantId,
          recipient_source: recipient.source,
          error: outcome.error,
        }));
      }
      await optional(client, 'checkalt_change_email_log', () => client.query(
        `INSERT INTO public.email_send_log (
           id, template_name, recipient_email, tenant_id, status, provider, provider_message_id,
           idempotency_key, error_message, metadata, created_at
         ) VALUES (gen_random_uuid(), $1, $2, $3::uuid, $4, 'aws_ses', $5, $6, $7, $8::jsonb, now())`,
        [
          DEPOSIT_ACCOUNT_CHANGED_TEMPLATE, recipient.email, tenantId, outcome.status, outcome.messageId,
          stepupId ? `checkalt-account-change:${stepupId}:${recipient.email}` : null, outcome.error,
          JSON.stringify({ recipient_source: recipient.source, stepup_id: stepupId }),
        ],
      ));
    }
    const sent = outcomes.filter((o) => o.status === 'sent' || o.status === 'sunk').length;
    return { status: sent ? 'sent' : 'failed', sent: sent > 0, recipient_count: recipients.length };
  } catch (error) {
    console.error(JSON.stringify({
      service: 'checksops-api',
      event: 'checkalt_deposit_account_change_email_failed',
      tenant_id: tenantId,
      error: String(error?.message || error).slice(0, 240),
    }));
    return { status: 'failed', sent: false };
  }
};

export async function handleProductionCheckAltRegister({
  client, mapping, claims, body = {}, spoof, fetchImpl = fetch, deps = {},
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

  // Finding 13: changing a registered deposit account needs a fresh authenticator code.
  const stored = await loadStoredAccount(client, input.tenantId);
  const change = isDepositAccountChange(stored, input.depositAccountNumber);
  let stepupId = null;
  if (change) {
    const previousLast4 = accountLast4(stored.deposit_account_number);
    if (body.totp_code === undefined || body.totp_code === null || body.totp_code === '') {
      return {
        ...codeFail('account_change_code_required', 403, 'Changing the deposit account needs a code from your authenticator app. Enter the 6-digit code and submit again.', {
          account_last4: previousLast4,
        }),
        spoofFieldsIgnored: spoof,
      };
    }
    const checked = await verifyAccountChangeCode({
      client, mapping, claims, code: body.totp_code, tenantId: input.tenantId, deps,
    });
    if (!checked.ok) return { ...checked, account_last4: previousLast4, spoofFieldsIgnored: spoof };
    stepupId = checked.stepupId;
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

  let changeNotice;
  if (change) {
    // The change is committed before the company is told about it; the email never undoes it.
    try {
      await commitAndContinue(client, mapping, claims);
    } catch {
      return fail('register_save_failed', 500, {
        reason: 'commit_failed',
        liveProviderCalled: true,
        registeredWithCheckAlt: true,
        productionRecordsMutated: false,
        message: 'Check Alt accepted the registration but ChecksOps did not save it. Nothing was changed in ChecksOps; register again once fixed.',
        spoofFieldsIgnored: spoof,
      });
    }
    changeNotice = await notifyDepositAccountChange({
      client,
      tenantId: input.tenantId,
      previousNumber: stored.deposit_account_number,
      newNumber: input.depositAccountNumber,
      changedBy: mapping?.email || claims?.email || null,
      stepupId,
      deps,
    });
  }

  return ok({
    ...publicRegistrationStatus({ ...saved, deposit_account_number: input.depositAccountNumber }),
    tenant_id: input.tenantId,
    ...(change ? {
      account_changed: true,
      previous_account_last4: accountLast4(stored.deposit_account_number),
      stepup_id: stepupId,
      change_notice: changeNotice,
    } : {}),
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
  if (!isUuid(tenantId)) {
    return fail('invalid_uuid', 400, { field: 'tenant_id', productionExecution: false, message: FIELD_MESSAGES.tenant_id });
  }
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
    ...(result.ok ? {} : {
      error: 'checkalt_lookup_failed',
      message: 'Check Alt did not return this depositor\'s details. Try again, or check the registration.',
      details: data,
    }),
    liveProviderCalled: true,
    productionExecution: true,
    productionRecordsMutated: false,
    spoofFieldsIgnored: spoof,
  };
}
