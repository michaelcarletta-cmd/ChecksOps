/**
 * Moov payees (SQL 113): a homeowner or a Settings stakeholder (individual = KYC,
 * business = KYB) that a tenant pays is set up as a Moov payee through a secure
 * emailed link, without a ChecksOps login, and becomes payable only once Moov
 * verifies it.
 *
 * One handler set for both environments: staging always Moov sandbox and
 * environment 'sandbox'; production only with AWS_MOOV_PAYEES_PRODUCTION_ENABLED
 * (flags.mjs) and a tenant whose moov_environment is production. The environment
 * comes from server state (the tenant row, then the payee row), never the body.
 *
 * Tenant side (Cognito identity, a member of the tenant):
 *   moov-recipient-create       create a payee: Moov account first, then
 *                               aws_payee_create, then the emailed link
 *   homeowner-bank-link-send    the same, for a homeowner (individual)
 *   moov-recipient-link-resend  aws_payee_reissue_link with a new token, emailed
 *   moov-recipient-disconnect   aws_payee_disconnect, then best-effort at Moov
 * Public (the link token only, no identity):
 *   moov-recipient-session      payer + the payee's safe state + live requirements
 *   moov-recipient-tos-accept   server-minted terms token with the payee's IP/UA
 *   moov-recipient-kyc-update   identity (KYC) or business + owners (KYB)
 *   moov-recipient-bank-add     bank account (routing/account never stored)
 *   moov-recipient-bank-verify  instant micro-deposit initiate / confirm
 *
 * Every payee database write goes through the SQL 113 SECURITY DEFINER
 * functions. The only direct statement is a read of external_payment_recipients
 * (SELECT grant + RLS policy) to find a payee by id for resend / disconnect.
 *
 * PII: SSN, EIN, date of birth, bank account and routing numbers exist only in
 * this request's memory on their way to Moov. They are never stored, logged,
 * returned or passed to the database; the bank's name and last four are kept.
 * The link token is never logged and never returned to the company (the payee
 * receives it by email only; the company can resend).
 *
 * User-facing text never names the payment provider.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { MoovError, idempotencyUuid, withMoovContext } from '../parity/moov-client.mjs';
import { fail, jsonResult } from '../parity/caller.mjs';
import {
  buildIndividualKycPatch,
  initiateAlreadyOpenError,
  interpretRecipientBankVerification,
  moovInstantVerifyBody,
  shouldInitiateInstantMicroDeposit,
  tosRequirementOutstanding,
} from '../moov-recipient-tos-policy.mjs';
import { OnboardingError } from '../onboarding/crypto.mjs';
import {
  isUuid,
  loadOnboardingMoovContext,
  resolveOnboardingAccess,
  resolveOnboardingEnvironment,
} from '../onboarding/context.mjs';
import { isNetworkError, moovErrorCode, moovRejectedFields, onboardingLog } from '../onboarding/redact.mjs';
import { validateBusiness, validateRepresentatives } from '../onboarding/store.mjs';
import { APP_USER_EMAIL_GUC, APP_USER_ID_GUC } from '../../cognito.mjs';
import { payeeDeployment } from './flags.mjs';
import {
  acceptPayeeTerms,
  addPayeeBank,
  bankIdOf,
  confirmBankVerification,
  createPayeeAccount,
  disableBank,
  disconnectPayeeAtMoov,
  ensurePayeeCapabilities,
  initiateBankVerification,
  outstandingRequirements,
  patchIndividualIdentity,
  payeeVerdict,
  readBank,
  readBankVerification,
  readPayeeLive,
  submitBusinessIdentity,
} from './moov.mjs';

export const PAYEE_LINK_TTL_DAYS = 14;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const RELATIONSHIPS = new Set(['operating', 'vendor', 'subcontractor', 'overhead', 'insured', 'contractor',
  'supplier', 'sales_rep', 'homeowner', 'other']);

export const PAYEE_CREATE_SQL = 'SELECT public.aws_payee_create($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::uuid, $12::uuid) AS result';
export const PAYEE_REISSUE_SQL = 'SELECT public.aws_payee_reissue_link($1::uuid, $2, $3::timestamptz) AS result';
export const PAYEE_DISCONNECT_SQL = 'SELECT public.aws_payee_disconnect($1::uuid) AS result';
export const PAYEE_BY_TOKEN_SQL = 'SELECT public.aws_public_payee_by_token($1) AS result';
export const PAYEE_RECORD_SQL = 'SELECT public.aws_public_payee_record($1, $2, $3::jsonb) AS result';
export const PAYEE_APPLY_STATUS_SQL = 'SELECT public.aws_payee_apply_status($1, $2, $3) AS result';
export const PAYEE_FIND_SQL = `SELECT id, tenant_id, environment, provider_account_id, stakeholder_account_id
  FROM public.external_payment_recipients
  WHERE ($1::uuid IS NULL OR tenant_id = $1::uuid) AND (id = $2::uuid OR stakeholder_account_id = $2::uuid)
  LIMIT 1`;

const VENDOR_RE = /\bmoov\b/gi;
const scrub = (value) => (typeof value === 'string' ? value.replace(VENDOR_RE, 'payment provider') : value);
const scrubResult = (result) => {
  if (!result || typeof result !== 'object') return result;
  const out = { ...result };
  for (const key of ['error', 'message']) if (typeof out[key] === 'string') out[key] = scrub(out[key]);
  return out;
};

const ok = (body = {}) => jsonResult({ success: true, ...body });
const dbJson = async (client, sql, params) => (await client.query(sql, params)).rows[0]?.result ?? null;
const newToken = () => randomBytes(32).toString('base64url');
const linkExpiry = () => new Date(Date.now() + PAYEE_LINK_TTL_DAYS * 86_400_000).toISOString();
const str = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : '');

const log = (event, fields) => onboardingLog(event, fields);

const moovFailure = (error, { fn, step, environment }) => {
  const code = moovErrorCode(error);
  const rejected = moovRejectedFields(error);
  log('payee_provider_call_failed', { fn, step, environment, error_code: code, status: error?.status ?? null, rejected_fields: rejected });
  if (code === 'moov_rejected') {
    return fail('provider_rejected', 422, {
      message: 'The payment provider did not accept these details. Check them and try again.',
      ...(rejected.length ? { rejected_fields: rejected } : {}),
      liveProviderCalled: true,
    });
  }
  return fail(code.replace(/^moov_/, 'provider_'), 502, { liveProviderCalled: true });
};

// ------------------------------------------------------------ email

async function sendSetupLink(client, { tenantId, email, displayName, token, deps }) {
  try {
    const [{ resolveEmailBranding, emailAssetOrigin }, { renderPayeeSetupEmail, sendPayeeSetupEmail }] = await Promise.all([
      import('../../email-branding.mjs'),
      import('./email.mjs'),
    ]);
    const branding = await resolveEmailBranding(client, { tenantId });
    const payerName = branding.companySubtitle || branding.companyName || 'ChecksOps';
    const origin = typeof deps.appUrl === 'string' && deps.appUrl ? deps.appUrl.replace(/\/$/, '') : emailAssetOrigin();
    const rendered = renderPayeeSetupEmail({
      payeeName: displayName,
      payerName,
      setupUrl: `${origin}/pay-setup/${token}`,
      expiresText: `This link expires in ${PAYEE_LINK_TTL_DAYS} days.`,
      branding,
    });
    const send = typeof deps.sendEmail === 'function' ? deps.sendEmail : sendPayeeSetupEmail;
    const out = await send({
      to: email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      from: branding.from,
      replyTo: branding.replyTo,
      branding,
      production: payeeDeployment() === 'production',
      tenantId,
      messageCategory: 'payee_setup',
    });
    const results = Array.isArray(out?.results) ? out.results : [];
    const emailSent = results.some((r) => r.status === 'sent');
    if (!emailSent) {
      // Status and reason codes only (e.g. blocked / recipient_not_allowlisted,
      // failed / resend_403): never the address, the name or the link.
      const code = (value) => (/^[a-z0-9_]{1,40}$/.test(String(value ?? '')) ? String(value) : null);
      log('payee_setup_email_not_sent', {
        tenant: tenantId, status: code(results[0]?.status), reason: code(results[0]?.reason),
      });
    }
    return {
      email_sent: emailSent,
      email_delivery: results[0]?.status ?? null,
    };
  } catch (error) {
    // The token is in the rendered body: never log the error object or message.
    log('payee_setup_email_failed', { tenant: tenantId, error: error?.code || error?.name || 'error' });
    return { email_sent: false, email_delivery: 'failed' };
  }
}

// ------------------------------------------------------------ tenant side

const TENANT_ERRORS = {
  forbidden: [403, 'Only a member of this organization can set up payees.'],
  not_found: [404, 'Payee not found.'],
  conflict: [409, 'This payee already exists.'],
  disconnected: [409, 'This payee is disconnected.'],
  already_verified: [409, 'This payee has already finished setup.'],
  invalid_name: [400, 'Enter the payee name.'],
  invalid_email: [400, 'Enter a valid email address.'],
  invalid_type: [400, 'Choose individual or business.'],
};

const tenantDbError = (code) => {
  const [status, message] = TENANT_ERRORS[code] || [400, 'The payee could not be saved.'];
  return fail(code === 'forbidden' ? 'tenant_member_required' : `payee_${code}`, status, { message });
};

/** Commits the payee rows before the email goes out; continues with the same identity. */
const commitAndContinue = async (client, mapping) => {
  await client.query('COMMIT');
  await client.query('BEGIN');
  await client.query('SET TRANSACTION READ WRITE');
  await client.query('SELECT set_config($1, $2, true)', [APP_USER_ID_GUC, mapping.application_user_id]);
  await client.query('SELECT set_config($1, $2, true)', [APP_USER_EMAIL_GUC, mapping.email || '']);
};

