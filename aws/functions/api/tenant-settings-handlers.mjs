/**
 * Tenant-scoped settings writes that stay independent of AWS_WRITES_ENABLED.
 * Billing save records ACH consent only — it never starts a collection.
 */
import { ignoredSpoof, parseBody, withIdentity } from './data.mjs';
import { resolveTenantAccess } from './tenant-email-domain.mjs';
import { setMoneyWriteFlag } from './money-write-flag.mjs';

export const BILLING_ACH_CONSENT_VERSION = '2026-01-ach-debit-v1';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_RE.test(String(value || ''));

const missingTenant = (spoof) => ({
  ok: false,
  statusCode: 400,
  error: 'missing_tenant',
  spoofFieldsIgnored: spoof,
});

const denied = (spoof, extra = {}) => ({
  ok: false,
  statusCode: extra.statusCode || 403,
  error: extra.error || 'not_authorized',
  message: extra.message || 'Not authorized',
  spoofFieldsIgnored: spoof,
  ...extra,
});

// Owner policy: every member of the tenant is a user with the same rights; partners and other tenants do not act.
// resolveTenantAccess sets canConfigure for any member of the tenant.
const canManageTenantSettings = (access) => Boolean(access?.canConfigure);

const requireTenant = async (client, mapping, body, spoof) => {
  const tenantId = body.tenantId || body.tenant_id;
  if (!isUuid(tenantId)) return { error: missingTenant(spoof) };
  const access = await resolveTenantAccess(client, mapping, tenantId);
  if (!access.canView) return { error: denied(spoof, { error: 'cross_tenant_denied' }) };
  return { tenantId, access };
};

const loadStakeholderForBilling = async (client, tenantId, stakeholderId) => {
  const row = (await client.query(
    `SELECT id, tenant_id, nickname, custname, acct_type, chk_acct, chk_aba,
            verification_status, is_active, provider, provider_account_id,
            provider_bank_account_id, provider_last_four, origin
     FROM public.stakeholder_accounts
     WHERE id = $1::uuid AND tenant_id = $2::uuid
     LIMIT 1`,
    [stakeholderId, tenantId],
  )).rows[0] || null;
  return row;
};

const loadConnectedPaymentMethod = async (client, tenantId, {
  paymentMethodId = null,
  lastFour = null,
  providerBankAccountId = null,
} = {}) => {
  if (isUuid(paymentMethodId) || (paymentMethodId && String(paymentMethodId).length > 4)) {
    const byId = (await client.query(
      `SELECT id, tenant_id, provider_account_id, provider_payment_method_id, provider_bank_account_id,
              holder_name, last_four, verification_status, connection_status, environment
       FROM public.payment_provider_methods
       WHERE tenant_id = $1::uuid
         AND (id::text = $2 OR provider_payment_method_id = $2)
       LIMIT 1`,
      [tenantId, String(paymentMethodId)],
    ).catch(() => ({ rows: [] }))).rows[0];
    if (byId) return byId;
  }
  if (providerBankAccountId) {
    const byBank = (await client.query(
      `SELECT id, tenant_id, provider_account_id, provider_payment_method_id, provider_bank_account_id,
              holder_name, last_four, verification_status, connection_status, environment
       FROM public.payment_provider_methods
       WHERE tenant_id = $1::uuid AND provider_bank_account_id = $2
       ORDER BY updated_at DESC NULLS LAST
       LIMIT 1`,
      [tenantId, providerBankAccountId],
    ).catch(() => ({ rows: [] }))).rows[0];
    if (byBank) return byBank;
  }
  if (lastFour) {
    return (await client.query(
      `SELECT id, tenant_id, provider_account_id, provider_payment_method_id, provider_bank_account_id,
              holder_name, last_four, verification_status, connection_status, environment
       FROM public.payment_provider_methods
       WHERE tenant_id = $1::uuid
         AND last_four = $2
         AND connection_status = 'connected'
       ORDER BY updated_at DESC NULLS LAST
       LIMIT 1`,
      [tenantId, String(lastFour).slice(-4)],
    ).catch(() => ({ rows: [] }))).rows[0] || null;
  }
  return null;
};

