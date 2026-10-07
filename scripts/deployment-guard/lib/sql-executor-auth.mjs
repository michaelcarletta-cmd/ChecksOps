/**
 * Authorization for the staging-only VPC SQL executor.
 *
 * This is not a weakening of sql-apply. evaluateSqlApply still requires
 * expected AND live definition hashes. The executor path is a separate
 * deployment_type so a VPC receipt cannot skip that collision check.
 *
 * Immediately-before live hashing happens inside the VPC executor via
 * evaluateSqlCollision. This module only binds the authorization package.
 */
import { CODES, errorEntry, failMany, ok } from './errors.mjs';
import { validateWorkstreamIdentity } from './identity.mjs';

export const SQL_EXECUTOR_DEPLOYMENT_TYPE = 'sql-executor-invoke';
export const SQL_EXECUTOR_COMPONENT = 'staging-sql';
export const SQL_EXECUTOR_FUNCTION = 'checksops-staging-guarded-sql-executor';
export const FORBIDDEN_EXECUTOR_FUNCTIONS = Object.freeze([
  'checksops-staging-api',
  'checksops-staging-sql44-2d41',
  'checksops-production-prep-api',
  'checksops-production-origin-verify',
]);

export const AUTHORIZED_SQL44 = Object.freeze({
  filename: 'aws/write-path/sql/44_claim_ledger_link_or_create.sql',
  migration_id: '44_claim_ledger_link_or_create',
  commit: '0d965fb5a6ec190cc0b5e8edf29352a917382b30',
  source_sha256: '059f10e936f27439b9fddae7030b76fe594d6538087de389ab07950fefdf8763',
  intended_replacement_sha256: '059f10e936f27439b9fddae7030b76fe594d6538087de389ab07950fefdf8763',
  function_identity: 'public.claim_ledger_link_or_create(uuid,uuid,text,text)',
  sql43_function_identity: 'public.review_save_detected_claim_number(uuid,uuid,text)',
  expected_sql43_definition_sha256: '31a3d2fb20033987a3bdde93f102573c36acc99ae3969e84ad4dc50c916f4806',
});

export const AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS = Object.freeze({
  filename: 'supabase/migrations/20261001231500_tenant_users_same_check_permissions.sql',
  migration_id: '20261001231500_tenant_users_same_check_permissions',
  commit: '6b222b63c955e8c47569ef3704541303680c649e',
  source_sha256: '573ec6a0178d04a041e053aeb724560950b504d162b6f113563bec5108a0e518',
  intended_replacement_sha256: '573ec6a0178d04a041e053aeb724560950b504d162b6f113563bec5108a0e518',
  function_identities: Object.freeze([
    'public.user_can_move_tenant_checks(uuid,uuid)',
    'public.admin_override_check_status(uuid,text,uuid)',
  ]),
});

export const AUTHORIZED_MEMBERSHIP_ONLY = Object.freeze({
  filename: 'supabase/migrations/20261002200000_user_can_move_tenant_checks_membership_only.sql',
  migration_id: '20261002200000_user_can_move_tenant_checks_membership_only',
  commit: 'e97e2c7c3f873e564a9d0e5af6d1a921ff2c29b0',
  source_sha256: '298506c90be829222c75781dd7c546fdefc6c5b2fa5cf86442eed30d383ef22e',
  intended_replacement_sha256: '298506c90be829222c75781dd7c546fdefc6c5b2fa5cf86442eed30d383ef22e',
  function_identities: Object.freeze([
    'public.user_can_move_tenant_checks(uuid,uuid)',
    'public.admin_override_check_status(uuid,text,uuid)',
  ]),
});

export const AUTHORIZED_MORTGAGE_OPS_AGENT_ACCEPT_COMPLETE = Object.freeze({
  filename: 'aws/rls/sql/39_mortgage_ops_agent_accept_complete.sql',
  migration_id: '39_mortgage_ops_agent_accept_complete',
  commit: '1ed46900077cf5834ba8ab5c1b30a332b6c692d6',
  source_sha256: 'c59845e439cfdfd48be955d8ab78128de4ba39211b136616fc23799215145e3f',
  intended_replacement_sha256: 'c59845e439cfdfd48be955d8ab78128de4ba39211b136616fc23799215145e3f',
  function_identities: Object.freeze([
    'public.aws_is_mortgage_ops_agent()',
  ]),
});