const optionalUuid = (value, field) => {
  if (value === undefined || value === null || value === '') return { value: null };
  if (!isUuid(value)) return { error: fail('invalid_uuid', 400, { field }) };
  return { value: String(value).toLowerCase() };
};

/** Normalizes a create body (moov-recipient-create or homeowner-bank-link-send). */
export function payeeCreateInput(name, body = {}) {
  const homeowner = name === 'homeowner-bank-link-send';
  const displayName = str(homeowner ? (body.homeowner_name ?? body.display_name ?? body.name) : (body.display_name ?? body.name), 200);
  const email = str(homeowner ? (body.homeowner_email ?? body.email) : body.email, 320).toLowerCase();
  const recipientType = homeowner ? 'individual' : str(body.recipient_type, 20).toLowerCase() || 'individual';
  let relationship = homeowner ? 'homeowner' : str(body.relationship, 40).toLowerCase();
  if (relationship === 'insured') relationship = 'homeowner';
  if (!RELATIONSHIPS.has(relationship)) relationship = 'other';
  if (displayName.length < 2) return { error: fail('payee_invalid_name', 400, { field: 'display_name', message: 'Enter the payee name.' }) };
  if (!EMAIL_RE.test(email)) return { error: fail('payee_invalid_email', 400, { field: 'email', message: 'Enter a valid email address for the payee.' }) };
  if (recipientType !== 'individual' && recipientType !== 'business') {
    return { error: fail('payee_invalid_type', 400, { field: 'recipient_type', message: 'Choose individual or business.' }) };
  }
  const claim = optionalUuid(body.claim_id, 'claim_id');
  if (claim.error) return claim;
  const check = optionalUuid(body.check_id ?? body.check_intake_item_id, 'check_id');
  if (check.error) return check;
  const request = optionalUuid(body.request_id, 'request_id');
  if (request.error) return request;
  return {
    displayName, email, recipientType, relationship,
    claimId: claim.value, checkId: check.value, requestId: request.value,
  };
}