const bankEligible = (stakeholder, method, { requireMethod = false } = {}) => {
  const stakeStatus = String(stakeholder?.verification_status || '').toLowerCase();
  if (stakeholder && stakeholder.is_active !== true) return { ok: false, error: 'account_inactive' };
  if (stakeholder && stakeStatus !== 'verified') {
    return { ok: false, error: 'bank_not_verified', verification_status: stakeStatus || 'unverified' };
  }
  const checkMethod = Boolean(method) && (requireMethod || !stakeholder);
  if (checkMethod) {
    const methodStatus = String(method.verification_status || '').toLowerCase();
    const connected = String(method.connection_status || '') === 'connected';
    if (!connected) return { ok: false, error: 'bank_disconnected' };
    if (['errored', 'failed', 'disabled'].includes(methodStatus)) {
      return { ok: false, error: 'bank_not_verified', verification_status: methodStatus };
    }
  }
  if (!stakeholder && !method) return { ok: false, error: 'funding_source_not_found' };
  return { ok: true };
};

const publicAuthorization = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    stakeholder_account_id: row.stakeholder_account_id ?? null,
    nickname: row.nickname ?? null,
    account_holder_name: row.account_holder_name ?? null,
    account_number_last4: row.account_number_last4 ?? null,
    account_type: row.account_type ?? null,
    auto_debit_enabled: row.auto_debit_enabled === true,
    ach_authorized_at: row.ach_authorized_at ?? null,
    verification_status: row.verification_status ?? null,
    consent_version: BILLING_ACH_CONSENT_VERSION,
  };
};

/**
 * Read-only diagnostic for a billing write the database did not apply (owner report, staging 2026-11-01:
 * a member's auto-debit toggle came back billing_update_not_applied with no SQL error). Runs in the same
 * session and transaction, which withIdentity rolls back because the result is ok:false. It reads only
 * this tenant's row count, the session's own write and membership checks, the role name and the table's
 * row-security metadata; it returns booleans, counts and names, never an id, a value of another tenant or
 * a policy expression. Each probe runs in its own savepoint so one failing probe reports its SQLSTATE and
 * does not abort the others or throw.
 */
const BILLING_DIAGNOSTIC_PROBES = Object.freeze([
  ['row_visible', 'SELECT count(*)::int AS v FROM public.tenant_billing_accounts WHERE tenant_id = $1::uuid', (t) => [t]],
  ['can_write_tenant', 'SELECT public.aws_can_write_tenant($1::uuid) AS v', (t) => [t]],
  ['is_tenant_member', 'SELECT public.aws_is_tenant_member($1::uuid) AS v', (t) => [t]],
  ['auth_uid_set', 'SELECT (auth.uid() IS NOT NULL) AS v', () => []],
  ['auth_uid_matches_caller', 'SELECT (auth.uid() IS NOT DISTINCT FROM $1::uuid) AS v', (_t, u) => [u]],
  ['current_user', 'SELECT current_user::text AS v', () => []],
  ['policies', `SELECT COALESCE(json_agg(json_build_object('name', policyname, 'permissive', permissive, 'cmd', cmd, 'roles', roles)
     ORDER BY policyname), '[]'::json) AS v
     FROM pg_catalog.pg_policies WHERE schemaname = 'public' AND tablename = 'tenant_billing_accounts'`, () => []],
  ['rls_enabled', `SELECT c.relrowsecurity AS v FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'tenant_billing_accounts'`, () => []],
  ['rls_forced', `SELECT c.relforcerowsecurity AS v FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'tenant_billing_accounts'`, () => []],
]);

