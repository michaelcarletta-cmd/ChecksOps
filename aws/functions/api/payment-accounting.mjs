/**
 * Class A Payments accounting-metadata writes.
 *
 * Dedicated contract for display name / accounting type only.
 * Never calls Moov or any provider. Never moves money.
 * Never rewrites recipient_tenant_id / destination_tenant_id.
 * Generic /data/write of financial tables stays denied.
 *
 * Actions: update_recipient_display | update_split_type | list_recipient_overlays
 */

import { parseBody, withIdentity, withIdentityWrite } from './data.mjs';
import { TENANT_MEMBERSHIP_SQL } from './identity.mjs';

export const PAYMENT_ACCOUNTING_FUNCTION = 'tenant-payment-accounting';

export const ALLOWED_DISPLAY_TYPES = new Set([
  'subcontractor',
  'contractor',
  'sales_rep',
  'appraisal',
  'supplier',
  'adjuster',
  'vendor',
  'client',
  'insured',
  'overhead',
  'operating',
  'other',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const FORBIDDEN_BODY_KEYS = new Set([
  'amount',
  'amount_cents',
  'currency',
  'status',
  'settled_at',
  'submitted_at',
  'returned_at',
  'moov_transfer_id',
  'plaid_transfer_id',
  'actum_order_id',
  'provider_transfer_id',
  'recipient_tenant_id',
  'destination_tenant_id',
  'payer_tenant_id',
  'stakeholder_account_id',
  'chk_acct',
  'routing_number',
  'account_number',
  'consumer_unique',
  'tin',
  'tin_encrypted',
]);

const isUuid = (value) => UUID_RE.test(String(value || ''));

export const parseAggregateKey = (raw) => {
  const key = String(raw || '').trim();
  if (!key) return { error: 'aggregate_key_required' };
  if (key.startsWith('tenant:')) {
    const id = key.slice('tenant:'.length);
    if (!isUuid(id)) return { error: 'invalid_aggregate_key', kind: 'tenant' };
    return { kind: 'tenant', id, key };
  }
  if (key.startsWith('acct:')) {
    const id = key.slice('acct:'.length);
    if (!isUuid(id)) return { error: 'invalid_aggregate_key', kind: 'acct' };
    return { kind: 'acct', id, key };
  }
  if (key.startsWith('ext:')) {
    const rest = key.slice('ext:'.length);
    const bar = rest.indexOf('|');
    if (bar <= 0) return { error: 'invalid_aggregate_key', kind: 'ext' };
    const type = rest.slice(0, bar);
    const name = rest.slice(bar + 1).trim().toLowerCase();
    if (!name) return { error: 'invalid_aggregate_key', kind: 'ext' };
    if (!ALLOWED_DISPLAY_TYPES.has(type)) return { error: 'invalid_display_type', field: 'aggregate_key' };
    return { kind: 'ext', type, name, key };
  }
  return { error: 'invalid_aggregate_key' };
};

const forbiddenPayloadFields = (body = {}) => (
  Object.keys(body || {}).filter((key) => FORBIDDEN_BODY_KEYS.has(key))
);

const deny = (statusCode, error, extra = {}) => ({
  ok: false,
  statusCode,
  error,
  ...extra,
});

const normalizeDisplayName = (value) => String(value ?? '').trim();

const normalizeDisplayType = (value) => {
  const type = String(value ?? '').trim();
  if (!ALLOWED_DISPLAY_TYPES.has(type)) return { error: 'invalid_display_type' };
  return { type };
};

async function loadMemberships(client, userId) {
  const { rows } = await client.query(TENANT_MEMBERSHIP_SQL, [userId]);
  return rows.map((row) => ({
    tenant_id: String(row.tenant_id),
    role: row.role || null,
  }));
}

async function isPlatformWriter(client, userId) {
  const { rows: ownerRows } = await client.query(
    `SELECT public.is_platform_owner() AS is_owner, public.is_master_owner() AS is_master`,
  );
  const owner = ownerRows[0] || {};
  if (owner.is_owner === true || owner.is_master === true) return true;
  const { rows: roleRows } = await client.query(
    `SELECT role FROM public.user_roles WHERE user_id = $1`,
    [userId],
  );
  return roleRows.some((row) => String(row.role) === 'admin');
}

async function canWriteTenant(client, tenantId) {
  const { rows } = await client.query(
    'SELECT public.aws_can_write_tenant($1::uuid) AS ok',
    [tenantId],
  );
  return rows[0]?.ok === true;
}

async function canAccessTenant(client, tenantId) {
  const { rows } = await client.query(
    'SELECT public.aws_can_access_tenant($1::uuid) AS ok',
    [tenantId],
  );
  return rows[0]?.ok === true;
}

/**
 * Tenant identity comes from authenticated memberships.
 * A client tenant_id is only a selector among tenants the user can already
 * write (mutations) or access (overlay list).
 */
export async function resolveAuthorizedTenant({ client, mapping, body, requireWrite = true }) {
  const memberships = await loadMemberships(client, mapping.application_user_id);
  const platformWriter = await isPlatformWriter(client, mapping.application_user_id);
  const claimed = String(body.tenant_id || body.tenantId || '').trim() || null;
  if (claimed && !isUuid(claimed)) {
    return deny(400, 'invalid_uuid', { field: 'tenant_id' });
  }

  const checkAccess = requireWrite ? canWriteTenant : canAccessTenant;
  const deniedCode = requireWrite ? 'tenant_write_denied' : 'cross_tenant_denied';

  if (claimed) {
    const member = memberships.some((row) => row.tenant_id === claimed);
    if (!member && !platformWriter) {
      return deny(403, 'forbidden', { code: 'cross_tenant_denied' });
    }
    if (!platformWriter) {
      const allowed = await checkAccess(client, claimed);
      if (!allowed) return deny(403, 'forbidden', { code: deniedCode });
    }
    return { ok: true, tenantId: claimed, access: member ? 'tenant_member' : 'platform_writer' };
  }

  const allowed = [];
  for (const row of memberships) {
    if (await checkAccess(client, row.tenant_id)) allowed.push(row.tenant_id);
  }
  if (allowed.length === 1) {
    return { ok: true, tenantId: allowed[0], access: 'tenant_member' };
  }
  if (allowed.length === 0 && !platformWriter) {
    return deny(403, 'forbidden', { code: 'no_tenant_membership' });
  }
  return deny(400, 'tenant_selector_required', {
    message: 'Authenticated context has multiple tenants; pass tenant_id only as a membership selector',
  });
}

async function writeAudit(client, {
  userId,
  action,
  recordType,
  recordId,
  oldValues,
  newValues,
  metadata,
}) {
  await client.query(
    `INSERT INTO public.audit_logs (
       user_id, action, record_type, record_id, old_values, new_values, metadata
     ) VALUES (
       $1::uuid, $2::text, $3::text, $4::text, $5::jsonb, $6::jsonb, $7::jsonb
     )`,
    [
      userId,
      String(action).slice(0, 120),
      String(recordType).slice(0, 120),
      recordId == null ? null : String(recordId).slice(0, 200),
      oldValues || null,
      newValues || null,
      metadata || null,
    ],
  );
}

async function updateAcctDisplay(client, { tenantId, parsed, displayName, displayType, userId }) {
  const { rows } = await client.query(
    `SELECT id::text AS id, tenant_id::text AS tenant_id, nickname, account_type
       FROM public.stakeholder_accounts
      WHERE id = $1::uuid
      LIMIT 1`,
    [parsed.id],
  );
  const row = rows[0];
  if (!row) return deny(404, 'recipient_not_found', { kind: 'acct' });
  if (String(row.tenant_id) !== tenantId) {
    return deny(403, 'forbidden', { code: 'cross_tenant_denied' });
  }

  const { rows: updated } = await client.query(
    `UPDATE public.stakeholder_accounts
        SET nickname = $1,
            account_type = $2,
            updated_at = now()
      WHERE id = $3::uuid
        AND tenant_id = $4::uuid
      RETURNING id::text AS id, nickname, account_type`,
    [displayName, displayType, parsed.id, tenantId],
  );
  if (!updated[0]) return deny(404, 'recipient_not_found', { kind: 'acct' });

  await writeAudit(client, {
    userId,
    action: 'payment_recipient_display_update',
    recordType: 'payment_recipient',
    recordId: parsed.key,
    oldValues: { display_name: row.nickname, display_type: row.account_type, kind: 'acct' },
    newValues: { display_name: displayName, display_type: displayType, kind: 'acct' },
    metadata: { tenant_id: tenantId, aggregate_key: parsed.key, updated_count: 1 },
  });

  return {
    ok: true,
    statusCode: 200,
    action: 'update_recipient_display',
    kind: 'acct',
    aggregate_key: parsed.key,
    updated_count: 1,
    display_name: updated[0].nickname,
    display_type: updated[0].account_type,
  };
}

async function updateExtDisplay(client, { tenantId, parsed, displayName, displayType, userId }) {
  const { rows } = await client.query(
    `SELECT id::text AS id, recipient_name, recipient_type
       FROM public.disbursement_splits
      WHERE tenant_id = $1::uuid
        AND recipient_tenant_id IS NULL
        AND stakeholder_account_id IS NULL
        AND lower(btrim(coalesce(recipient_name, ''))) = $2
        AND coalesce(recipient_type, 'other') = $3`,
    [tenantId, parsed.name, parsed.type],
  );
  if (!rows.length) return deny(404, 'recipient_not_found', { kind: 'ext' });
  const ids = rows.map((row) => row.id);

  const { rows: updated } = await client.query(
    `UPDATE public.disbursement_splits
        SET recipient_name = $1,
            recipient_type = $2,
            updated_at = now()
      WHERE tenant_id = $3::uuid
        AND id = ANY($4::uuid[])
        AND recipient_tenant_id IS NULL
        AND stakeholder_account_id IS NULL
      RETURNING id::text AS id, recipient_name, recipient_type`,
    [displayName, displayType, tenantId, ids],
  );

  await writeAudit(client, {
    userId,
    action: 'payment_recipient_display_update',
    recordType: 'payment_recipient',
    recordId: parsed.key,
    oldValues: { display_name: rows[0].recipient_name, display_type: rows[0].recipient_type, kind: 'ext' },
    newValues: { display_name: displayName, display_type: displayType, kind: 'ext' },
    metadata: {
      tenant_id: tenantId,
      aggregate_key: parsed.key,
      updated_count: updated.length,
      split_ids: updated.map((row) => row.id),
    },
  });

  return {
    ok: true,
    statusCode: 200,
    action: 'update_recipient_display',
    kind: 'ext',
    aggregate_key: `ext:${displayType}|${displayName.trim().toLowerCase()}`,
    previous_aggregate_key: parsed.key,
    updated_count: updated.length,
    display_name: displayName,
    display_type: displayType,
  };
}

async function updateTenantOverlay(client, { tenantId, parsed, displayName, displayType, userId }) {
  if (parsed.id === tenantId) {
    return deny(400, 'self_destination_overlay_denied');
  }
  try {
    const { rows } = await client.query(
      `INSERT INTO public.tenant_payment_recipient_overrides
         (tenant_id, aggregate_key, display_name, display_type, updated_by)
       VALUES ($1::uuid, $2, $3, $4, $5::uuid)
       ON CONFLICT (tenant_id, aggregate_key)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         display_type = EXCLUDED.display_type,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING tenant_id::text AS tenant_id, aggregate_key, display_name, display_type`,
      [tenantId, parsed.key, displayName, displayType, userId],
    );
    const overlay = rows[0];
    await writeAudit(client, {
      userId,
      action: 'payment_recipient_display_update',
      recordType: 'payment_recipient',
      recordId: parsed.key,
      oldValues: { kind: 'tenant', aggregate_key: parsed.key },
      newValues: { display_name: displayName, display_type: displayType, kind: 'tenant' },
      metadata: { tenant_id: tenantId, aggregate_key: parsed.key, updated_count: 1, overlay: true },
    });
    return {
      ok: true,
      statusCode: 200,
      action: 'update_recipient_display',
      kind: 'tenant',
      aggregate_key: overlay.aggregate_key,
      updated_count: 1,
      display_name: overlay.display_name,
      display_type: overlay.display_type,
      overlay: true,
    };
  } catch (error) {
    if (error?.code === '42P01') {
      return deny(409, 'overlay_table_not_applied', {
        message: 'tenant_payment_recipient_overrides is prepared in source and is not applied. Tenant identity was not rewritten.',
      });
    }
    throw error;
  }
}

async function handleListOverlays(client, { tenantId }) {
  try {
    const { rows } = await client.query(
      `SELECT tenant_id::text AS tenant_id, aggregate_key, display_name, display_type
         FROM public.tenant_payment_recipient_overrides
        WHERE tenant_id = $1::uuid`,
      [tenantId],
    );
    return {
      ok: true,
      statusCode: 200,
      action: 'list_recipient_overlays',
      overlays: rows.filter((row) => String(row.tenant_id) === tenantId),
    };
  } catch (error) {
    if (error?.code === '42P01') {
      return {
        ok: true,
        statusCode: 200,
        action: 'list_recipient_overlays',
        overlays: [],
        overlay_table_not_applied: true,
      };
    }
    throw error;
  }
}

async function handleRecipientDisplay(client, { tenantId, body, mapping }) {
  const parsed = parseAggregateKey(body.aggregate_key || body.aggregateKey);
  if (parsed.error) return deny(400, parsed.error, { kind: parsed.kind || null });
  const displayName = normalizeDisplayName(body.display_name ?? body.displayName);
  if (!displayName) return deny(400, 'display_name_required');
  const typed = normalizeDisplayType(body.display_type ?? body.displayType);
  if (typed.error) return deny(400, typed.error);

  if (parsed.kind === 'acct') {
    return updateAcctDisplay(client, {
      tenantId,
      parsed,
      displayName,
      displayType: typed.type,
      userId: mapping.application_user_id,
    });
  }
  if (parsed.kind === 'ext') {
    return updateExtDisplay(client, {
      tenantId,
      parsed,
      displayName,
      displayType: typed.type,
      userId: mapping.application_user_id,
    });
  }
  if (parsed.kind === 'tenant') {
    return updateTenantOverlay(client, {
      tenantId,
      parsed,
      displayName,
      displayType: typed.type,
      userId: mapping.application_user_id,
    });
  }
  return deny(400, 'invalid_aggregate_key');
}

async function handleSplitType(client, { tenantId, body, mapping }) {
  const splitId = String(body.split_id || body.splitId || '').trim();
  if (!isUuid(splitId)) return deny(400, 'invalid_uuid', { field: 'split_id' });
  const typed = normalizeDisplayType(body.display_type ?? body.displayType);
  if (typed.error) return deny(400, typed.error);

  const { rows } = await client.query(
    `SELECT id::text AS id,
            tenant_id::text AS tenant_id,
            recipient_type,
            recipient_tenant_id::text AS recipient_tenant_id,
            stakeholder_account_id::text AS stakeholder_account_id
       FROM public.disbursement_splits
      WHERE id = $1::uuid
      LIMIT 1`,
    [splitId],
  );
  const row = rows[0];
  if (!row) return deny(404, 'split_not_found');
  if (String(row.tenant_id) !== tenantId) {
    return deny(403, 'forbidden', { code: 'cross_tenant_denied' });
  }
  if (row.recipient_tenant_id) {
    return deny(409, 'durable_tenant_destination', {
      message: 'Split type cannot change a tenant-to-tenant payment identity',
    });
  }
  if (row.stakeholder_account_id) {
    return deny(409, 'stakeholder_identity', {
      message: 'Stakeholder-linked rows use update_recipient_display on the acct: key',
    });
  }

  const { rows: updated } = await client.query(
    `UPDATE public.disbursement_splits
        SET recipient_type = $1,
            updated_at = now()
      WHERE id = $2::uuid
        AND tenant_id = $3::uuid
        AND recipient_tenant_id IS NULL
        AND stakeholder_account_id IS NULL
      RETURNING id::text AS id, recipient_type`,
    [typed.type, splitId, tenantId],
  );
  if (!updated[0]) return deny(409, 'split_not_updatable');

  await writeAudit(client, {
    userId: mapping.application_user_id,
    action: 'payment_split_type_update',
    recordType: 'disbursement_split',
    recordId: splitId,
    oldValues: { display_type: row.recipient_type },
    newValues: { display_type: typed.type },
    metadata: { tenant_id: tenantId, split_id: splitId },
  });

  return {
    ok: true,
    statusCode: 200,
    action: 'update_split_type',
    kind: 'split',
    split_id: updated[0].id,
    updated_count: 1,
    display_type: updated[0].recipient_type,
  };
}

async function dispatch({ client, mapping, body, spoof }) {
  const forbidden = forbiddenPayloadFields(body);
  if (forbidden.length) {
    return {
      ...deny(400, 'field_not_allowed', { columns: forbidden }),
      spoofFieldsIgnored: spoof,
    };
  }

  const action = String(body.action || '').trim();
  const authorized = await resolveAuthorizedTenant({
    client,
    mapping,
    body,
    requireWrite: action !== 'list_recipient_overlays',
  });
  if (authorized.ok !== true) {
    return { ...authorized, spoofFieldsIgnored: spoof };
  }

  let result;
  if (action === 'update_recipient_display') {
    result = await handleRecipientDisplay(client, {
      tenantId: authorized.tenantId,
      body,
      mapping,
    });
  } else if (action === 'update_split_type') {
    result = await handleSplitType(client, {
      tenantId: authorized.tenantId,
      body,
      mapping,
    });
  } else if (action === 'list_recipient_overlays') {
    result = await handleListOverlays(client, { tenantId: authorized.tenantId });
  } else {
    result = deny(400, 'unknown_action');
  }
  return {
    ...result,
    tenant_id: authorized.tenantId,
    access: authorized.access,
    spoofFieldsIgnored: spoof,
  };
}

export const handlePaymentAccounting = async (event, deps = {}) => {
  const body = parseBody(event);
  const wrap = String(body.action || '').trim() === 'list_recipient_overlays'
    ? withIdentity
    : withIdentityWrite;
  try {
    return await wrap(event, async (ctx) => dispatch(ctx), deps);
  } catch (err) {
    const status = err.statusCode || 500;
    if (status === 401) {
      return { ok: false, statusCode: 401, error: 'unauthorized' };
    }
    return {
      ok: false,
      statusCode: status,
      error: 'payment_accounting_failed',
      message: String(err.message || 'error').slice(0, 200),
    };
  }
};
