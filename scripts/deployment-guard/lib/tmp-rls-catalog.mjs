/**
 * Canonical TMP RLS catalog fingerprint for SQL 39 CAS.
 * Hashes policy/grant/RLS shape only. Function/trigger hashes stay separate.
 */
import { hashSqlDefinition } from './sql-apply.mjs';

export const TMP_TABLE = 'tenant_maintenance_payments';

export const INSPECTED_WRITE =
  '(is_platform_owner() OR aws_monthly_billing_job() OR (current_setting(\'request.provider_webhook_apply\'::text, true) = \'1\'::text))';

export const INTENDED_WRITE_VARIANTS = Object.freeze([
  'aws_can_write_tenant(tenant_id)',
  '(aws_can_write_tenant(tenant_id))',
  'public.aws_can_write_tenant(tenant_id)',
  '(public.aws_can_write_tenant(tenant_id))',
]);

export const INSPECTED_JOB =
  '(aws_monthly_billing_job() OR (current_setting(\'request.provider_webhook_apply\'::text, true) = \'1\'::text))';

export const EXPECTED_POLICY_NAMES = Object.freeze([
  'aws_select_tenant_maintenance_payments',
  'aws_select_tenant_maintenance_payments_job',
  'aws_write_tenant_maintenance_payments',
  'aws_write_tenant_maintenance_payments_job',
]);

export const FROZEN_FUNCTION_NAMES = Object.freeze([
  'aws_can_access_tenant',
  'aws_can_write_tenant',
  'aws_is_cross_tenant_reader',
  'aws_monthly_billing_job',
  'aws_user_tenant_ids',
  'is_master_owner',
  'is_platform_owner',
  'set_updated_at',
]);

export function canonicalizeTmpRlsCatalog(catalog = {}) {
  const tableCatalog = catalog.table_catalog || {};
  const policies = [...(catalog.policies || [])]
    .map((policy) => ({
      name: policy.name,
      permissive: policy.permissive,
      command: policy.command,
      roles: typeof policy.roles === 'string'
        ? policy.roles
        : `{${[...(policy.roles || [])].join(',')}}`,
      using: policy.using ?? null,
      with_check: policy.with_check === undefined ? (policy.withCheck ?? null) : policy.with_check,
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const grants = [...(catalog.grants || [])]
    .map((grant) => ({
      grantee: grant.grantee,
      privilege_type: grant.privilege_type,
    }))
    .sort((a, b) => (
      `${a.grantee}\0${a.privilege_type}`.localeCompare(`${b.grantee}\0${b.privilege_type}`)
    ));
  return {
    table: catalog.table || tableCatalog.table || TMP_TABLE,
    relrowsecurity: tableCatalog.relrowsecurity ?? catalog.relrowsecurity ?? null,
    relforcerowsecurity: tableCatalog.relforcerowsecurity ?? catalog.relforcerowsecurity ?? null,
    policies,
    grants,
    membership: [...(catalog.lambda_role_membership || catalog.lambdaMembership || [])].sort(),
  };
}

export function hashTmpRlsCatalog(catalog) {
  return hashSqlDefinition(JSON.stringify(canonicalizeTmpRlsCatalog(catalog)));
}

export function hashTmpRlsFrozen(frozen = {}) {
  const functions = [...(frozen.functions || [])]
    .map((row) => ({
      identity: row.identity || `${row.schema || 'public'}.${row.name}(${row.identity_arguments || row.args || ''})`,
      definition_sha256: row.definition_sha256 || hashSqlDefinition(row.definition || ''),
    }))
    .sort((a, b) => a.identity.localeCompare(b.identity));
  const triggers = [...(frozen.triggers || [])]
    .map((row) => ({
      name: row.name,
      definition: row.definition,
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return hashSqlDefinition(JSON.stringify({ functions, triggers }));
}

export function policyByName(catalog, name) {
  return (catalog.policies || []).find((policy) => policy.name === name) || null;
}

export function writePredicateAcceptable(text) {
  return text === INSPECTED_WRITE || INTENDED_WRITE_VARIANTS.includes(text);
}

export function writePredicateIntended(text) {
  return INTENDED_WRITE_VARIANTS.includes(text);
}

export function jobPredicateIntact(text) {
  return text === INSPECTED_JOB;
}
