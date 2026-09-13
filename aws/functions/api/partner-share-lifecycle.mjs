/**
 * Partner Codes Phase 3: dedicated share/revoke RPCs.
 * Not generic /data/write. Source tenant and check owner are server-derived.
 */
import { ignoredSpoof, parseBody, withIdentity, withIdentityWrite } from './data.mjs';
import { writesEnabled } from './write-allowlist.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const PARTNER_SHARE_RPCS = new Set([
  'connect_partner_by_code',
  'share_check_with_partner',
  'revoke_shared_check',
  'revoke_tenant_partnership',
]);

const isUuid = (value) => UUID_RE.test(String(value || ''));

const arg = (args, ...keys) => {
  for (const key of keys) {
    if (args[key] !== undefined && args[key] !== null && args[key] !== '') return args[key];
  }
  return null;
};

const denied = (spoof, extra) => ({
  ok: false,
  statusCode: extra.statusCode || 403,
  spoofFieldsIgnored: spoof,
  providerExecution: false,
  productionSupabaseChanged: false,
  ...extra,
});

const ok = ({ mapping, claims, spoof, data }) => ({
  ok: true,
  statusCode: 200,
  data,
  applicationUserId: mapping.application_user_id,
  authUid: mapping.application_user_id,
  cognitoSub: claims.sub,
  spoofFieldsIgnored: spoof,
  authorizationSource: 'partner_share_lifecycle',
  providerExecution: false,
  productionSupabaseChanged: false,
  writesEnabled: true,
});

const statusForSql = (error) => {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  if (code === '42501' || /not_authorized|not_a_partner/i.test(message)) return 403;
  if (
    code === '22023'
    || code === 'P0002'
    || /invalid_partner_code|partner_code_not_found|self_|missing_required|not_found/i.test(message)
  ) return 400;
  return 403;
};

export const executePartnerShareRpc = async ({ client, name, args }) => {
  if (name === 'connect_partner_by_code') {
    const code = String(arg(args, '_code', 'code') || '');
    const sourceTenantId = arg(args, '_source_tenant_id', 'source_tenant_id');
    if (!isUuid(sourceTenantId)) return { error: 'invalid_uuid', field: 'source_tenant_id' };
    const ignoredTarget = arg(args, 'invitee_tenant_id', 'target_tenant_id', 'targetTenantId');
    const result = await client.query(
      'SELECT public.aws_connect_partner_by_code($1, $2::uuid) AS result',
      [code, sourceTenantId],
    );
    return { data: { ...result.rows[0]?.result, ignoredTargetTenantId: Boolean(ignoredTarget) } };
  }
  if (name === 'share_check_with_partner') {
    const checkId = arg(args, '_check_id', 'check_id');
    const targetTenantId = arg(args, '_target_tenant_id', 'target_tenant_id');
    if (!isUuid(checkId) || !isUuid(targetTenantId)) return { error: 'invalid_uuid' };
    const ignoredSource = arg(args, 'source_tenant_id', '_source_tenant_id');
    const result = await client.query(
      'SELECT public.aws_share_check_with_partner($1::uuid, $2::uuid) AS result',
      [checkId, targetTenantId],
    );
    return { data: { ...result.rows[0]?.result, ignoredSourceTenantId: Boolean(ignoredSource) } };
  }
  if (name === 'revoke_shared_check') {
    const shareId = arg(args, '_share_id', 'share_id', 'id');
    if (!isUuid(shareId)) return { error: 'invalid_uuid', field: 'share_id' };
    const result = await client.query(
      'SELECT public.aws_revoke_shared_check($1::uuid) AS result',
      [shareId],
    );
    return { data: result.rows[0]?.result };
  }
  if (name === 'revoke_tenant_partnership') {
    const partnershipId = arg(args, '_partnership_id', 'partnership_id', 'id');
    if (!isUuid(partnershipId)) return { error: 'invalid_uuid', field: 'partnership_id' };
    const result = await client.query(
      'SELECT public.aws_revoke_tenant_partnership($1::uuid) AS result',
      [partnershipId],
    );
    return { data: result.rows[0]?.result };
  }
  return { error: 'rpc_disabled', name };
};

export const handlePartnerShareRpc = async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  let name;
  try {
    name = String(body.name || body.rpc || '').replace(/^public\./, '');
  } catch {
    return denied(spoof, { statusCode: 400, error: 'invalid_rpc' });
  }
  if (!PARTNER_SHARE_RPCS.has(name)) {
    return denied(spoof, { error: 'rpc_disabled', name });
  }
  if (deps.forceEnabled !== true && !writesEnabled()) {
    return withIdentity(event, async () => denied(spoof, {
      error: 'writes_disabled',
      message: 'AWS writes are disabled by AWS_WRITES_ENABLED',
      name,
    }), deps);
  }
  return withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    if (body.sql || body.query || body.rawSql) {
      return denied(spoof, { error: 'generic_sql_denied' });
    }
    const args = body.args && typeof body.args === 'object' ? body.args : {};
    try {
      const executed = await executePartnerShareRpc({ client, name, args });
      if (executed.error) {
        const status = executed.error === 'invalid_uuid' ? 400 : 403;
        return denied(spoof, { statusCode: status, name, ...executed });
      }
      return ok({ mapping, claims, spoof, data: executed.data });
    } catch (error) {
      return denied(spoof, {
        statusCode: statusForSql(error),
        error: String(error?.message || 'partner_share_denied').split('\n')[0],
        name,
      });
    }
  }, deps);
};
