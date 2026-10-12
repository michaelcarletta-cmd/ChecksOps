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
import { CODES, errorEntry, fail, failMany, ok } from './errors.mjs';
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

export const AUTHORIZED_SQL53 = Object.freeze({
  filename: 'aws/workflows/sql/53_claim_settlement_breakdown.sql',
  migration_id: '53_claim_settlement_breakdown',
  commit: '8de7888606b00e7d9a5f0776f2f9c4afe7c14fd1',
  source_sha256: '5a8f8bc35c69f2b339c78f3637d6bb1c606117967e3ab9d83b5dec1d37561197',
  intended_replacement_sha256: '6542c3f6fb3f7d50b758b3d7352fe6fb49cbe8cd2bd5c6061dbc35a6e9fccf52',
  function_identity: 'public.save_claim_settlement_breakdown(uuid,uuid,jsonb)',
  absent_live_definition_sha256: '0000000000000000000000000000000000000000000000000000000000000000',
  preserved_function_identities: Object.freeze([
    'public.sync_homeowner_ledger_from_check()',
    'public.aws_can_write_claim(uuid)',
    'public.hle_on_check_intake_insert()',
  ]),
});

// Replace-only: the live July definition (9f6ec2dc…) is the only accepted
// starting point. See ops/deployment-guard/ledger-20261007193200-staging-authorization.json.
export const AUTHORIZED_LEDGER_20261007193200 = Object.freeze({
  filename: 'supabase/migrations/20261007193200_skip_claim_ledger_event_for_endorsement_stage.sql',
  migration_id: '20261007193200_skip_claim_ledger_event_for_endorsement_stage',
  commit: 'b303311836fd597583929a792123c8f8f302fc89',
  source_sha256: '1a9e6d54c67d2068ba9497f10fcf6956c1699b3005e679b72c3cc3bf2e37878b',
  intended_replacement_sha256: '03fcea3c87b8ed087222b4071cbe36542df00dfca5c21ea44d20dc113a1047a2',
  expected_live_definition_sha256: '9f6ec2dc9a5bcb7b7651d5b556788eb73ba5b567d457196fe82544f98aca8699',
  function_identity: 'public.sync_homeowner_ledger_from_check()',
  preserved_function_definition_sha256: Object.freeze({
    'public.hle_on_check_intake_insert()': 'bdd9ec4b45b79ef3b3b21c5f18c2785d901edc606695fbc84f0daedecff5ff48',
    'public.aws_can_write_claim(uuid)': '0a7e62b26bf4dd07ce9c06a104773d472ccff6b5a0207d338de4ba594eb32caf',
  }),
  trigger_table: 'public.check_intake_items',
  required_ledger_triggers: Object.freeze({
    trg_hle_check_intake_insert: 'hle_on_check_intake_insert',
    trg_sync_homeowner_ledger_ins: 'sync_homeowner_ledger_from_check',
    trg_sync_homeowner_ledger_upd: 'sync_homeowner_ledger_from_check',
  }),
});

// Column privilege grant. The "definition" is the canonical privilege state
// string, hashed: AMOUNT_GRANT_STATE_TEXT.absent before, .granted after.
export const AMOUNT_GRANT_STATE_TEXT = Object.freeze({
  absent: 'checksops UPDATE (amount) ON public.check_intake_items: absent',
  granted: 'checksops UPDATE (amount) ON public.check_intake_items: granted',
});
export const AUTHORIZED_SQL71_AMOUNT_GRANT = Object.freeze({
  filename: 'aws/workflows/sql/71_review_amount_column_grant.sql',
  migration_id: '71_review_amount_column_grant',
  commit: 'a04461398e3250d49399ab1e3fc5cfa0e911cbb7',
  source_sha256: 'ada473038b3771232b9c9a290629362ad67ab31e0985bbc2d260aeafcda78966',
  expected_live_definition_sha256: '2d96f50bae23aac3c9893656a4e68eccb1f1c298d5c1085753dd1472e1a3df2a',
  intended_replacement_sha256: 'ff8e86f95a78474068f6b083087ac6fdad7af321aff9a6536ca38faadf5d35a9',
  grantee: 'checksops',
  table: 'public.check_intake_items',
  column: 'amount',
});

export const AUTHORIZED_SQL39 = Object.freeze({
  filename: 'aws/rls/sql/39_tmp_write_policy_reconcile.sql',
  migration_id: '39_tmp_write_policy_reconcile',
  commit: 'f2df6f9bed6ae3ddca9fce39668aa117de796de1',
  source_sha256: 'a3ec9922d33cf75fc554ac9bdd3e7c1b14429112f38ce23f517d64e06b9442a9',
  intended_replacement_sha256: 'a3ec9922d33cf75fc554ac9bdd3e7c1b14429112f38ce23f517d64e06b9442a9',
  table: 'public.tenant_maintenance_payments',
  policy_name: 'aws_write_tenant_maintenance_payments',
  job_policy_name: 'aws_write_tenant_maintenance_payments_job',
});