async function createPayee({ client, mapping, ctx, name, body, deps, fetchImpl }) {
  const input = payeeCreateInput(name, body);
  if (input.error) return input.error;
  // A retried request (same request_id) maps to the same recipient id, so Moov
  // (idempotency key, foreignID) and aws_payee_create both replay.
  const recipientId = input.requestId
    ? await idempotencyUuid(`checksops-payee:${ctx.tenantId}:${input.requestId}`)
    : randomUUID();
  const moovContext = await loadOnboardingMoovContext(ctx.environment, deps);
  if (moovContext.error) return moovContext;
  let accountId;
  try {
    ({ accountId } = await withMoovContext({ ...moovContext, fetchImpl }, () => createPayeeAccount({
      environment: ctx.environment,
      recipientId,
      tenantId: ctx.tenantId,
      displayName: input.displayName,
      email: input.email,
      recipientType: input.recipientType,
      fetchImpl,
    })));
  } catch (error) {
    if (error instanceof MoovError) return moovFailure(error, { fn: name, step: 'account_create', environment: ctx.environment });
    throw error;
  }
  if (!accountId) return fail('provider_account_id_missing', 502, { liveProviderCalled: true });
  const token = newToken();
  const expiresAt = linkExpiry();
  const created = await dbJson(client, PAYEE_CREATE_SQL, [
    recipientId, ctx.tenantId, input.displayName, input.email, input.recipientType, input.relationship,
    ctx.environment, accountId, token, expiresAt, input.claimId, input.checkId,
  ]);
  if (!created || created.error) {
    log('payee_create_refused', { tenant: ctx.tenantId, environment: ctx.environment, error_code: created?.error ?? 'no_result' });
    return { ...tenantDbError(created?.error ?? 'failed'), liveProviderCalled: true };
  }
  const recipient = {
    id: created.recipient_id,
    stakeholder_account_id: created.stakeholder_account_id ?? null,
    display_name: input.displayName,
    email: input.email,
    recipient_type: input.recipientType,
    relationship: input.relationship,
    provider_account_id: accountId,
    environment: ctx.environment,
    onboarding_status: 'invited',
  };
  if (created.replayed === true) {
    // The stored link token is the first request's: no new email (use resend).
    return ok({
      recipient_id: created.recipient_id, stakeholder_account_id: recipient.stakeholder_account_id,
      status: 'invited', replayed: true, email_sent: false, email_delivery: null,
      setup_link_returned: false, recipient, liveProviderCalled: true,
    });
  }
  await commitAndContinue(client, mapping);
  const email = await sendSetupLink(client, {
    tenantId: ctx.tenantId, email: input.email, displayName: input.displayName, token, deps,
  });
  return ok({
    recipient_id: created.recipient_id,
    stakeholder_account_id: recipient.stakeholder_account_id,
    status: 'invited',
    replayed: false,
    ...email,
    link_expires_at: expiresAt,
    setup_link_returned: false,
    recipient,
    ...(name === 'homeowner-bank-link-send' ? { payout_url: null } : {}),
    liveProviderCalled: true,
  });
}

const findPayee = async (client, tenantId, body) => {
  const id = body.recipient_id ?? body.external_recipient_id ?? body.stakeholder_account_id ?? null;
  if (!isUuid(id)) return { error: fail('invalid_uuid', 400, { field: 'recipient_id' }) };
  const row = (await client.query(PAYEE_FIND_SQL, [tenantId, String(id).toLowerCase()])).rows[0];
  if (!row) return { error: fail('payee_not_found', 404, { message: 'Payee not found.' }) };
  return { row };
};

async function resendLink({ client, mapping, ctx, body, deps }) {
  const found = await findPayee(client, ctx.tenantId, body);
  if (found.error) return found.error;
  if (found.row.environment !== ctx.environment) {
    return fail('payee_environment_mismatch', 409, { message: 'This payee belongs to another payment environment.' });
  }
  const token = newToken();
  const expiresAt = linkExpiry();
  const reissued = await dbJson(client, PAYEE_REISSUE_SQL, [found.row.id, token, expiresAt]);
  if (!reissued || reissued.error) return tenantDbError(reissued?.error ?? 'failed');
  await commitAndContinue(client, mapping);
  const email = await sendSetupLink(client, {
    tenantId: ctx.tenantId, email: reissued.email, displayName: reissued.display_name, token, deps,
  });
  return ok({ recipient_id: reissued.recipient_id, ...email, link_expires_at: expiresAt, setup_link_returned: false });
}

