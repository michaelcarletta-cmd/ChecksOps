/**
 * Tranche-6 application metadata writes (non-financial, non-provider).
 */
import { ident } from './data.mjs';

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
    `SELECT 1 FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid
     UNION ALL
     SELECT 1 FROM public.user_roles WHERE user_id = $1::uuid AND role IN ('admin', 'staff')
     LIMIT 1`,
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
    if (!(await memberOfTenant(client, mapping.application_user_id, tenantId))) {
      return { error: 'not_authorized', message: 'Not a member of tenant' };
    }
    const docType = clip(values.doc_type, 120);
    if (docType?.error || !docType) return docType?.error || { error: 'missing_required_field', field: 'doc_type' };
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
  if ('preferred_auth_method' in values) {
    const text = clip(values.preferred_auth_method, 40);
    if (text?.error) return text;
    if (text && !['password', 'passkey', 'otp', 'magic_link'].includes(String(text).toLowerCase())) {
      return { error: 'invalid_field', field: 'preferred_auth_method' };
    }
    out.preferred_auth_method = text;
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

export const executeTenantsNarrow = async ({ client, mapping, values, filters }) => {
  const id = eqFilter(filters, 'id');
  if (!isUuid(id)) return { error: 'invalid_uuid', field: 'id' };
  if (!(await memberOfTenant(client, mapping.application_user_id, id))) {
    return { error: 'not_authorized', message: 'Not a member of tenant' };
  }
  const out = {};
  for (const [col, max] of [
    ['name', 200], ['logo_url', 512], ['invoice_letterhead_url', 512],
    ['primary_color', 40], ['invoice_footer_note', 2000], ['invoice_default_terms', 4000],
  ]) {
    if (col in values) {
      const text = clip(values[col], max);
      if (text?.error) return text;
      out[col] = text;
    }
  }
  if (!Object.keys(out).length) return { error: 'missing_required_field', field: 'values' };
  const built = buildSet(out);
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

export const executeAppMetadataWrite = async ({ client, mapping, table, op, values, filters }) => {
  switch (table) {
    case 'notifications':
      return executeNotifications({ client, mapping, op, values, filters });
    case 'tenant_documents':
      return executeTenantDocuments({ client, mapping, op, values, filters });
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
      return executeTenantsNarrow({ client, mapping, values, filters });
    case 'privacy_notice_acknowledgments':
      return executePrivacyAck({ client, mapping, values });
    case 'tenant_users':
      return executeTenantUsers({ client, mapping, op, values, filters });
    default:
      return { error: 'table_not_allowlisted', table };
  }
};