export const AUTHORIZED_SQL40 = Object.freeze({
  filename: 'aws/rls/sql/40_collection_v2_synthetic_uat_cleanup.sql',
  migration_id: '40_collection_v2_synthetic_uat_cleanup',
  commit: '5ae0a41db7ebe727527060139befb4ba31240144',
  source_sha256: '9f691e72da8e3490489854f685f470884441e61e2475b91e92fec55fd80b5de8',
  intended_replacement_sha256: '40a486ede83069b6b640ef4c4b06b88585be2b30102673bccde22238b185405d',
  expected_live_fixture_sha256: '48c32f695046582285a5dd97433a52da528ad8be0f6b33c2d46c3395a51e98f0',
  table: 'public.tenant_maintenance_payments',
});

export const AUTHORIZED_STAGING_SQL = Object.freeze([
  AUTHORIZED_SQL44,
  AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS,
  AUTHORIZED_SQL53,
  AUTHORIZED_SQL39,
  AUTHORIZED_SQL40,
  AUTHORIZED_LEDGER_20261007193200,
  AUTHORIZED_SQL71_AMOUNT_GRANT,
]);

export function pinIdentifiersMatch(input = {}, pin = {}) {
  const hasFile = Boolean(input.filename);
  const hasMigration = Boolean(input.migration_id);
  const fileOk = input.filename === pin.filename;
  const migrationOk = input.migration_id === pin.migration_id;
  if (hasFile && hasMigration) return fileOk && migrationOk;
  if (hasFile) return fileOk;
  if (hasMigration) return migrationOk;
  return false;
}

export function isSql53AuthorizedMigration(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_SQL53);
}

export function isLedger20261007193200(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_LEDGER_20261007193200);
}

export function isSql71AmountGrant(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_SQL71_AMOUNT_GRANT);
}

export function isSql39(input = {}) {
  return input.filename === AUTHORIZED_SQL39.filename
    || input.migration_id === AUTHORIZED_SQL39.migration_id;
}

export function isSql40(input = {}) {
  return input.filename === AUTHORIZED_SQL40.filename
    || input.migration_id === AUTHORIZED_SQL40.migration_id;
}

export function isTenantUsersSameCheckPermissions(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS);
}

export function isSql44AuthorizedMigration(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_SQL44);
}

export function resolveAuthorizedMigration(input = {}) {
  if (isSql53AuthorizedMigration(input)) return AUTHORIZED_SQL53;
  if (isLedger20261007193200(input)) return AUTHORIZED_LEDGER_20261007193200;
  if (isSql71AmountGrant(input)) return AUTHORIZED_SQL71_AMOUNT_GRANT;
  if (isSql40(input)) return AUTHORIZED_SQL40;
  if (isSql39(input)) return AUTHORIZED_SQL39;
  if (isTenantUsersSameCheckPermissions(input)) return AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS;
  if (isSql44AuthorizedMigration(input)) return AUTHORIZED_SQL44;
  return null;
}

export function requireAuthorizedMigration(input = {}) {
  const authorized = resolveAuthorizedMigration(input);
  if (!authorized) {
    return fail(
      CODES.SQL_COLLISION,
      'authorization package is not bound to an allowlisted staging SQL file',
      {
        filename: input.filename || null,
        migration_id: input.migration_id || null,
      },
    );
  }
  return ok({ allowlist_entry: authorized });
}

export function classifySql53CreateLive(input = {}, pin = AUTHORIZED_SQL53) {
  const liveHash = SHA256_RE.test(String(input.live_definition_sha256 || ''))
    ? input.live_definition_sha256
    : null;
  const absentHash = pin.absent_live_definition_sha256;
  const provenPresent = input.exists === true || (Boolean(liveHash) && liveHash !== absentHash);

  if (provenPresent) {
    if (liveHash === pin.intended_replacement_sha256) {
      return fail(
        CODES.UNRELATED_MUTATION,
        'settlement function already matches the intended definition; refuse replace',
        {
          function_identity: pin.function_identity,
          live_definition_sha256: liveHash,
          intended_replacement_sha256: pin.intended_replacement_sha256,
        },
      );
    }
    return fail(
      CODES.SQL_COLLISION,
      'settlement function exists; refuse replace',
      {
        function_identity: pin.function_identity,
        live_definition_sha256: liveHash,
        intended_replacement_sha256: pin.intended_replacement_sha256,
      },
    );
  }

  if (input.exists === false && liveHash === absentHash) {
    return ok({
      state: 'absent',
      apply_allowed: true,
      live_definition_sha256: absentHash,
    });
  }

  return fail(
    CODES.SQL_COLLISION,
    'SQL 53 create requires exists: false and the absent-function live hash immediately before apply',
    {
      function_identity: pin.function_identity,
      exists: input.exists === true ? true : input.exists === false ? false : null,
      live_definition_sha256: liveHash,
      absent_live_definition_sha256: absentHash,
    },
  );
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