async function disconnectPayee({ client, mapping, ctx, body, deps, fetchImpl }) {
  const found = await findPayee(client, ctx.tenantId, body);
  if (found.error) return found.error;
  const done = await dbJson(client, PAYEE_DISCONNECT_SQL, [found.row.id]);
  if (!done || done.error) return tenantDbError(done?.error ?? 'failed');
  await commitAndContinue(client, mapping);
  // Best-effort at the provider: the database disconnect already stands.
  let provider = { attempted: false };
  if (done.provider_account_id && done.environment === ctx.environment) {
    const moovContext = await loadOnboardingMoovContext(ctx.environment, deps);
    if (!moovContext.error) {
      provider = {
        attempted: true,
        ...(await withMoovContext({ ...moovContext, fetchImpl }, () => disconnectPayeeAtMoov(done.provider_account_id, fetchImpl))),
      };
    }
    if (provider.bank_errors || provider.account_disconnected === false) {
      log('payee_provider_disconnect_incomplete', { tenant: ctx.tenantId, environment: ctx.environment, bank_errors: provider.bank_errors ?? null });
    }
  }
  return ok({
    recipient_id: done.recipient_id,
    stakeholder_account_id: done.stakeholder_account_id ?? null,
    disconnected: true,
    provider,
    liveProviderCalled: provider.attempted === true,
  });
}

const TENANT_HANDLERS = {
  'moov-recipient-create': createPayee,
  'homeowner-bank-link-send': createPayee,
  'moov-recipient-link-resend': resendLink,
  'moov-recipient-disconnect': disconnectPayee,
};

async function runTenantPayee(name, event, deps, deployment) {
  const { withIdentityWrite } = await import('../../data.mjs');
  return withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    const base = { spoofFieldsIgnored: spoof, applicationUserId: mapping.application_user_id };
    let scoped = body;
    if (!body?.tenant_id && (name === 'moov-recipient-disconnect' || name === 'moov-recipient-link-resend')) {
      // The Settings page sends only the stakeholder id: the tenant is the payee's own
      // (visible to this user under the SELECT policy), then membership is checked.
      const found = await findPayee(client, null, body || {});
      if (found.error) return { ...found.error, ...base };
      scoped = { ...body, tenant_id: found.row.tenant_id };
    }
    const who = await resolveOnboardingAccess(client, { userId: mapping.application_user_id, body: scoped, access: 'submit' });
    if (who.error) return { ...who, ...base };
    // SQL 113 checks tenant membership itself (aws_user_tenant_ids()): a platform
    // owner who is not a member is refused here, before any provider call.
    if (who.member !== true) {
      return { ...fail('tenant_member_required', 403, { message: 'Only a member of this organization can set up payees.' }), ...base };
    }
    const env = await resolveOnboardingEnvironment(client, who.tenantId, deployment);
    if (env.error) return { ...env, ...base };
    const ctx = { tenantId: who.tenantId, environment: env.environment, userId: mapping.application_user_id };
    const fetchImpl = deps.fetchImpl || fetch;
    try {
      const result = await TENANT_HANDLERS[name]({ client, mapping, ctx, name, body: scoped, deps, fetchImpl });
      return {
        ...scrubResult(result),
        ...base,
        authUid: mapping.application_user_id,
        cognitoSub: claims.sub,
        environment: ctx.environment,
        productionExecution: ctx.environment === 'production',
      };
    } catch (error) {
      if (error instanceof MoovError) return { ...moovFailure(error, { fn: name, step: 'tenant', environment: ctx.environment }), ...base };
      if (isNetworkError(error)) return { ...fail('provider_unreachable', 502), ...base, environment: ctx.environment };
      log('payee_handler_failed', { fn: name, tenant: ctx.tenantId, environment: ctx.environment, error: error?.code || error?.name || 'error' });
      throw error;
    }
  }, deps);
}

// ------------------------------------------------------------ public side

const LINK_ERRORS = {
  not_found: [404, 'link_invalid', 'This link is not valid.'],
  expired: [410, 'link_expired', 'This link has expired. Ask the sender for a new one.'],
  disconnected: [410, 'link_closed', 'This payment setup was cancelled by the sender.'],
  rate_limited: [429, 'rate_limited', 'Too many attempts. Ask the sender for a new link.'],
  bank_mismatch: [409, 'bank_mismatch', 'The bank account changed. Reload the page.'],
  invalid_bank_account: [502, 'provider_bank_account_invalid', 'The bank account could not be saved.'],
  invalid_last_four: [502, 'provider_bank_account_invalid', 'The bank account could not be saved.'],
  invalid_account_type: [400, 'invalid_account_type', 'Choose checking or savings.'],
  conflict: [409, 'bank_conflict', 'This bank account is already set up for another payee.'],
};

const linkError = (code) => {
  const [status, error, message] = LINK_ERRORS[code] || [400, 'setup_step_refused', 'This step could not be saved.'];
  return fail(error, status, { message });
};

