/**
 * Tranche-6 application metadata writes (non-financial, non-provider).
 */
import { ident } from './data.mjs';
import { isAllowedTenantDocumentDocType } from './mortgage-library-doc-types.mjs';
import { canManageTenantDocumentLibrary, mortgageAgentCanWriteTenantLossDraft } from './mortgage-library-docs.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_RE.test(String(value || ''));
const eqFilter = (filters, column) => {
  const match = (filters || []).find((filter) => filter?.column === column && (filter.op || 'eq') === 'eq');
  return match?.value ?? null;
};
const clip = (value, max) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text.length > max) return { error: 'invalid_field', field: 'length' };
  return text.length ? text : null;
};

const buildSet = (values, casts = {}) => {
  const sets = [];
  const params = [];
  let i = 1;
  for (const [column, value] of Object.entries(values)) {
    const cast = casts[column] || 'text';
    sets.push(`${ident(column, 'column')} = $${i}::${cast}`);
    params.push(value);
    i += 1;
  }
  return { sets, params, next: i };
};

const memberOfTenant = async (client, userId, tenantId) => {
  const rows = (await client.query(
    `SELECT 1 FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    [userId, tenantId],
  )).rows;
  return rows.length > 0;
};

export const executeNotifications = async ({ client, mapping, op, values, filters }) => {
  if (op !== 'update') return { error: 'operation_not_allowlisted', op };
  if (!('is_read' in values)) return { error: 'missing_required_field', field: 'is_read' };
  const isRead = values.is_read === true || values.is_read === 'true';
  const id = eqFilter(filters, 'id');
  if (id) {
    if (!isUuid(id)) return { error: 'invalid_uuid', field: 'id' };
    const rows = (await client.query(
      `UPDATE public.notifications
       SET is_read = $3::boolean
       WHERE id = $1::uuid AND user_id = $2::uuid
       RETURNING *`,
      [id, mapping.application_user_id, isRead],
    )).rows;
    if (!rows.length) return { error: 'rls_denied', message: 'notification not writable' };
    return { rows };
  }
  // Mark-all-read: only own rows; optional is_read=false filter from UI.
  const rows = (await client.query(
    `UPDATE public.notifications
     SET is_read = $2::boolean
     WHERE user_id = $1::uuid
       AND ($3::boolean IS NULL OR is_read = $3::boolean)
     RETURNING *`,
    [
      mapping.application_user_id,
      isRead,
      (() => {
        const match = (filters || []).find((f) => f?.column === 'is_read' && (f.op || 'eq') === 'eq');
        if (!match) return null;
        if (match.value === true || match.value === 'true') return true;
        if (match.value === false || match.value === 'false') return false;
        return null;
      })(),
    ],
  )).rows;
  return { rows };
};

export const executeTenantDocuments = async ({ client, mapping, op, values, filters }) => {
  if (op === 'insert') {
    const tenantId = values.tenant_id;
    if (!isUuid(tenantId)) return { error: 'invalid_uuid', field: 'tenant_id' };
    if (!(await canManageTenantDocumentLibrary(client, mapping.application_user_id, tenantId))) {
      return { error: 'not_authorized', message: 'Tenant owner or admin required to manage library documents' };
    }
    const docType = clip(values.doc_type, 120);
    if (docType?.error || !docType) return docType?.error || { error: 'missing_required_field', field: 'doc_type' };
    if (!isAllowedTenantDocumentDocType(docType)) {
      return { error: 'category_not_allowlisted', field: 'doc_type' };
    }
    const filePath = clip(values.file_path, 512);
    if (filePath?.error || !filePath) return filePath?.error || { error: 'missing_required_field', field: 'file_path' };
    const fileName = clip(values.file_name, 255);
    if (fileName?.error) return fileName;
    const mime = clip(values.mime_type, 120);
    if (mime?.error) return mime;
    const notes = clip(values.notes, 2000);
    if (notes?.error) return notes;
    const autoShare = values.auto_share_mortgage_ops === true || values.auto_share_mortgage_ops === 'true';
    const rows = (await client.query(
      `INSERT INTO public.tenant_documents (
         tenant_id, doc_type, file_path, file_name, mime_type, file_size,
         auto_share_mortgage_ops, notes, uploaded_by
       ) VALUES (
         $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::bigint,
         $7::boolean, $8::text, $9::uuid
       ) RETURNING *`,
      [
        tenantId,
        docType,
        filePath,
        fileName,
        mime,
        values.file_size == null ? null : Number(values.file_size),
        autoShare,
        notes,
        mapping.application_user_id,
      ],
    )).rows;
    return { rows };
  }
  const id = eqFilter(filters, 'id');
  if (!isUuid(id)) return { error: 'invalid_uuid', field: 'id' };
  const existing = (await client.query(
    `SELECT id, tenant_id FROM public.tenant_documents WHERE id = $1::uuid`,
    [id],
  )).rows[0];
  if (!existing) return { error: 'rls_denied', message: 'document not writable' };
  if (!(await canManageTenantDocumentLibrary(client, mapping.application_user_id, existing.tenant_id))) {
    return { error: 'not_authorized', message: 'Tenant owner or admin required to manage library documents' };
  }
  if (op === 'delete') {
    const rows = (await client.query(
      'DELETE FROM public.tenant_documents WHERE id = $1::uuid RETURNING *',
      [id],
    )).rows;
    if (!rows.length) return { error: 'rls_denied', message: 'document not deletable' };
    return { rows };
  }
  const out = {};
  for (const [col, max] of [['file_name', 255], ['notes', 2000], ['doc_type', 120], ['mime_type', 120]]) {
    if (col in values) {
      const text = clip(values[col], max);
      if (text?.error) return text;
      if (col === 'doc_type' && !isAllowedTenantDocumentDocType(text)) {
        return { error: 'category_not_allowlisted', field: 'doc_type' };
      }
      out[col] = text;
    }
  }
  if ('auto_share_mortgage_ops' in values) {
    out.auto_share_mortgage_ops = values.auto_share_mortgage_ops === true || values.auto_share_mortgage_ops === 'true';
  }
  if (!Object.keys(out).length) return { error: 'missing_required_field', field: 'values' };
  const built = buildSet(out, { auto_share_mortgage_ops: 'boolean' });
  built.params.push(id);
  const rows = (await client.query(
    `UPDATE public.tenant_documents SET ${built.sets.join(', ')}, updated_at = now()
     WHERE id = $${built.next}::uuid RETURNING *`,
    built.params,
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'document not writable' };
  return { rows };
};

export const executeLossDraftDocuments = async ({ client, mapping, op, values, filters }) => {
  const id = eqFilter(filters, 'id');
  if (!isUuid(id)) return { error: 'invalid_uuid', field: 'id' };
  const existing = (await client.query(
    `SELECT d.id, d.loss_draft_id, ld.check_intake_item_id, ci.tenant_id
     FROM public.loss_draft_documents d
     JOIN public.loss_draft_tracking ld ON ld.id = d.loss_draft_id
     LEFT JOIN public.check_intake_items ci ON ci.id = ld.check_intake_item_id
     WHERE d.id = $1::uuid`,
    [id],
  )).rows[0];
  if (!existing) return { error: 'rls_denied', message: 'document not writable' };
  const member = existing.tenant_id
    ? await memberOfTenant(client, mapping.application_user_id, existing.tenant_id)
    : false;
  const agent = await mortgageAgentCanWriteTenantLossDraft(client, mapping.application_user_id, {
    tenantId: existing.tenant_id,
    checkId: existing.check_intake_item_id,
  });
  if (!member && !agent) {
    return { error: 'not_authorized', message: 'Not authorized for this loss draft document' };
  }
  if (op === 'delete') {
    const rows = (await client.query(
      'DELETE FROM public.loss_draft_documents WHERE id = $1::uuid RETURNING *',
      [id],
    )).rows;
    if (!rows.length) return { error: 'rls_denied', message: 'document not deletable' };
    return { rows };
  }
  if (op !== 'update') return { error: 'operation_not_allowlisted', op };
  const out = {};
  for (const [col, max] of [
    ['file_path', 512], ['file_name', 255], ['document_label', 200], ['notes', 2000],
  ]) {
    if (col in values) {
      const text = clip(values[col], max);
      if (text?.error) return text;
      out[col] = text;
    }
  }
  if ('is_submitted' in values) {
    out.is_submitted = values.is_submitted === true || values.is_submitted === 'true';
  }
  if ('submitted_at' in values) {
    out.submitted_at = values.submitted_at || null;
  }
  if (!Object.keys(out).length) return { error: 'missing_required_field', field: 'values' };
  const built = buildSet(out, { is_submitted: 'boolean', submitted_at: 'timestamptz' });
  built.params.push(id);
  const rows = (await client.query(
    `UPDATE public.loss_draft_documents SET ${built.sets.join(', ')}
     WHERE id = $${built.next}::uuid RETURNING *`,
    built.params,
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'document not writable' };
  return { rows };
};

export const executeMortgageCompanies = async ({ client, mapping, op, values, filters }) => {
  if (op === 'insert') {
    const name = clip(values.name, 200);
    if (name?.error || !name) return name?.error || { error: 'missing_required_field', field: 'name' };
    const website = clip(values.website, 300);
    if (website?.error) return website;
    const phone = clip(values.phone, 40);
    if (phone?.error) return phone;
    const email = clip(values.loss_draft_email, 200);
    if (email?.error) return email;
    const ldPhone = clip(values.loss_draft_phone, 40);
    if (ldPhone?.error) return ldPhone;
    const fax = clip(values.loss_draft_fax, 40);
    if (fax?.error) return fax;
    const rows = (await client.query(
      `INSERT INTO public.mortgage_companies (name, is_active, website, phone, loss_draft_email, loss_draft_phone, loss_draft_fax)
       VALUES ($1::text, COALESCE($2::boolean, true), $3::text, $4::text, $5::text, $6::text, $7::text)
       RETURNING *`,
      [
        name,
        values.is_active === false || values.is_active === 'false' ? false : true,
        website,
        phone,
        email,
        ldPhone,
        fax,
      ],
    )).rows;
    return { rows };
  }
  const id = eqFilter(filters, 'id');
  if (!isUuid(id)) return { error: 'invalid_uuid', field: 'id' };
  const out = {};
  for (const [col, max] of [
    ['name', 200], ['website', 300], ['phone', 40],
    ['loss_draft_email', 200], ['loss_draft_phone', 40], ['loss_draft_fax', 40], ['loss_draft_contact', 200],
  ]) {
    if (col in values) {
      const text = clip(values[col], max);
      if (text?.error) return text;
      out[col] = text;
    }
  }
  if ('is_active' in values) out.is_active = values.is_active === true || values.is_active === 'true';
  if (!Object.keys(out).length) return { error: 'missing_required_field', field: 'values' };
  const built = buildSet(out, { is_active: 'boolean' });
  built.params.push(id);
  const rows = (await client.query(
    `UPDATE public.mortgage_companies SET ${built.sets.join(', ')} WHERE id = $${built.next}::uuid RETURNING *`,
    built.params,
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'mortgage company not writable' };
  return { rows };
};

export const executeSharedCheckMessages = async ({ client, mapping, op, values, filters }) => {
  if (op !== 'insert') return { error: 'operation_not_allowlisted', op };
  const checkId = values.check_id || eqFilter(filters, 'check_id');
  if (!isUuid(checkId)) return { error: 'invalid_uuid', field: 'check_id' };
  const body = clip(values.body, 4000);
  if (body?.error || !body) return body?.error || { error: 'missing_required_field', field: 'body' };
  const check = (await client.query(
    'SELECT id, tenant_id FROM public.check_intake_items WHERE id = $1::uuid',
    [checkId],
  )).rows[0];
  if (!check) return { error: 'rls_denied', message: 'check not found' };
  const membership = (await client.query(
    `SELECT tenant_id FROM public.tenant_users
     WHERE user_id = $1::uuid
       AND (
         tenant_id = $2::uuid
         OR tenant_id IN (
           SELECT target_tenant_id FROM public.shared_checks
           WHERE check_id = $3::uuid AND revoked_at IS NULL
           UNION
           SELECT source_tenant_id FROM public.shared_checks
           WHERE check_id = $3::uuid AND revoked_at IS NULL
         )
       )
     ORDER BY CASE WHEN tenant_id = $2::uuid THEN 0 ELSE 1 END
     LIMIT 1`,
    [mapping.application_user_id, check.tenant_id, checkId],
  )).rows[0];
  if (!membership?.tenant_id) {
    return { error: 'not_authorized', message: 'Not a member of a tenant that can access this shared check' };
  }
  const rows = (await client.query(
    `INSERT INTO public.shared_check_messages (check_id, body, sender_user_id, sender_tenant_id)
     VALUES ($1::uuid, $2::text, $3::uuid, $4::uuid) RETURNING *`,
    [checkId, body, mapping.application_user_id, membership.tenant_id],
  )).rows;
  return { rows };
};

const TENANT_ROLES = new Set(['admin', 'operator', 'viewer']);

export const executeTenantUsers = async ({ client, mapping, op, values, filters }) => {
  const id = eqFilter(filters, 'id');
  const tenantId = eqFilter(filters, 'tenant_id');
  const userId = eqFilter(filters, 'user_id');

  const actorIsAdmin = async (tid) => {
    if (!(await memberOfTenant(client, mapping.application_user_id, tid))) return false;
    const rows = (await client.query(
      `SELECT role::text AS role FROM public.tenant_users
       WHERE user_id = $1::uuid AND tenant_id = $2::uuid AND role = 'admin'
       UNION ALL
       SELECT role::text FROM public.user_roles WHERE user_id = $1::uuid AND role IN ('admin', 'staff')`,
      [mapping.application_user_id, tid],
    )).rows;
    return rows.length > 0;
  };

  if (op === 'delete') {
    let targetTenant = tenantId;
    let targetUser = userId;
    if (id) {
      if (!isUuid(id)) return { error: 'invalid_uuid', field: 'id' };
      const row = (await client.query(
        'SELECT id, tenant_id, user_id FROM public.tenant_users WHERE id = $1::uuid',
        [id],
      )).rows[0];
      if (!row) return { error: 'rls_denied', message: 'membership not found' };
      targetTenant = row.tenant_id;
      targetUser = row.user_id;
    }
    if (!isUuid(targetTenant) || !isUuid(targetUser)) {
      return { error: 'missing_required_field', field: 'tenant_id|user_id' };
    }
    if (!(await actorIsAdmin(targetTenant))) {
      return { error: 'not_authorized', message: 'Tenant admin required to remove members' };
    }
    if (targetUser === mapping.application_user_id) {
      return { error: 'not_authorized', message: 'Cannot remove own membership via this path' };
    }
    const rows = id
      ? (await client.query(
        'DELETE FROM public.tenant_users WHERE id = $1::uuid RETURNING *',
        [id],
      )).rows
      : (await client.query(
        'DELETE FROM public.tenant_users WHERE tenant_id = $1::uuid AND user_id = $2::uuid RETURNING *',
        [targetTenant, targetUser],
      )).rows;
    return { rows };
  }

  if (op !== 'update') return { error: 'operation_not_allowlisted', op };
  const role = clip(values.role, 40);
  if (role?.error || !role) return role?.error || { error: 'missing_required_field', field: 'role' };
  if (!TENANT_ROLES.has(String(role).toLowerCase())) {
    return { error: 'invalid_field', field: 'role' };
  }
  let targetTenant = tenantId;
  if (id) {
    if (!isUuid(id)) return { error: 'invalid_uuid', field: 'id' };
    const row = (await client.query(
      'SELECT id, tenant_id FROM public.tenant_users WHERE id = $1::uuid',
      [id],
    )).rows[0];
    if (!row) return { error: 'rls_denied', message: 'membership not found' };
    targetTenant = row.tenant_id;
    if (!(await actorIsAdmin(targetTenant))) {
      return { error: 'not_authorized', message: 'Tenant admin required to change roles' };
    }
    const rows = (await client.query(
      `UPDATE public.tenant_users SET role = $2::tenant_role, updated_at = now()
       WHERE id = $1::uuid RETURNING *`,
      [id, String(role).toLowerCase()],
    )).rows;
    return { rows };
  }
  if (!isUuid(tenantId) || !isUuid(userId)) {
    return { error: 'missing_required_field', field: 'tenant_id|user_id' };
  }
  if (!(await actorIsAdmin(tenantId))) {
    return { error: 'not_authorized', message: 'Tenant admin required to change roles' };
  }
  const rows = (await client.query(
    `UPDATE public.tenant_users SET role = $3::tenant_role, updated_at = now()
     WHERE tenant_id = $1::uuid AND user_id = $2::uuid
     RETURNING *`,
    [tenantId, userId, String(role).toLowerCase()],
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'membership not writable' };
  return { rows };
};

export const executeProfiles = async ({ client, mapping, values, filters }) => {
  const id = eqFilter(filters, 'id') || mapping.application_user_id;
  if (!isUuid(id)) return { error: 'invalid_uuid', field: 'id' };
  if (id !== mapping.application_user_id) {
    const roles = (await client.query(
      `SELECT role FROM public.user_roles WHERE user_id = $1::uuid`,
      [mapping.application_user_id],
    )).rows.map((row) => String(row.role || '').toLowerCase());
    if (!roles.includes('admin')) {
      return { error: 'not_authorized', message: 'Can only update own profile' };
    }
  }
  const out = {};
  if ('full_name' in values) {
    const text = clip(values.full_name, 200);
    if (text?.error) return text;
    out.full_name = text;
  }
  if ('phone' in values) {
    const text = clip(values.phone, 40);
    if (text?.error) return text;
    out.phone = text;
  }
  if (!Object.keys(out).length) return { error: 'missing_required_field', field: 'values' };
  const built = buildSet(out);
  built.params.push(id);
  const rows = (await client.query(
    `UPDATE public.profiles SET ${built.sets.join(', ')} WHERE id = $${built.next}::uuid RETURNING *`,
    built.params,
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'profile not writable' };
  return { rows };
};

export const executeCompanyBranding = async ({ client, mapping, op, values, filters }) => {
  const out = {};
  for (const [col, max] of [
    ['company_name', 200], ['company_address', 500], ['company_email', 200], ['company_phone', 40],
    ['letterhead_url', 512], ['endorsement_email_subject', 200], ['endorsement_email_body', 4000],
  ]) {
    if (col in values) {
      const text = clip(values[col], max);
      if (text?.error) return text;
      out[col] = text;
    }
  }
  if (!Object.keys(out).length && op !== 'insert') {
    return { error: 'missing_required_field', field: 'values' };
  }
  const id = eqFilter(filters, 'id');
  if (id && isUuid(id)) {
    const built = buildSet(out);
    built.params.push(id);
    const rows = (await client.query(
      `UPDATE public.company_branding SET ${built.sets.join(', ')}, updated_at = now()
       WHERE id = $${built.next}::uuid RETURNING *`,
      built.params,
    )).rows;
    return { rows };
  }
  // Upsert single-row branding table when no id filter.
  const existing = (await client.query('SELECT id FROM public.company_branding ORDER BY created_at ASC LIMIT 1')).rows[0];
  if (existing) {
    const built = buildSet(out);
    built.params.push(existing.id);
    const rows = (await client.query(
      `UPDATE public.company_branding SET ${built.sets.join(', ')}, updated_at = now()
       WHERE id = $${built.next}::uuid RETURNING *`,
      built.params,
    )).rows;
    return { rows };
  }
  const cols = Object.keys(out);
  if (!cols.length) return { error: 'missing_required_field', field: 'values' };
  const rows = (await client.query(
    `INSERT INTO public.company_branding (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
     RETURNING *`,
    cols.map((c) => out[c]),
  )).rows;
  return { rows };
};

export const executeReferralAlerts = async ({ client, values, filters }) => {
  const id = eqFilter(filters, 'id');
  if (!isUuid(id)) return { error: 'invalid_uuid', field: 'id' };
  const out = {};
  if ('is_dismissed' in values) out.is_dismissed = values.is_dismissed === true || values.is_dismissed === 'true';
  if ('is_actioned' in values) out.is_actioned = values.is_actioned === true || values.is_actioned === 'true';
  if ('actioned_at' in values) out.actioned_at = values.actioned_at || null;
  if (!Object.keys(out).length) return { error: 'missing_required_field', field: 'values' };
  const built = buildSet(out, { is_dismissed: 'boolean', is_actioned: 'boolean', actioned_at: 'timestamptz' });
  built.params.push(id);
  const rows = (await client.query(
    `UPDATE public.referral_alerts SET ${built.sets.join(', ')} WHERE id = $${built.next}::uuid RETURNING *`,
    built.params,
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'alert not writable' };
  return { rows };
};

const TENANT_PLAN_TIERS = new Set(['starter', 'pro', 'enterprise']);
const TENANT_SUBSCRIPTION_STATUSES = new Set(['trial', 'active', 'inactive']);
const TENANT_EMAIL_PROVIDERS = new Set(['none', 'ses', 'resend', 'smtp']);

const isPlatformOwnerActor = async (client) => {
  const row = (await client.query(
    `SELECT public.is_master_owner() AS is_master, public.is_platform_owner() AS is_platform`,
  )).rows[0] || {};
  return row.is_master === true || row.is_platform === true;
};

const slugifyTenant = (value) => String(value || '')
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80);

const asTenantInt = (value, { min, max }) => {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  if (!Number.isInteger(num) || num < min || num > max) {
    return { error: 'invalid_field', field: 'max_checks_per_month' };
  }
  return num;
};

const asEmailProviderConfig = (value) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') {
    const text = clip(value, 2000);
    if (text?.error) return text;
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: 'invalid_field', field: 'email_provider_config' };
      }
      return parsed;
    } catch {
      return { error: 'invalid_field', field: 'email_provider_config' };
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'invalid_field', field: 'email_provider_config' };
  }
  const json = JSON.stringify(value);
  if (json.length > 2000) return { error: 'invalid_field', field: 'email_provider_config' };
  return value;
};

const collectTenantSafeFields = (values, { allowSlug = false } = {}) => {
  const out = {};
  for (const [col, max] of [
    ['name', 200],
    ['logo_url', 512],
    ['invoice_letterhead_url', 512],
    ['primary_color', 40],
    ['secondary_color', 40],
    ['custom_domain', 253],
    ['email_from_name', 120],
    ['email_from_address', 254],
    ['email_reply_to', 254],
    ['invoice_footer_note', 2000],
    ['invoice_default_terms', 4000],
  ]) {
    if (col in values) {
      const text = clip(values[col], max);
      if (text?.error) return text;
      out[col] = text;
    }
  }
  if (allowSlug && 'slug' in values) {
    const slug = slugifyTenant(values.slug);
    if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      return { error: 'invalid_field', field: 'slug' };
    }
    out.slug = slug;
  }
  if ('max_checks_per_month' in values) {
    const num = asTenantInt(values.max_checks_per_month, { min: 1, max: 100000 });
    if (num?.error) return num;
    out.max_checks_per_month = num;
  }
  if ('subscription_status' in values) {
    const status = String(values.subscription_status || '').trim().toLowerCase();
    if (!TENANT_SUBSCRIPTION_STATUSES.has(status)) {
      return { error: 'invalid_field', field: 'subscription_status' };
    }
    out.subscription_status = status;
  }
  if ('plan_tier' in values) {
    const tier = String(values.plan_tier || '').trim().toLowerCase();
    if (!TENANT_PLAN_TIERS.has(tier)) return { error: 'invalid_field', field: 'plan_tier' };
    out.plan_tier = tier;
  }
  if ('email_provider' in values) {
    const provider = String(values.email_provider || 'none').trim().toLowerCase() || 'none';
    if (!TENANT_EMAIL_PROVIDERS.has(provider)) {
      return { error: 'invalid_field', field: 'email_provider' };
    }
    out.email_provider = provider;
  }
  if ('email_provider_config' in values) {
    const config = asEmailProviderConfig(values.email_provider_config);
    if (config?.error) return config;
    out.email_provider_config = config;
  }
  return out;
};

const executeTenantInsert = async ({ client, values }) => {
  const collected = collectTenantSafeFields(values, { allowSlug: true });
  if (collected?.error) return collected;
  const name = collected.name;
  const slug = collected.slug || slugifyTenant(values.slug || values.name);
  if (!name) return { error: 'missing_required_field', field: 'name' };
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return { error: 'invalid_field', field: 'slug' };
  }
  const taken = (await client.query(
    `SELECT 1 FROM public.tenants WHERE slug = $1 LIMIT 1`,
    [slug],
  )).rows[0];
  if (taken) return { error: 'invalid_field', field: 'slug', message: 'slug already exists' };

  try {
    const rows = (await client.query(
      `INSERT INTO public.tenants (
         name, slug, logo_url, invoice_letterhead_url, primary_color, secondary_color,
         custom_domain, max_checks_per_month, subscription_status, plan_tier,
         email_from_name, email_from_address, email_reply_to, email_provider,
         email_provider_config, invoice_footer_note, invoice_default_terms,
         is_system_tenant, is_founding_partner, moov_allowlisted, moov_account_id,
         payment_provider, payment_status, bank_connection_status, bank_name,
         bank_last_four, plaid_funding_account_id, stripe_customer_id
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10,
         $11, $12, $13, $14,
         $15::jsonb, $16, $17,
         false, false, false, NULL,
         NULL, 'not_connected', 'not_connected', NULL,
         NULL, NULL, NULL
       )
       RETURNING *`,
      [
        name,
        slug,
        collected.logo_url ?? null,
        collected.invoice_letterhead_url ?? null,
        collected.primary_color ?? null,
        collected.secondary_color ?? null,
        collected.custom_domain ?? null,
        collected.max_checks_per_month ?? null,
        collected.subscription_status ?? 'trial',
        collected.plan_tier ?? 'starter',
        collected.email_from_name ?? null,
        collected.email_from_address ?? null,
        collected.email_reply_to ?? null,
        collected.email_provider ?? 'none',
        collected.email_provider_config ? JSON.stringify(collected.email_provider_config) : '{}',
        collected.invoice_footer_note ?? null,
        collected.invoice_default_terms ?? null,
      ],
    )).rows;
    const created = rows[0];
    if (created?.moov_allowlisted === true || created?.moov_account_id || created?.is_system_tenant === true) {
      return { error: 'rls_denied', message: 'new tenant failed fail-closed provider isolation' };
    }
    return { rows };
  } catch (error) {
    if (error?.code === '23505') {
      return { error: 'invalid_field', field: 'slug', message: 'slug already exists' };
    }
    throw error;
  }
};

export const executeTenantsNarrow = async ({ client, mapping, op, values, filters }) => {
  const platformOwner = await isPlatformOwnerActor(client);
  if (op === 'insert') {
    if (!platformOwner) {
      return { error: 'not_authorized', message: 'Platform owner required to create tenants' };
    }
    return executeTenantInsert({ client, values });
  }
  if (op && op !== 'update') return { error: 'operation_not_allowlisted', op };

  const id = eqFilter(filters, 'id');
  if (!isUuid(id)) return { error: 'invalid_uuid', field: 'id' };
  if (!platformOwner && !(await memberOfTenant(client, mapping.application_user_id, id))) {
    return { error: 'not_authorized', message: 'Not a member of tenant' };
  }
  const collected = collectTenantSafeFields(values, { allowSlug: false });
  if (collected?.error) return collected;
  const out = { ...collected };
  if (!Object.keys(out).length) return { error: 'missing_required_field', field: 'values' };
  const casts = {};
  if ('max_checks_per_month' in out) casts.max_checks_per_month = 'int';
  if ('email_provider_config' in out) {
    casts.email_provider_config = 'jsonb';
    out.email_provider_config = out.email_provider_config
      ? JSON.stringify(out.email_provider_config)
      : '{}';
  }
  const built = buildSet(out, casts);
  built.params.push(id);
  const rows = (await client.query(
    `UPDATE public.tenants SET ${built.sets.join(', ')} WHERE id = $${built.next}::uuid RETURNING *`,
    built.params,
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'tenant not writable' };
  return { rows };
};

export const executePrivacyAck = async ({ client, mapping, values }) => {
  const noticeVersion = clip(values.notice_version || values.version || 'current', 80);
  if (noticeVersion?.error || !noticeVersion) {
    return noticeVersion?.error || { error: 'missing_required_field', field: 'notice_version' };
  }
  const rows = (await client.query(
    `INSERT INTO public.privacy_notice_acknowledgments (user_id, notice_version, acknowledged_at)
     VALUES ($1::uuid, $2::text, now())
     RETURNING *`,
    [mapping.application_user_id, noticeVersion],
  )).rows;
  return { rows };
};

const SAFE_LEDGER_EVENT_TYPES = new Set([
  'ops_note',
  'mortgage_update',
  'mortgage_followup',
  'document_uploaded',
  'document_sent',
  'document_shared',
  'document_delivered',
  'document_viewed',
  'signature_reminder',
  'mortgage_check_sent',
  'mortgage_check_returned',
  'contractor_upload',
  'homeowner_check_upload',
  'homeowner_upload_attached',
  'production_doc_uploaded',
]);

/** UI aliases that are not in the DB check constraint — coerce to ops_note. */
const LEDGER_EVENT_ALIASES = {
  tenant_update: 'ops_note',
  status_update: 'ops_note',
};

export const executeHomeownerLedgerEvents = async ({ client, mapping, values }) => {
  if (values.amount !== undefined && values.amount !== null) {
    return { error: 'column_not_allowlisted', columns: ['amount'], table: 'homeowner_ledger_events' };
  }
  const tenantId = values.tenant_id;
  const claimId = values.claim_id;
  if (!isUuid(tenantId)) return { error: 'invalid_uuid', field: 'tenant_id' };
  if (!isUuid(claimId)) return { error: 'invalid_uuid', field: 'claim_id' };
  if (!(await memberOfTenant(client, mapping.application_user_id, tenantId))) {
    return { error: 'not_authorized', message: 'Not a member of tenant' };
  }
  let eventType = clip(values.event_type, 80);
  if (eventType?.error || !eventType) {
    return eventType?.error || { error: 'missing_required_field', field: 'event_type' };
  }
  if (LEDGER_EVENT_ALIASES[eventType]) {
    eventType = LEDGER_EVENT_ALIASES[eventType];
  }
  if (!SAFE_LEDGER_EVENT_TYPES.has(eventType)) {
    return { error: 'event_type_not_allowlisted', event_type: eventType };
  }
  const actor = clip(values.actor_label, 200);
  if (actor?.error) return actor;
  let checkId = values.check_id || null;
  if (checkId && !isUuid(checkId)) return { error: 'invalid_uuid', field: 'check_id' };
  let caseId = values.case_id || null;
  if (caseId && !isUuid(caseId)) return { error: 'invalid_uuid', field: 'case_id' };
  const occurredAt = values.occurred_at || new Date().toISOString();
  const payload = values.payload_json && typeof values.payload_json === 'object'
    ? values.payload_json
    : (values.payload_json ? JSON.parse(String(values.payload_json)) : {});
  const rows = (await client.query(
    `INSERT INTO public.homeowner_ledger_events (
       tenant_id, claim_id, check_id, case_id, event_type, occurred_at,
       actor_label, payload_json, created_by, amount
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::timestamptz,
       $7::text, $8::jsonb, $9::uuid, NULL
     ) RETURNING *`,
    [
      tenantId, claimId, checkId, caseId, eventType, occurredAt,
      actor, JSON.stringify(payload || {}), mapping.application_user_id,
    ],
  )).rows;
  return { rows };
};

export const executeCashJobs = async ({ client, mapping, op, values, filters }) => {
  if (op === 'insert') {
    const tenantId = values.tenant_id;
    if (!isUuid(tenantId)) return { error: 'invalid_uuid', field: 'tenant_id' };
    if (!(await memberOfTenant(client, mapping.application_user_id, tenantId))) {
      return { error: 'not_authorized', message: 'Not a member of tenant' };
    }
    const jobName = clip(values.job_name, 200);
    if (jobName?.error || !jobName) return jobName?.error || { error: 'missing_required_field', field: 'job_name' };
    const customerName = clip(values.customer_name, 200);
    if (customerName?.error || !customerName) {
      return customerName?.error || { error: 'missing_required_field', field: 'customer_name' };
    }
    const workType = clip(values.work_type || 'other', 40);
    if (workType?.error) return workType;
    const status = clip(values.status || 'estimate', 40);
    if (status?.error) return status;
    const contractAmount = values.contract_amount == null || values.contract_amount === ''
      ? 0
      : Number(values.contract_amount);
    if (!Number.isFinite(contractAmount) || contractAmount < 0) {
      return { error: 'invalid_field', field: 'contract_amount' };
    }
    const phone = clip(values.customer_phone, 40);
    if (phone?.error) return phone;
    const email = clip(values.customer_email, 200);
    if (email?.error) return email;
    const address = clip(values.property_address, 300);
    if (address?.error) return address;
    const city = clip(values.property_city, 120);
    if (city?.error) return city;
    const state = clip(values.property_state, 40);
    if (state?.error) return state;
    const zip = clip(values.property_zip, 20);
    if (zip?.error) return zip;
    const description = clip(values.description, 4000);
    if (description?.error) return description;
    const notes = clip(values.notes, 4000);
    if (notes?.error) return notes;
    const rows = (await client.query(
      `INSERT INTO public.cash_jobs (
         tenant_id, created_by, job_name, work_type, customer_name, customer_phone,
         customer_email, property_address, property_city, property_state, property_zip,
         contract_amount, estimate_date, start_date, completion_date, description, notes, status
       ) VALUES (
         $1::uuid, $2::uuid, $3::text, $4::cash_job_work_type, $5::text, $6::text,
         $7::text, $8::text, $9::text, $10::text, $11::text,
         $12::numeric, $13::date, $14::date, $15::date, $16::text, $17::text, $18::cash_job_status
       ) RETURNING *`,
      [
        tenantId,
        mapping.application_user_id,
        jobName,
        workType,
        customerName,
        phone,
        email,
        address,
        city,
        state,
        zip,
        contractAmount,
        values.estimate_date || null,
        values.start_date || null,
        values.completion_date || null,
        description,
        notes,
        status,
      ],
    )).rows;
    return { rows };
  }

  const id = eqFilter(filters, 'id');
  if (!isUuid(id)) return { error: 'invalid_uuid', field: 'id' };

  if (op === 'delete') {
    const rows = (await client.query(
      'DELETE FROM public.cash_jobs WHERE id = $1::uuid RETURNING *',
      [id],
    )).rows;
    if (!rows.length) return { error: 'rls_denied', message: 'cash_job not writable' };
    return { rows };
  }

  const casts = {
    contract_amount: 'numeric',
    estimate_date: 'date',
    start_date: 'date',
    completion_date: 'date',
    work_type: 'cash_job_work_type',
    status: 'cash_job_status',
  };
  const built = buildSet(values, casts);
  if (!built.sets.length) return { error: 'missing_required_field', field: 'values' };
  built.params.push(id);
  const rows = (await client.query(
    `UPDATE public.cash_jobs SET ${built.sets.join(', ')}, updated_at = now()
     WHERE id = $${built.next}::uuid RETURNING *`,
    built.params,
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'cash_job not writable' };
  return { rows };
};

export const executeCashJobLineItems = async ({ client, mapping, op, values, filters }) => {
  if (op === 'insert') {
    const tenantId = values.tenant_id;
    const jobId = values.cash_job_id;
    if (!isUuid(tenantId)) return { error: 'invalid_uuid', field: 'tenant_id' };
    if (!isUuid(jobId)) return { error: 'invalid_uuid', field: 'cash_job_id' };
    if (!(await memberOfTenant(client, mapping.application_user_id, tenantId))) {
      return { error: 'not_authorized', message: 'Not a member of tenant' };
    }
    const description = clip(values.description, 500);
    if (description?.error || !description) {
      return description?.error || { error: 'missing_required_field', field: 'description' };
    }
    const quantity = Number(values.quantity ?? 1);
    const unitPrice = Number(values.unit_price ?? 0);
    if (!Number.isFinite(quantity) || !Number.isFinite(unitPrice)) {
      return { error: 'invalid_field', field: 'quantity_or_unit_price' };
    }
    const total = values.total == null ? quantity * unitPrice : Number(values.total);
    const sortOrder = Number(values.sort_order ?? 0);
    const rows = (await client.query(
      `INSERT INTO public.cash_job_line_items (
         cash_job_id, tenant_id, description, quantity, unit_price, total, sort_order
       ) VALUES ($1::uuid, $2::uuid, $3::text, $4::numeric, $5::numeric, $6::numeric, $7::int)
       RETURNING *`,
      [jobId, tenantId, description, quantity, unitPrice, total, sortOrder],
    )).rows;
    return { rows };
  }

  if (op === 'delete') {
    const id = eqFilter(filters, 'id');
    const jobId = eqFilter(filters, 'cash_job_id');
    if (id) {
      if (!isUuid(id)) return { error: 'invalid_uuid', field: 'id' };
      const rows = (await client.query(
        'DELETE FROM public.cash_job_line_items WHERE id = $1::uuid RETURNING *',
        [id],
      )).rows;
      return { rows };
    }
    if (jobId) {
      if (!isUuid(jobId)) return { error: 'invalid_uuid', field: 'cash_job_id' };
      const rows = (await client.query(
        'DELETE FROM public.cash_job_line_items WHERE cash_job_id = $1::uuid RETURNING *',
        [jobId],
      )).rows;
      return { rows };
    }
    return { error: 'missing_required_field', field: 'id_or_cash_job_id' };
  }

  const id = eqFilter(filters, 'id');
  if (!isUuid(id)) return { error: 'invalid_uuid', field: 'id' };
  const casts = { quantity: 'numeric', unit_price: 'numeric', total: 'numeric', sort_order: 'int' };
  const built = buildSet(values, casts);
  if (!built.sets.length) return { error: 'missing_required_field', field: 'values' };
  built.params.push(id);
  const rows = (await client.query(
    `UPDATE public.cash_job_line_items SET ${built.sets.join(', ')}
     WHERE id = $${built.next}::uuid RETURNING *`,
    built.params,
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'line item not writable' };
  return { rows };
};

export const executeCashJobAttachments = async ({ client, mapping, op, values, filters }) => {
  if (op === 'insert') {
    const tenantId = values.tenant_id;
    const jobId = values.cash_job_id;
    if (!isUuid(tenantId)) return { error: 'invalid_uuid', field: 'tenant_id' };
    if (!isUuid(jobId)) return { error: 'invalid_uuid', field: 'cash_job_id' };
    if (!(await memberOfTenant(client, mapping.application_user_id, tenantId))) {
      return { error: 'not_authorized', message: 'Not a member of tenant' };
    }
    const filePath = clip(values.file_path, 512);
    if (filePath?.error || !filePath) return filePath?.error || { error: 'missing_required_field', field: 'file_path' };
    const fileName = clip(values.file_name, 255);
    if (fileName?.error || !fileName) return fileName?.error || { error: 'missing_required_field', field: 'file_name' };
    const rows = (await client.query(
      `INSERT INTO public.cash_job_attachments (
         cash_job_id, tenant_id, file_path, file_name, file_type, file_size, attachment_type, uploaded_by
       ) VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::bigint, $7::text, $8::uuid)
       RETURNING *`,
      [
        jobId, tenantId, filePath, fileName,
        clip(values.file_type, 120) || null,
        values.file_size == null ? null : Number(values.file_size),
        clip(values.attachment_type, 80) || null,
        mapping.application_user_id,
      ],
    )).rows;
    return { rows };
  }
  if (op === 'delete') {
    const id = eqFilter(filters, 'id');
    if (!isUuid(id)) return { error: 'invalid_uuid', field: 'id' };
    const rows = (await client.query(
      'DELETE FROM public.cash_job_attachments WHERE id = $1::uuid RETURNING *',
      [id],
    )).rows;
    if (!rows.length) return { error: 'rls_denied', message: 'attachment not writable' };
    return { rows };
  }
  return { error: 'operation_not_allowlisted', op };
};

export const executeAppMetadataWrite = async ({ client, mapping, table, op, values, filters }) => {
  switch (table) {
    case 'notifications':
      return executeNotifications({ client, mapping, op, values, filters });
    case 'tenant_documents':
      return executeTenantDocuments({ client, mapping, op, values, filters });
    case 'mortgage_request_library_documents': {
      const { executeMortgageRequestLibraryDocuments } = await import('./mortgage-library-docs.mjs');
      return executeMortgageRequestLibraryDocuments({ client, mapping, op, values, filters });
    }
    case 'loss_draft_documents':
      return executeLossDraftDocuments({ client, mapping, op, values, filters });
    case 'mortgage_companies':
      return executeMortgageCompanies({ client, mapping, op, values, filters });
    case 'shared_check_messages':
      return executeSharedCheckMessages({ client, mapping, op, values, filters });
    case 'profiles':
      return executeProfiles({ client, mapping, values, filters });
    case 'company_branding':
      return executeCompanyBranding({ client, mapping, op, values, filters });
    case 'referral_alerts':
      return executeReferralAlerts({ client, values, filters });
    case 'tenants':
      return executeTenantsNarrow({ client, mapping, op, values, filters });
    case 'privacy_notice_acknowledgments':
      return executePrivacyAck({ client, mapping, values });
    case 'tenant_users':
      return executeTenantUsers({ client, mapping, op, values, filters });
    case 'cash_jobs':
      return executeCashJobs({ client, mapping, op, values, filters });
    case 'cash_job_line_items':
      return executeCashJobLineItems({ client, mapping, op, values, filters });
    case 'cash_job_attachments':
      return executeCashJobAttachments({ client, mapping, op, values, filters });
    case 'homeowner_ledger_events':
      return executeHomeownerLedgerEvents({ client, mapping, values });
    default:
      return { error: 'table_not_allowlisted', table };
  }
};
