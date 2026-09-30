/**
 * Tenant-scoped settings writes that stay independent of AWS_WRITES_ENABLED.
 * Billing save records ACH consent only — it never starts a collection.
 */
import { ignoredSpoof, parseBody, withIdentity } from './data.mjs';
import { isSafeHexColor, isSafeHttpUrl, safeHttpUrl } from './email-branding.mjs';
import { resolveTenantAccess } from './tenant-email-domain.mjs';

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

const clip = (value, max) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text.length > max) return { error: 'invalid_field', field: 'length' };
  return text.length ? text : null;
};

const canManageTenantSettings = (access) => Boolean(
  access?.canConfigure
  || access?.platformAdmin
  || access?.tenantAdmin
  || access?.role === 'owner'
  || access?.role === 'admin',
);

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

  return {
    ok: true,
    charged: false,
    collection_initiated: false,
    consent_version: BILLING_ACH_CONSENT_VERSION,
    authorization: publicAuthorization(saved),
    ignoredClientFields: ['verification_status', 'ach_authorized_at', 'ach_authorized_by', 'amount', 'amount_cents'],
  };
};

export const toggleTenantAutoDebit = async (client, { tenantId, enabled }) => {
  const existing = await loadAuthorization(client, tenantId);
  if (!existing) return { ok: false, statusCode: 404, error: 'missing_authorization' };
  const rows = (await client.query(
    `UPDATE public.tenant_billing_accounts
     SET auto_debit_enabled = $2::boolean, updated_at = now()
     WHERE tenant_id = $1::uuid
     RETURNING *`,
    [tenantId, enabled === true],
  )).rows;
  return {
    ok: true,
    charged: false,
    collection_initiated: false,
    authorization: publicAuthorization(rows[0] || existing),
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

const brandingUrl = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  if (text.startsWith('/') || !text.includes('://')) {
    if (text.length > 512) return { error: 'invalid_field', field: 'logo_url' };
    return text;
  }
  if (!isSafeHttpUrl(text)) return { error: 'invalid_field', field: 'logo_url' };
  return safeHttpUrl(text, null);
};

const brandingColor = (value, field) => {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const text = String(value).trim();
  if (!isSafeHexColor(text)) return { error: 'invalid_field', field };
  return text.length === 4
    ? `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`.toLowerCase()
    : text.toLowerCase();
};

export const TENANT_BRANDING_COLUMNS = Object.freeze([
  'name',
  'business_address',
  'business_phone',
  'email_reply_to',
  'logo_url',
  'invoice_letterhead_url',
  'invoice_footer_note',
  'invoice_default_terms',
  'invoice_accent_color',
  'invoice_theme',
  'primary_color',
  'secondary_color',
]);

export const applyTenantCompanyBranding = async (client, tenantId, values) => {
  const out = {};
  const assign = (column, value) => {
    if (value && value.error) return value;
    if (value !== undefined) out[column] = value;
    return null;
  };
  if ('company_name' in values || 'name' in values) {
    const text = clip(values.company_name ?? values.name, 200);
    const err = assign('name', text);
    if (err) return err;
  }
  if ('company_address' in values || 'business_address' in values || 'address' in values) {
    const text = clip(values.company_address ?? values.business_address ?? values.address, 500);
    const err = assign('business_address', text);
    if (err) return err;
  }
  if ('company_phone' in values || 'business_phone' in values || 'phone' in values) {
    const text = clip(values.company_phone ?? values.business_phone ?? values.phone, 40);
    const err = assign('business_phone', text);
    if (err) return err;
  }
  if ('company_email' in values || 'email_reply_to' in values || 'email' in values) {
    const text = clip(values.company_email ?? values.email_reply_to ?? values.email, 200);
    const err = assign('email_reply_to', text);
    if (err) return err;
  }
  if ('logo_url' in values) {
    const err = assign('logo_url', brandingUrl(values.logo_url));
    if (err) return err;
  }
  if ('invoice_letterhead_url' in values || 'letterhead_url' in values) {
    const err = assign(
      'invoice_letterhead_url',
      brandingUrl(values.invoice_letterhead_url ?? values.letterhead_url),
    );
    if (err) return err;
  }
  if ('invoice_footer_note' in values) {
    const text = clip(values.invoice_footer_note, 2000);
    const err = assign('invoice_footer_note', text);
    if (err) return err;
  }
  if ('invoice_default_terms' in values) {
    const text = clip(values.invoice_default_terms, 4000);
    const err = assign('invoice_default_terms', text);
    if (err) return err;
  }
  if ('invoice_accent_color' in values) {
    const err = assign('invoice_accent_color', brandingColor(values.invoice_accent_color, 'invoice_accent_color'));
    if (err) return err;
  }
  if ('invoice_theme' in values) {
    const theme = String(values.invoice_theme || '').toLowerCase();
    if (theme !== 'light' && theme !== 'dark') return { error: 'invalid_field', field: 'invoice_theme' };
    out.invoice_theme = theme;
  }
  if ('primary_color' in values) {
    const err = assign('primary_color', brandingColor(values.primary_color, 'primary_color'));
    if (err) return err;
  }
  if ('secondary_color' in values) {
    const err = assign('secondary_color', brandingColor(values.secondary_color, 'secondary_color'));
    if (err) return err;
  }
  if (!Object.keys(out).length) return { error: 'missing_required_field', field: 'values' };

  const sets = [];
  const params = [];
  for (const [column, value] of Object.entries(out)) {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  params.push(tenantId);
  const rows = (await client.query(
    `UPDATE public.tenants SET ${sets.join(', ')} WHERE id = $${params.length}::uuid
     RETURNING id, name, business_address, business_phone, email_reply_to, logo_url,
               invoice_letterhead_url, invoice_footer_note, invoice_default_terms,
               invoice_accent_color, invoice_theme, primary_color, secondary_color`,
    params,
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'tenant not writable' };
  return { ok: true, tenant: rows[0], saved: Object.keys(out) };
};

export const runSaveTenantCompanyBranding = async ({ client, mapping, body, spoof }) => {
  const resolved = await requireTenant(client, mapping, body, spoof);
  if (resolved.error) return resolved.error;
  if (!canManageTenantSettings(resolved.access)) {
    return denied(spoof, { message: 'Only tenant administrators can change company branding.' });
  }
  const saved = await applyTenantCompanyBranding(client, resolved.tenantId, body);
  if (saved?.error) {
    return denied(spoof, { statusCode: 400, ...saved });
  }
  return {
    ok: true,
    statusCode: 200,
    saved: true,
    tenant: saved.tenant,
    updatedFields: saved.saved,
    spoofFieldsIgnored: spoof,
  };
};

const withSettingsWrite = (fn) => (event, deps = {}) => withIdentity(event, fn, {
  write: true,
  commit: true,
  ...deps,
});

export const handleSaveTenantBillingAccount = withSettingsWrite(runSaveTenantBillingAccount);
export const handleSaveTenantCompanyBranding = withSettingsWrite(runSaveTenantCompanyBranding);