const openPublicClient = async (deps = {}) => {
  const [{ loadDatabaseCredentials }, { buildWriteClientConfig }] = await Promise.all([
    import('../../secrets.mjs'),
    import('../../db-health.mjs'),
  ]);
  const loadCredentials = deps.loadDatabaseCredentials || loadDatabaseCredentials;
  const createClient = deps.createClient || (async (config) => {
    const { default: pg } = await import('pg');
    return new pg.Client(config);
  });
  const credentials = await loadCredentials();
  const client = await createClient(buildWriteClientConfig(credentials, { queryTimeoutMillis: 12000 }));
  await client.connect();
  return client;
};

/** Commits what is recorded so far (a later failure cannot undo a completed step). */
const checkpoint = async (client) => {
  await client.query('COMMIT');
  await client.query('BEGIN');
  await client.query('SET TRANSACTION READ WRITE');
};

const record = async (client, token, event, data = {}) => dbJson(client, PAYEE_RECORD_SQL, [token, event, JSON.stringify(data)]);

const clientIp = (event) => {
  const lower = Object.fromEntries(Object.entries(event?.headers || {}).map(([k, v]) => [String(k).toLowerCase(), v]));
  return String(event?.requestContext?.http?.sourceIp || '').trim()
    || String(lower['x-forwarded-for'] || '').split(',')[0].trim()
    || '';
};
const userAgent = (event) => {
  const lower = Object.fromEntries(Object.entries(event?.headers || {}).map(([k, v]) => [String(k).toLowerCase(), v]));
  return String(lower['user-agent'] || '').slice(0, 512) || 'unknown';
};

/**
 * Reads Moov, records what Moov already confirms (terms, the recorded bank
 * verified), and applies Moov's verdict through aws_payee_apply_status:
 * verified only when Moov says complete; failed when Moov failed it;
 * pending_review once every step is done and Moov is reviewing.
 */
async function syncPayee(ctx, live = null) {
  const { client, token, fetchImpl } = ctx;
  let rec = ctx.rec;
  const accountId = rec.provider_account_id;
  live = live || await readPayeeLive(accountId, fetchImpl);
  let verdict = payeeVerdict(live, { bankAccountId: rec.provider_bank_account_id });
  if (verdict.tos && !rec.tos_accepted_at) {
    const next = await record(client, token, 'tos_accepted');
    if (next && !next.error) rec = next;
  }
  if (verdict.bankVerified && !rec.bank_verified_at && rec.provider_bank_account_id) {
    const next = await record(client, token, 'bank_verified', { provider_bank_account_id: rec.provider_bank_account_id });
    if (next && !next.error) rec = next;
  }
  if (rec.identity_submitted_at && !rec.verified_at) {
    try {
      if (await ensurePayeeCapabilities(accountId, live, fetchImpl)) {
        live = await readPayeeLive(accountId, fetchImpl);
        verdict = payeeVerdict(live, { bankAccountId: rec.provider_bank_account_id });
      }
    } catch (error) {
      if (!(error instanceof MoovError)) throw error;
      log('payee_capability_request_failed', { environment: rec.environment, error_code: moovErrorCode(error) });
    }
  }
  let applied = null;
  if (!rec.verified_at) {
    const allStepsDone = Boolean(rec.tos_accepted_at && rec.identity_submitted_at && rec.bank_verified_at);
    let status = null;
    if (verdict.status === 'verified' && allStepsDone) status = 'verified';
    else if (verdict.status === 'failed') status = rec.onboarding_status === 'failed' ? null : 'failed';
    else if (verdict.status === 'pending_review' && allStepsDone && rec.onboarding_status !== 'pending_review') status = 'pending_review';
    if (status) {
      applied = await dbJson(client, PAYEE_APPLY_STATUS_SQL, [rec.environment, accountId, status]);
      if (applied?.error) {
        log('payee_status_not_applied', { environment: rec.environment, status, error_code: applied.error });
      } else {
        const next = await dbJson(client, PAYEE_BY_TOKEN_SQL, [token]);
        if (next && !next.error) rec = next;
      }
    }
  }
  ctx.rec = rec;
  return { live, verdict, rec, applied: applied && !applied.error ? applied.status : null };
}

const statusOut = (sync) => ({
  complete: Boolean(sync.rec.verified_at),
  status: sync.rec.verified_at ? 'verified' : (sync.rec.onboarding_status ?? null),
});