export const AUTHORIZED_SQL71 = Object.freeze({
  filename: 'aws/workflows/sql/71_homeowner_ledger_view_contract.sql',
  migration_id: '71_homeowner_ledger_view_contract',
  commit: '1d945f76bead581459019e0109510365618485a5',
  source_sha256: '21d0968676097bb771e0271a6793e9ad0d48d4be02c70e85d728eb0f0b657ab5',
  intended_replacement_sha256: '21d0968676097bb771e0271a6793e9ad0d48d4be02c70e85d728eb0f0b657ab5',
  function_identity: 'public.aws_public_homeowner_ledger_by_token(text)',
});

export const AUTHORIZED_STAGING_SQL = Object.freeze([
  AUTHORIZED_SQL44,
  AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS,
  AUTHORIZED_MEMBERSHIP_ONLY,
  AUTHORIZED_MORTGAGE_OPS_AGENT_ACCEPT_COMPLETE,
  AUTHORIZED_SQL71,
]);

export function resolveAuthorizedMigration(input = {}) {
  if (
    input.filename === AUTHORIZED_SQL71.filename
    || input.migration_id === AUTHORIZED_SQL71.migration_id
  ) {
    return AUTHORIZED_SQL71;
  }
  if (
    input.filename === AUTHORIZED_MORTGAGE_OPS_AGENT_ACCEPT_COMPLETE.filename
    || input.migration_id === AUTHORIZED_MORTGAGE_OPS_AGENT_ACCEPT_COMPLETE.migration_id
  ) {
    return AUTHORIZED_MORTGAGE_OPS_AGENT_ACCEPT_COMPLETE;
  }
  if (
    input.filename === AUTHORIZED_MEMBERSHIP_ONLY.filename
    || input.migration_id === AUTHORIZED_MEMBERSHIP_ONLY.migration_id
  ) {
    return AUTHORIZED_MEMBERSHIP_ONLY;
  }
  if (
    input.filename === AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS.filename
    || input.migration_id === AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS.migration_id
  ) {
    return AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS;
  }
  return AUTHORIZED_SQL44;
}

export function isTenantUsersSameCheckPermissions(input = {}) {
  return resolveAuthorizedMigration(input) === AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS;
}

export function isMembershipOnlyHelper(input = {}) {
  return resolveAuthorizedMigration(input) === AUTHORIZED_MEMBERSHIP_ONLY;
}

export function isMortgageOpsAcceptComplete(input = {}) {
  return resolveAuthorizedMigration(input) === AUTHORIZED_MORTGAGE_OPS_AGENT_ACCEPT_COMPLETE;
}