export const billingWriteDiagnostic = async (client, { tenantId, userId = null, returned = undefined }) => {
  const out = {};
  for (const [key, sql, params] of BILLING_DIAGNOSTIC_PROBES) {
    const savepoint = `billing_diag_${key}`;
    try {
      await client.query(`SAVEPOINT ${savepoint}`);
      const row = (await client.query(sql, params(tenantId, isUuid(userId) ? userId : null))).rows?.[0];
      out[key] = row ? (row.v ?? null) : null;
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (error) {
      out[key] = { error: String(error?.code || 'probe_failed') };
      try { await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`); } catch { /* the outer transaction is rolled back anyway */ }
    }
  }
  if (returned !== undefined) {
    out.returned_row = Boolean(returned);
    out.returned_auto_debit_enabled = returned ? returned.auto_debit_enabled === true : null;
  }
  return out;
};

const loadAuthorization = async (client, tenantId) => (
  (await client.query(
    `SELECT id, tenant_id, stakeholder_account_id, nickname, account_holder_name,
            account_number_last4, account_type, auto_debit_enabled, ach_authorized_at,
            ach_authorized_by, verification_status, routing_number, account_number_encrypted
     FROM public.tenant_billing_accounts
     WHERE tenant_id = $1::uuid
     LIMIT 1`,
    [tenantId],
  )).rows[0] || null
);

export const saveTenantBillingAuthorization = async (client, {
  tenantId,
  userId,
  stakeholderId = null,
  paymentMethodId = null,
  autoDebitEnabled = true,
  authorized = false,
}) => {
  let stakeholder = null;
  if (isUuid(stakeholderId)) {
    stakeholder = await loadStakeholderForBilling(client, tenantId, stakeholderId);
    if (!stakeholder) return { ok: false, statusCode: 404, error: 'funding_source_not_found' };
  }
  const lastFour = stakeholder?.chk_acct
    ? String(stakeholder.chk_acct).slice(-4)
    : stakeholder?.provider_last_four || null;
  const method = await loadConnectedPaymentMethod(client, tenantId, {
    paymentMethodId,
    lastFour,
    providerBankAccountId: stakeholder?.provider_bank_account_id || null,
  });
  if (!stakeholder && !method) {
    return { ok: false, statusCode: 404, error: 'funding_source_not_found' };
  }
  if (method && method.tenant_id && method.tenant_id !== tenantId) {
    return { ok: false, statusCode: 403, error: 'cross_tenant_denied' };
  }
  const eligibility = bankEligible(stakeholder, method, { requireMethod: Boolean(paymentMethodId) && !stakeholder });
  if (!eligibility.ok) {
    return { ok: false, statusCode: 409, ...eligibility };
  }
  if (!authorized) {
    return { ok: false, statusCode: 400, error: 'ach_authorization_required' };
  }

  const existing = await loadAuthorization(client, tenantId);
  const holder = method?.holder_name || stakeholder?.custname || stakeholder?.nickname || 'Authorized billing account';
  const digits = method?.last_four || lastFour || '0000';
  const accountType = String(stakeholder?.acct_type || '').toUpperCase() === 'S' ? 'savings' : 'checking';
  const authorizedAt = new Date().toISOString();
  const routing = stakeholder?.chk_aba && /^\d{9}$/.test(String(stakeholder.chk_aba))
    ? String(stakeholder.chk_aba)
    : (existing?.routing_number || '');
  const row = {
    tenant_id: tenantId,
    account_holder_name: holder,
    account_number_last4: String(digits).slice(-4),
    auto_debit_enabled: autoDebitEnabled === true,
    ach_authorized_at: authorizedAt,
    ach_authorized_by: userId,
    verification_status: 'verified',
    stakeholder_account_id: stakeholder?.id || null,
    nickname: stakeholder?.nickname || holder,
    account_type: accountType,
    entity_type: 'business',
    routing_number: routing,
    account_number_encrypted: existing?.account_number_encrypted || '',
  };

  // Server-only money-write flag for the tenant_billing_accounts write (finding 14).
  await setMoneyWriteFlag(client);
  const saved = existing
    ? (await client.query(
      `UPDATE public.tenant_billing_accounts SET
         account_holder_name = $2,
         account_number_last4 = $3,
         auto_debit_enabled = $4,
         ach_authorized_at = $5::timestamptz,
         ach_authorized_by = $6::uuid,
         verification_status = $7,
         stakeholder_account_id = $8::uuid,
         nickname = $9,
         account_type = $10,
         routing_number = COALESCE(NULLIF($11, ''), routing_number),
         updated_at = now()
       WHERE tenant_id = $1::uuid
       RETURNING *`,
      [
        row.tenant_id, row.account_holder_name, row.account_number_last4, row.auto_debit_enabled,
        row.ach_authorized_at, row.ach_authorized_by, row.verification_status,
        row.stakeholder_account_id, row.nickname, row.account_type, row.routing_number,
      ],
    )).rows[0]
    : (await client.query(
      `INSERT INTO public.tenant_billing_accounts (
         tenant_id, account_holder_name, account_number_last4, auto_debit_enabled,
         ach_authorized_at, ach_authorized_by, verification_status, stakeholder_account_id,
         nickname, account_type, entity_type, routing_number, account_number_encrypted
       ) VALUES (
         $1::uuid, $2, $3, $4, $5::timestamptz, $6::uuid, $7, $8::uuid,
         $9, $10, $11, $12, $13
       )
       RETURNING *`,
      [
        row.tenant_id, row.account_holder_name, row.account_number_last4, row.auto_debit_enabled,
        row.ach_authorized_at, row.ach_authorized_by, row.verification_status,
        row.stakeholder_account_id, row.nickname, row.account_type, row.entity_type,
        row.routing_number, row.account_number_encrypted,
      ],
    )).rows[0];
  // A write that changed no row (filtered by row security or anything else) is not a success: report it,
  // so the caller never shows "saved" for a change the database did not make (owner report, 2026-11-01).
  if (!saved || saved.tenant_id !== tenantId) {
    return {
      ok: false,
      statusCode: 409,
      error: 'billing_update_not_applied',
      diagnostic: await billingWriteDiagnostic(client, { tenantId, userId, returned: saved || null }),
    };
  }

  return {
    ok: true,
    charged: false,
    collection_initiated: false,
    consent_version: BILLING_ACH_CONSENT_VERSION,
    authorization: publicAuthorization(saved),
    ignoredClientFields: ['verification_status', 'ach_authorized_at', 'ach_authorized_by', 'amount', 'amount_cents'],
  };
};

export const toggleTenantAutoDebit = async (client, { tenantId, enabled, userId = null }) => {
  const existing = await loadAuthorization(client, tenantId);
  if (!existing) return { ok: false, statusCode: 404, error: 'missing_authorization' };
  await setMoneyWriteFlag(client);
  const rows = (await client.query(
    `UPDATE public.tenant_billing_accounts
     SET auto_debit_enabled = $2::boolean, updated_at = now()
     WHERE tenant_id = $1::uuid
     RETURNING *`,
    [tenantId, enabled === true],
  )).rows;
  // No row changed, or the row does not hold the requested value: not a success (see saveTenantBillingAuthorization).
  const written = rows[0];
  if (!written || written.auto_debit_enabled !== (enabled === true)) {
    return {
      ok: false,
      statusCode: 409,
      error: 'billing_update_not_applied',
      diagnostic: await billingWriteDiagnostic(client, { tenantId, userId, returned: written || null }),
    };
  }
  return {
    ok: true,
    charged: false,
    collection_initiated: false,
    authorization: publicAuthorization(written),
  };
};

export const runSaveTenantBillingAccount = async ({ client, mapping, body, spoof }) => {
  const resolved = await requireTenant(client, mapping, body, spoof);
  if (resolved.error) return resolved.error;
  if (!canManageTenantSettings(resolved.access)) {
    return denied(spoof, {
      message: 'Only the tenant admin, owner, or ChecksOps platform owner can authorize billing.',
    });
  }
  if (body.amount != null || body.amount_cents != null || body.charge === true) {
    /* ignored — save never collects */
  }
  const action = String(body.action || 'save').toLowerCase();
  if (action === 'get' || action === 'snapshot') {
    const authorization = publicAuthorization(await loadAuthorization(client, resolved.tenantId));
    return { ok: true, statusCode: 200, authorization, charged: false, spoofFieldsIgnored: spoof };
  }
  if (action === 'toggle_auto_debit' || (action === 'save' && body.stakeholder_account_id == null
    && body.provider_payment_method_id == null && body.payment_method_id == null
    && 'auto_debit_enabled' in body)) {
    const toggled = await toggleTenantAutoDebit(client, {
      tenantId: resolved.tenantId,
      enabled: body.auto_debit_enabled === true,
      userId: mapping.application_user_id,
    });
    if (!toggled.ok) return denied(spoof, toggled);
    return { ok: true, statusCode: 200, spoofFieldsIgnored: spoof, ...toggled };
  }
  const saved = await saveTenantBillingAuthorization(client, {
    tenantId: resolved.tenantId,
    userId: mapping.application_user_id,
    stakeholderId: body.stakeholder_account_id || body.stakeholderAccountId || null,
    paymentMethodId: body.provider_payment_method_id || body.payment_method_id || null,
    autoDebitEnabled: body.auto_debit_enabled !== false,
    authorized: body.authorized === true || body.authorize_ach === true,
  });
  if (!saved.ok) return denied(spoof, saved);
  return { ok: true, statusCode: 200, spoofFieldsIgnored: spoof, ...saved };
};

// The legacy tenant-company-branding-save route (applyTenantCompanyBranding,
// runSaveTenantCompanyBranding) was retired on 2026-10-17: the SPA saves
// branding through write-app-metadata executeTenantsNarrow, and app-services
// answers the old route with 410 Gone.

const withSettingsWrite = (fn) => (event, deps = {}) => withIdentity(event, fn, {
  write: true,
  commit: true,
  ...deps,
});

export const handleSaveTenantBillingAccount = withSettingsWrite(runSaveTenantBillingAccount);

/**
 * Deprecated compatibility export (release 2026-10-17): the retired
 * tenant-company-branding-save route. A live app-services.mjs from before this
 * release still imports it; it answers 410 and writes nothing. The new
 * app-services.mjs answers the route itself. Remove in a later release.
 */
export const handleSaveTenantCompanyBranding = async (event) => ({
  ok: false,
  statusCode: 410,
  error: 'route_retired',
  message: 'tenant-company-branding-save is retired. Save branding from Settings > Branding.',
  spoofFieldsIgnored: ignoredSpoof(event, parseBody(event)),
});