async function sessionView(ctx, sync) {
  const { rec, live, verdict } = sync;
  const caps = live.capabilities || [];
  const capsOk = live.capabilitiesReadOk === true;
  let bankState = null;
  if (rec.provider_bank_account_id) {
    const bank = (live.banks || []).find((b) => bankIdOf(b) === String(rec.provider_bank_account_id)) || null;
    const verification = bank && !verdict.bankVerified
      ? await readBankVerification(rec.provider_account_id, rec.provider_bank_account_id, ctx.fetchImpl)
      : null;
    bankState = interpretRecipientBankVerification({ bank, verification });
  }
  let payer = { name: rec.tenant_name || 'ChecksOps', logo_url: null, primary_color: null, secondary_color: null };
  try {
    const { resolveEmailBranding } = await import('../../email-branding.mjs');
    const branding = await resolveEmailBranding(ctx.client, { tenantId: rec.tenant_id });
    payer = { ...payer, logo_url: branding.logoUrl || null, primary_color: branding.primaryColor || null };
  } catch { /* the payer name alone is enough */ }
  const termsAccepted = Boolean(rec.tos_accepted_at) || verdict.tos === true;
  return {
    recipient: {
      id: rec.recipient_id,
      name: rec.display_name,
      status: rec.verified_at ? 'verified' : rec.onboarding_status,
      recipient_type: rec.recipient_type,
      bank_linked: Boolean(rec.provider_bank_account_id),
      bank_name: rec.provider_bank_name ?? null,
      last_four: rec.provider_last_four ?? null,
    },
    onboarding: {
      terms_accepted: termsAccepted,
      tos_requirement_outstanding: capsOk ? tosRequirementOutstanding(caps) : !termsAccepted,
      verification_status: rec.verified_at ? 'verified' : (verdict.verification || 'unverified'),
      identity_submitted: Boolean(rec.identity_submitted_at),
      identity_requirements_outstanding: capsOk ? outstandingRequirements(caps).filter((n) => !/bank/i.test(n)) : [],
      identity_requirements_known: capsOk,
      bank_verified: Boolean(rec.bank_verified_at) || verdict.bankVerified === true,
      bank_status: bankState?.bank_status ?? null,
      bank_verification_method: bankState?.method ?? null,
      bank_verification_status: bankState?.verification_status ?? null,
      bank_micro_deposits_initiated: bankState?.initiated === true,
      bank_can_confirm: bankState?.can_confirm === true,
      bank_should_initiate: bankState?.should_initiate === true,
      complete: Boolean(rec.verified_at),
      status: rec.verified_at ? 'verified' : (verdict.status ?? rec.onboarding_status ?? null),
      live: true,
    },
    payer,
    environment: rec.environment,
    token: null,
    server_accept: true,
    accept_with: 'moov-recipient-tos-accept',
  };
}

async function publicSession(ctx) {
  const sync = await syncPayee(ctx);
  return ok({ ...(await sessionView(ctx, sync)), liveProviderCalled: true });
}

async function publicTosAccept(ctx) {
  const { body, event, client, token, fetchImpl } = ctx;
  if (body.accepted !== true) {
    return fail('terms_acceptance_required', 400, { message: 'Check the box to accept the terms before continuing.' });
  }
  if (ctx.rec.tos_accepted_at) {
    const sync = await syncPayee(ctx);
    return ok({ already_accepted: true, terms_accepted: true, ...statusOut(sync), liveProviderCalled: true });
  }
  const accepted = await acceptPayeeTerms(ctx.rec.provider_account_id, { ip: clientIp(event), userAgent: userAgent(event), fetchImpl });
  if (!accepted.confirmed) return fail(accepted.error || 'terms_not_recorded', 502, { liveProviderCalled: true });
  const next = await record(client, token, 'tos_accepted');
  if (!next || next.error) return linkError(next?.error);
  ctx.rec = next;
  await checkpoint(client);
  const sync = await syncPayee(ctx, accepted.live);
  return ok({ already_accepted: accepted.alreadyAccepted, terms_accepted: true, ...statusOut(sync), liveProviderCalled: true });
}

/** Flat (current page) or nested address fields for an individual. */
const individualInput = (body, rec) => {
  const a = body.address && typeof body.address === 'object' ? body.address : {};
  return {
    first_name: body.first_name ?? body.firstName,
    last_name: body.last_name ?? body.lastName,
    email: str(body.email, 120) || rec.email,
    phone: body.phone,
    address_line1: body.address_line1 ?? a.line1 ?? a.addressLine1,
    address_line2: body.address_line2 ?? a.line2 ?? a.addressLine2,
    city: body.city ?? a.city,
    state: body.state ?? a.state ?? a.stateOrProvince,
    postal_code: body.postal_code ?? a.postal_code ?? a.postalCode,
    birth_date: body.birth_date ?? body.birthDate ?? body.dob,
    ssn: body.ssn,
  };
};

async function publicIdentity(ctx) {
  const { body, client, token, fetchImpl, rec } = ctx;
  if (rec.verified_at) return fail('already_verified', 409, { message: 'Your payment details are already verified.' });
  const accountId = rec.provider_account_id;
  try {
    if (rec.recipient_type === 'business') {
      let validated;
      try {
        const { fields, ein } = validateBusiness({ ...(body.business || {}), email: body.business?.email || rec.email }, null);
        const reps = validateRepresentatives(body.representatives ?? [], new Map());
        if (!reps || reps.length === 0) {
          return fail('validation_failed', 400, { field: 'representatives', message: 'Add the business owners and the person who controls the business.' });
        }
        validated = { fields, ein, reps };
      } catch (error) {
        if (error instanceof OnboardingError) return fail(error.code, error.statusCode, { ...error.extra });
        throw error;
      }
      await submitBusinessIdentity(accountId, validated, fetchImpl);
      validated = null;
    } else {
      let patch = buildIndividualKycPatch(individualInput(body, rec));
      if (!patch.ok) {
        return fail('identity_fields_incomplete', 400, { missing: patch.missing, message: 'Complete every field to continue.' });
      }
      await patchIndividualIdentity(accountId, patch.body, fetchImpl);
      patch = null;
    }
  } catch (error) {
    if (error instanceof MoovError) return moovFailure(error, { fn: 'moov-recipient-kyc-update', step: 'identity', environment: rec.environment });
    throw error;
  }
  const next = await record(client, token, 'identity_submitted');
  if (!next || next.error) return linkError(next?.error);
  ctx.rec = next;
  await checkpoint(client);
  const sync = await syncPayee(ctx);
  return ok({ identity_submitted: true, ...statusOut(sync), liveProviderCalled: true });
}