export function isHomeownerLedgerViewContract(input = {}) {
  return resolveAuthorizedMigration(input) === AUTHORIZED_SQL71;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const ONE_USE_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const ALLOWED_ACTIONS = new Set(['authorize', 'apply', 'inspect', 'verify_data']);
const FORBIDDEN_ACTIONS = new Set(['create_new', 'link_existing', 'restore', 'reclaim', 'reuse']);

export function authorizationFingerprint(input = {}) {
  return {
    sql: input.expected_live_definition_sha256 || null,
    filename: input.filename || null,
    migration_id: input.migration_id || null,
    source_sha256: input.source_sha256 || null,
    intended_replacement_sha256: input.intended_replacement_sha256 || null,
    one_use_id: input.one_use_id || null,
    commit: input.commit || null,
  };
}

function matchingAllowlistEntry(input, allowlist) {
  return allowlist.find((row) => (
    row.filename === input.filename
    && row.migration_id === input.migration_id
    && row.commit === input.commit
    && row.source_sha256 === input.source_sha256
    && row.intended_replacement_sha256 === input.intended_replacement_sha256
  )) || null;
}

export function evaluateSqlExecutorAuthorization(input = {}, opts = {}) {
  const allowlist = opts.allowlist || AUTHORIZED_STAGING_SQL;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const errors = [];

  if (input.sql_text != null || input.sql != null || input.statement != null || input.arbitrary_sql != null) {
    return failMany([errorEntry(
      CODES.UNRELATED_MUTATION,
      'arbitrary SQL text is forbidden; the executor may apply only the allowlisted source file',
    )], CODES.UNRELATED_MUTATION);
  }

  const environment = input.target_environment || input.environment;
  if (environment === 'production') {
    return failMany([errorEntry(
      CODES.PRODUCTION_APPROVAL_REQUIRED,
      'the VPC SQL executor is staging-only and must never target production',
      { target_environment: environment },
    )], CODES.PRODUCTION_APPROVAL_REQUIRED);
  }
  if (environment !== 'staging') {
    errors.push(errorEntry(CODES.INVALID_MANIFEST, 'SQL executor authorization requires target_environment=staging'));
  }

  const component = input.target_component || input.component;
  if (component !== SQL_EXECUTOR_COMPONENT) {
    errors.push(errorEntry(
      CODES.RECEIPT_MISMATCH,
      'SQL executor authorization requires component=staging-sql; a Lambda or SPA receipt cannot authorize SQL',
      { target_component: component || null },
    ));
  }

  if ((input.deployment_type || SQL_EXECUTOR_DEPLOYMENT_TYPE) !== SQL_EXECUTOR_DEPLOYMENT_TYPE) {
    errors.push(errorEntry(
      CODES.RECEIPT_MISMATCH,
      'SQL executor authorization requires deployment_type=sql-executor-invoke; sql-apply receipts are not an escape hatch',
      { deployment_type: input.deployment_type || null },
    ));
  }

  const functionName = input.function_name || input.executor_identity || SQL_EXECUTOR_FUNCTION;
  if (FORBIDDEN_EXECUTOR_FUNCTIONS.includes(functionName) || functionName !== SQL_EXECUTOR_FUNCTION) {
    errors.push(errorEntry(
      CODES.UNRELATED_MUTATION,
      'executor function identity is not the dedicated staging SQL executor',
      { function_name: functionName },
    ));
  }

  const action = String(input.action || 'authorize').trim();
  if (FORBIDDEN_ACTIONS.has(action)) {
    return failMany([errorEntry(
      CODES.UNRELATED_MUTATION,
      `executor action ${action} is forbidden`,
      { action },
    )], CODES.UNRELATED_MUTATION);
  }
  if (!ALLOWED_ACTIONS.has(action)) {
    errors.push(errorEntry(CODES.INVALID_MANIFEST, `executor action must be one of ${[...ALLOWED_ACTIONS].join(', ')}`));
  }

  if (!SHA256_RE.test(String(input.expected_live_definition_sha256 || ''))) {
    errors.push(errorEntry(CODES.INVALID_MANIFEST, 'authorization package requires expected_live_definition_sha256'));
  }
  if (!SHA256_RE.test(String(input.intended_replacement_sha256 || ''))) {
    errors.push(errorEntry(CODES.INVALID_MANIFEST, 'authorization package requires intended_replacement_sha256'));
  }
  if (!SHA256_RE.test(String(input.source_sha256 || ''))) {
    errors.push(errorEntry(CODES.INVALID_MANIFEST, 'authorization package requires source_sha256'));
  }
  if (!input.filename) errors.push(errorEntry(CODES.INVALID_MANIFEST, 'authorization package requires filename'));
  if (!input.migration_id) errors.push(errorEntry(CODES.INVALID_MANIFEST, 'authorization package requires migration_id'));
  if (!ONE_USE_RE.test(String(input.one_use_id || ''))) {
    errors.push(errorEntry(CODES.INVALID_MANIFEST, 'authorization package requires a one_use_id'));
  }
  if (!input.expiry || Number.isNaN(Date.parse(input.expiry))) {
    errors.push(errorEntry(CODES.RECEIPT_EXPIRED, 'authorization package requires an expiry timestamp'));
  } else if (Date.parse(input.expiry) <= now) {
    errors.push(errorEntry(CODES.RECEIPT_EXPIRED, 'authorization package has expired', { expiry: input.expiry }));
  }

  const allowed = matchingAllowlistEntry(input, allowlist);
  if (!allowed) {
    errors.push(errorEntry(
      CODES.SQL_COLLISION,
      'authorization package is not bound to an allowlisted staging SQL file/commit/hash tuple',
      {
        filename: input.filename || null,
        migration_id: input.migration_id || null,
        commit: input.commit || null,
        source_sha256: input.source_sha256 || null,
        intended_replacement_sha256: input.intended_replacement_sha256 || null,
      },
    ));
  } else if (
    input.expected_live_definition_sha256
    && input.intended_replacement_sha256
    && input.expected_live_definition_sha256 === input.intended_replacement_sha256
  ) {
    errors.push(errorEntry(
      CODES.INVALID_MANIFEST,
      'intended replacement hash must differ from the expected live definition hash',
    ));
  }

  const fingerprint = authorizationFingerprint(input);
  const provided = input.preflight_live_fingerprint;
  if (provided && typeof provided === 'object') {
    if (provided.sql && provided.sql !== fingerprint.sql) {
      errors.push(errorEntry(CODES.DEPLOYMENT_COLLISION, 'receipt fingerprint sql hash does not match expected live definition', {
        receipt_sql: provided.sql,
        expected_live_definition_sha256: fingerprint.sql,
      }));
    }
    if (provided.one_use_id && provided.one_use_id !== fingerprint.one_use_id) {
      errors.push(errorEntry(CODES.RECEIPT_MISMATCH, 'receipt one_use_id does not match the authorization package'));
    }
    if (provided.intended_replacement_sha256 && provided.intended_replacement_sha256 !== fingerprint.intended_replacement_sha256) {
      errors.push(errorEntry(CODES.RECEIPT_MISMATCH, 'receipt intended replacement hash does not match the authorization package'));
    }
    if (provided.source_sha256 && provided.source_sha256 !== fingerprint.source_sha256) {
      errors.push(errorEntry(CODES.RECEIPT_MISMATCH, 'receipt source hash does not match the authorization package'));
    }
    if (provided.filename && provided.filename !== fingerprint.filename) {
      errors.push(errorEntry(CODES.RECEIPT_MISMATCH, 'receipt filename does not match the authorization package'));
    }
    if (provided.commit && provided.commit !== fingerprint.commit) {
      errors.push(errorEntry(CODES.RECEIPT_MISMATCH, 'receipt commit does not match the authorization package'));
    }
  }

  const identity = validateWorkstreamIdentity({
    workstream_id: input.workstream_id,
    branch: input.branch,
    commit: input.commit,
    operator: input.operator,
    target_environment: environment,
    deployment_type: input.deployment_type || SQL_EXECUTOR_DEPLOYMENT_TYPE,
    owned_components: input.owned_components || (input.filename ? [input.filename] : []),
    preflight_live_fingerprint: provided || fingerprint,
    build_timestamp: input.build_timestamp,
  });
  if (!identity.ok) {
    errors.push(...identity.errors);
  }

  if (errors.length) {
    const code = errors.some((row) => row.code === CODES.SQL_COLLISION)
      ? CODES.SQL_COLLISION
      : errors.some((row) => row.code === CODES.DEPLOYMENT_COLLISION)
        ? CODES.DEPLOYMENT_COLLISION
        : errors.some((row) => row.code === CODES.RECEIPT_EXPIRED)
          ? CODES.RECEIPT_EXPIRED
          : errors[0].code;
    return failMany(errors, code);
  }

  return ok({
    sql_executor_allowed: true,
    vpc_executor: true,
    live_hash_deferred_to_executor: true,
    sql_apply_live_hash_not_skipped: true,
    action,
    function_name: SQL_EXECUTOR_FUNCTION,
    authorization_fingerprint: fingerprint,
    allowlist_entry: {
      filename: allowed.filename,
      migration_id: allowed.migration_id,
      commit: allowed.commit,
      function_identity: allowed.function_identity,
    },
  });
}
