/**
 * Dedicated Tax/1099 profile handler.
 *
 * Never returns full TIN/EIN. Generic /data/query and /data/write must not
 * reach recipient_tax_profiles. Do not log request bodies (they may contain a TIN).
 *
 * Actions: list | upsert
 * Roles: platform_owner, platform_admin (user_roles.admin), tenant owner/admin
 *        of the requested tenant_id. Cross-tenant always denied.
 */

import { parseBody, withIdentity, withIdentityWrite } from './data.mjs';
import {
  evaluateTaxAccess,
  publicTaxProfile,
  sanitizeTaxError,
} from './tax-secrets.mjs';

export const TAX_PROFILES_FUNCTION = 'tenant-tax-profiles';

const MASKED_SELECT = `
  id, tenant_id, recipient_key, recipient_name, address_street, address_city,
  address_state, address_zip, account_number, notes, created_at, updated_at,
  (tin IS NOT NULL AND btrim(tin) <> '') AS tin_on_file,
  CASE
    WHEN tin IS NULL OR btrim(tin) = '' THEN NULL
    ELSE right(regexp_replace(tin, '[^0-9]', '', 'g'), 4)
  END AS tin_last_4,
  CASE
    WHEN tin ~ '^\\d{2}-' THEN 'ein'
    WHEN tin ~ '^\\d{3}-' THEN 'ssn'
    WHEN length(regexp_replace(coalesce(tin, ''), '[^0-9]', '', 'g')) = 9 THEN 'unknown'
    ELSE NULL
  END AS tin_type
`;

async function resolveAccess(client, mapping, tenantId) {
  const { rows: ownerRows } = await client.query(
    `SELECT public.is_platform_owner() AS is_owner, public.is_master_owner() AS is_master`,
  );
  const owner = ownerRows[0] || {};
  const isPlatformOwner = owner.is_owner === true || owner.is_master === true;

  const { rows: roleRows } = await client.query(
    `SELECT role FROM public.user_roles WHERE user_id = $1`,
    [mapping.application_user_id],
  );
  const platformRoles = roleRows.map((r) => r.role);

  const { rows: memRows } = await client.query(
    `SELECT role FROM public.tenant_users
      WHERE user_id = $1 AND tenant_id = $2
      LIMIT 1`,
    [mapping.application_user_id, tenantId],
  );
  const tenantMembershipRole = memRows[0]?.role ?? null;

  return evaluateTaxAccess({
    isPlatformOwner,
    platformRoles,
    tenantMembershipRole,
  });
}

async function handleList(client, tenantId) {
  const { rows } = await client.query(
    `SELECT ${MASKED_SELECT}
       FROM public.recipient_tax_profiles
      WHERE tenant_id = $1
      ORDER BY recipient_name NULLS LAST, recipient_key`,
    [tenantId],
  );
  return rows.map((row) => publicTaxProfile(row));
}

async function handleUpsert(client, tenantId, payload) {
  const recipient_key = String(payload.recipient_key || '').trim();
  if (!recipient_key) {
    return {
      ok: false,
      statusCode: 400,
      error: 'recipient_key_required',
    };
  }

  const incomingTin =
    payload.tin == null ? null : String(payload.tin).trim() || null;
  const recipient_name = payload.recipient_name == null ? null : String(payload.recipient_name);
  const address_street = payload.address_street ?? null;
  const address_city = payload.address_city ?? null;
  const address_state = payload.address_state ?? null;
  const address_zip = payload.address_zip ?? null;
  const account_number = payload.account_number ?? null;
  const notes = payload.notes ?? null;

  // Empty/omitted TIN must not overwrite or wipe an existing stored value.
  const { rows } = await client.query(
    `INSERT INTO public.recipient_tax_profiles
       (tenant_id, recipient_key, recipient_name, tin, address_street, address_city,
        address_state, address_zip, account_number, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (tenant_id, recipient_key)
     DO UPDATE SET
       recipient_name = EXCLUDED.recipient_name,
       tin = CASE
         WHEN EXCLUDED.tin IS NOT NULL AND btrim(EXCLUDED.tin) <> '' THEN EXCLUDED.tin
         ELSE public.recipient_tax_profiles.tin
       END,
       address_street = EXCLUDED.address_street,
       address_city = EXCLUDED.address_city,
       address_state = EXCLUDED.address_state,
       address_zip = EXCLUDED.address_zip,
       account_number = EXCLUDED.account_number,
       notes = EXCLUDED.notes,
       updated_at = now()
     RETURNING ${MASKED_SELECT}`,
    [
      tenantId,
      recipient_key,
      recipient_name,
      incomingTin,
      address_street,
      address_city,
      address_state,
      address_zip,
      account_number,
      notes,
    ],
  );
  return { ok: true, profile: publicTaxProfile(rows[0]) };
}

async function dispatch({ client, mapping, body, spoof }) {
  const action = String(body.action || 'list').trim();
  const tenantId = String(body.tenant_id || body.tenantId || '').trim();
  if (!tenantId) {
    return {
      ok: false,
      statusCode: 400,
      error: 'tenant_id_required',
      spoofFieldsIgnored: spoof,
    };
  }

  const access = await resolveAccess(client, mapping, tenantId);
  if (!access.allowed) {
    return {
      ok: false,
      statusCode: 403,
      error: 'forbidden',
      code: access.reason,
      spoofFieldsIgnored: spoof,
    };
  }

  if (action === 'list') {
    const profiles = await handleList(client, tenantId);
    return {
      ok: true,
      statusCode: 200,
      access: access.reason,
      tenant_id: tenantId,
      profiles,
      spoofFieldsIgnored: spoof,
    };
  }

  if (action === 'upsert') {
    const result = await handleUpsert(client, tenantId, body);
    if (!result.ok) {
      return { ...result, spoofFieldsIgnored: spoof };
    }
    return {
      ok: true,
      statusCode: 200,
      access: access.reason,
      tenant_id: tenantId,
      profile: result.profile,
      spoofFieldsIgnored: spoof,
    };
  }

  return {
    ok: false,
    statusCode: 400,
    error: 'unknown_action',
    spoofFieldsIgnored: spoof,
  };
}

export const handleTaxProfiles = async (event, deps = {}) => {
  const body = parseBody(event);
  const wrap = body?.action === 'upsert' ? withIdentityWrite : withIdentity;
  try {
    const result = await wrap(event, async (ctx) => dispatch(ctx), deps);
    if (result?.error || result?.message) {
      return {
        ...result,
        error: sanitizeTaxError(result.error || result.message),
        message: result.message ? sanitizeTaxError(result.message) : undefined,
      };
    }
    return result;
  } catch (err) {
    const status = err.statusCode || 500;
    if (status === 401) {
      return { ok: false, statusCode: 401, error: 'unauthorized' };
    }
    return {
      ok: false,
      statusCode: status,
      error: sanitizeTaxError(err.message || 'error'),
    };
  }
};