async function publicBankAdd(ctx) {
  const { body, client, token, fetchImpl, rec } = ctx;
  const accountId = rec.provider_account_id;
  if (!rec.identity_submitted_at) {
    return fail('identity_required', 409, { message: 'Verify your identity before adding a bank account.' });
  }
  const live = await readPayeeLive(accountId, fetchImpl);
  if (!rec.tos_accepted_at && !payeeVerdict(live).tos) {
    return fail('tos_required', 409, { message: 'Accept the terms before adding a bank account.' });
  }
  if (rec.provider_bank_account_id && body.replace_bank !== true && body.replaceBank !== true) {
    const sync = await syncPayee(ctx, live);
    return ok({
      resumed: true, bank_name: sync.rec.provider_bank_name ?? null, last_four: sync.rec.provider_last_four ?? null,
      bank_verified: Boolean(sync.rec.bank_verified_at), ...statusOut(sync), liveProviderCalled: true,
    });
  }
  const holderName = str(body.holder_name, 128);
  const holderType = body.holder_type === 'business' || body.holder_type === 'individual'
    ? body.holder_type
    : (rec.recipient_type === 'business' ? 'business' : 'individual');
  const bankAccountType = body.bank_account_type === 'savings' ? 'savings' : 'checking';
  let routingNumber = String(body.routing_number ?? '').replace(/\D/g, '');
  let accountNumber = String(body.account_number ?? '').replace(/\D/g, '');
  if (holderName.length < 2) return fail('invalid_holder_name', 400, { field: 'holder_name', message: 'Enter the account holder name as it appears at the bank.' });
  if (!/^\d{9}$/.test(routingNumber)) return fail('invalid_routing_number', 400, { field: 'routing_number', message: 'Routing number must be exactly 9 digits.' });
  if (!/^\d{4,17}$/.test(accountNumber)) return fail('invalid_account_number', 400, { field: 'account_number', message: 'Account number must be between 4 and 17 digits.' });
  let created;
  try {
    created = await addPayeeBank(accountId, { holderName, holderType, bankAccountType, routingNumber, accountNumber }, fetchImpl);
  } catch (error) {
    if (error instanceof MoovError) return moovFailure(error, { fn: 'moov-recipient-bank-add', step: 'bank_add', environment: rec.environment });
    throw error;
  }
  const bankAccountId = bankIdOf(created);
  const fromMoov = String(created?.lastFourAccountNumber ?? '');
  const lastFour = /^\d{4}$/.test(fromMoov) ? fromMoov : accountNumber.slice(-4);
  routingNumber = null;
  accountNumber = null;
  if (!bankAccountId) return fail('provider_bank_account_id_missing', 502, { liveProviderCalled: true });
  const previousBank = rec.provider_bank_account_id;
  const next = await record(client, token, 'bank_linked', {
    provider_bank_account_id: bankAccountId,
    bank_name: created?.bankName ?? null,
    last_four: lastFour,
    account_type: bankAccountType,
    holder_name: holderName,
  });
  if (!next || next.error) return linkError(next?.error);
  ctx.rec = next;
  await checkpoint(client);
  if (previousBank && previousBank !== bankAccountId) {
    await disableBank(accountId, previousBank, fetchImpl).catch(() => {
      log('payee_previous_bank_not_removed', { environment: rec.environment });
    });
  }
  const sync = await syncPayee(ctx);
  return ok({
    bank_name: next.provider_bank_name ?? null,
    last_four: next.provider_last_four ?? null,
    bank_status: String(created?.status ?? 'new').toLowerCase(),
    bank_verified: Boolean(sync.rec.bank_verified_at),
    ...statusOut(sync),
    liveProviderCalled: true,
  });
}

async function publicBankVerify(ctx) {
  const { body, client, token, fetchImpl } = ctx;
  const action = String(body.action ?? '').toLowerCase();
  if (action !== 'initiate' && action !== 'confirm') return fail('invalid_action', 400, { message: 'action must be initiate or confirm.' });
  const { provider_account_id: accountId, provider_bank_account_id: bankAccountId } = ctx.rec;
  if (!bankAccountId) return fail('bank_required', 409, { message: 'Add a bank account first.' });
  const markVerified = async () => {
    if (!ctx.rec.bank_verified_at) {
      const next = await record(client, token, 'bank_verified', { provider_bank_account_id: bankAccountId });
      if (!next || next.error) return linkError(next?.error);
      ctx.rec = next;
      await checkpoint(client);
    }
    return null;
  };
  const bank = await readBank(accountId, bankAccountId, fetchImpl);
  const verification = await readBankVerification(accountId, bankAccountId, fetchImpl);
  const interpreted = interpretRecipientBankVerification({ bank, verification });
  if (interpreted.verified) {
    const refused = await markVerified();
    if (refused) return refused;
    const sync = await syncPayee(ctx);
    return ok({ already_verified: true, bank_verified: true, ...statusOut(sync), liveProviderCalled: true });
  }
  if (action === 'initiate') {
    if (!shouldInitiateInstantMicroDeposit({ bank, verification })) {
      return ok({ already_initiated: true, initiated: interpreted.initiated, bank_verified: false, complete: false, liveProviderCalled: true });
    }
    try {
      await initiateBankVerification(accountId, bankAccountId, fetchImpl);
    } catch (error) {
      if (!(error instanceof MoovError) || !initiateAlreadyOpenError(error.message)) {
        if (error instanceof MoovError) return moovFailure(error, { fn: 'moov-recipient-bank-verify', step: 'initiate', environment: ctx.rec.environment });
        throw error;
      }
    }
    return ok({ initiated: true, bank_verified: false, complete: false, liveProviderCalled: true });
  }
  const verifyBody = moovInstantVerifyBody(body.code);
  if (!verifyBody) return fail('invalid_code_format', 400, { field: 'code', message: 'Enter the 4-digit verification code.' });
  try {
    await confirmBankVerification(accountId, bankAccountId, verifyBody, fetchImpl);
  } catch (error) {
    if (!(error instanceof MoovError)) throw error;
    log('payee_bank_code_refused', { environment: ctx.rec.environment, error_code: moovErrorCode(error) });
    return fail('invalid_code', 409, {
      message: 'That code did not match. Check the $0.01 deposit description and try again.',
      liveProviderCalled: true,
    });
  }
  const refreshed = await readBank(accountId, bankAccountId, fetchImpl);
  if (!interpretRecipientBankVerification({ bank: refreshed }).verified) {
    return fail('bank_not_verified', 502, { message: 'The bank is not verified yet. Try again in a minute.', liveProviderCalled: true });
  }
  const refused = await markVerified();
  if (refused) return refused;
  const sync = await syncPayee(ctx);
  return ok({ bank_verified: true, ...statusOut(sync), liveProviderCalled: true });
}

const PUBLIC_HANDLERS = {
  'moov-recipient-session': publicSession,
  'moov-recipient-tos-accept': publicTosAccept,
  'moov-recipient-kyc-update': publicIdentity,
  'moov-recipient-bank-add': publicBankAdd,
  'moov-recipient-bank-verify': publicBankVerify,
};

async function runPublicPayee(name, event, deps, deployment) {
  const { parseBody } = await import('../../data.mjs');
  const body = parseBody(event) || {};
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  // Malformed tokens never reach the database.
  if (!TOKEN_RE.test(token)) return linkError('not_found');
  let client;
  let open = false;
  try {
    client = await openPublicClient(deps);
    await client.query('BEGIN');
    open = true;
    await client.query('SET TRANSACTION READ WRITE');
    const rec = await dbJson(client, PAYEE_BY_TOKEN_SQL, [token]);
    if (!rec || rec.error) {
      await client.query('ROLLBACK');
      open = false;
      return linkError(rec?.error ?? 'not_found');
    }
    // A payee row is bound to the environment it was created in; this deployment
    // serves only its own (staging never production, production never sandbox).
    if (rec.environment !== deployment || !rec.provider_account_id) {
      await client.query('ROLLBACK');
      open = false;
      return fail('payee_environment_mismatch', 409, { message: 'This link cannot be used here.' });
    }
    const moovContext = await loadOnboardingMoovContext(rec.environment, deps);
    if (moovContext.error) {
      await client.query('ROLLBACK');
      open = false;
      return scrubResult(moovContext);
    }
    const fetchImpl = deps.fetchImpl || fetch;
    const ctx = { client, token, rec, body, event, fetchImpl, deps };
    const result = await withMoovContext({ ...moovContext, fetchImpl }, () => PUBLIC_HANDLERS[name](ctx));
    await client.query('COMMIT');
    open = false;
    return {
      ...scrubResult(result),
      environment: rec.environment,
      productionExecution: rec.environment === 'production',
      publicLink: true,
    };
  } catch (error) {
    if (client && open) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    if (error instanceof MoovError) return scrubResult(moovFailure(error, { fn: name, step: 'public', environment: deployment }));
    if (isNetworkError(error)) return fail('provider_unreachable', 502);
    log('payee_public_failed', { fn: name, environment: deployment, error: error?.code || error?.name || 'error' });
    return fail('payee_setup_unavailable', 503, { message: 'Payment setup is temporarily unavailable. Try again shortly.' });
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
}

// ------------------------------------------------------------ entry

export const PAYEE_TENANT_FUNCTION_NAMES = Object.freeze(Object.keys(TENANT_HANDLERS));
export const PAYEE_PUBLIC_FUNCTION_NAMES = Object.freeze(Object.keys(PUBLIC_HANDLERS));
export const PAYEE_FUNCTION_NAMES = Object.freeze([...PAYEE_TENANT_FUNCTION_NAMES, ...PAYEE_PUBLIC_FUNCTION_NAMES]);
export const isPayeeFunction = (name) => PAYEE_FUNCTION_NAMES.includes(name);
export const isPublicPayeeFunction = (name) => PAYEE_PUBLIC_FUNCTION_NAMES.includes(name);

/**
 * Entry point used by providers.mjs before the production hard block. Returns
 * null when payee setup is disabled for this deployment, so the caller's
 * production_execution_blocked (or sandbox stub) answers instead.
 */
export async function handlePayeeFunction(name, event, deps = {}) {
  if (!isPayeeFunction(name)) return null;
  const deployment = payeeDeployment();
  if (!deployment) return null;
  if (isPublicPayeeFunction(name)) return runPublicPayee(name, event, deps, deployment);
  return runTenantPayee(name, event, deps, deployment);
}
