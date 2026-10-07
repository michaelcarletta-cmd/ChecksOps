import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { hashSqlDefinition } from '../../scripts/deployment-guard/lib/sql-apply.mjs';
import {
  AUTHORIZED_MEMBERSHIP_ONLY,
  AUTHORIZED_MORTGAGE_OPS_AGENT_ACCEPT_COMPLETE,
  AUTHORIZED_SQL44,
  AUTHORIZED_SQL71,
  AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS,
  authorizationFingerprint,
  evaluateSqlExecutorAuthorization,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';

const EXECUTOR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../write-path/guarded-sql-executor');
const GUARD_LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/deployment-guard/lib');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
fs.mkdirSync(path.join(EXECUTOR_DIR, 'lib'), { recursive: true });
for (const name of ['errors.mjs', 'identity.mjs', 'sql-apply.mjs', 'sql-executor-auth.mjs', 'function-def-lookup.mjs']) {
  const dest = path.join(EXECUTOR_DIR, 'lib', name);
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.copyFileSync(path.join(GUARD_LIB, name), tmp);
  fs.renameSync(tmp, dest);
}
const { createHandler, hashTenantPermissionLiveDefs } = await import('../write-path/guarded-sql-executor/index.mjs');
const { hashMortgageOpsLiveSnapshot } = await import('../write-path/guarded-sql-executor/mortgage-ops-sql39.mjs');

const NOW = '2026-10-03T22:00:00.000Z';
const NOW_MS = Date.parse(NOW);

function familyEvent(pin, overrides = {}) {
  const expectedLive = overrides.expected_live_definition_sha256 || '0'.repeat(64);
  const oneUse = overrides.one_use_id || `compose-${pin.migration_id}-${Math.random().toString(16).slice(2)}`;
  return {
    action: 'authorize',
    workstream_id: 'homeowner-ledger-view-contract-6f10',
    branch: 'cursor/homeowner-ledger-view-contract-6f10',
    commit: pin.commit,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
    owned_components: [pin.filename],
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    expected_live_definition_sha256: expectedLive,
    one_use_id: oneUse,
    expiry: '2026-10-03T23:30:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    preflight_live_fingerprint: authorizationFingerprint({
      ...pin,
      expected_live_definition_sha256: expectedLive,
      one_use_id: oneUse,
    }),
    ...overrides,
  };
}

function recordingConnect() {
  const seen = [];
  const client = {
    seen() { return seen; },
    async query(sql, params = []) {
      const text = String(sql);
      seen.push(text);
      if (text.includes('current_database')) return { rows: [{ d: 'checksops' }] };
      if (text.includes('FROM pg_proc') || text.includes('pg_get_functiondef')) {
        const name = String(params?.[1] || params?.[0] || '');
        if (name.includes('aws_public_homeowner_ledger_by_token')) {
          return { rows: [{ def: 'CREATE FUNCTION public.aws_public_homeowner_ledger_by_token(text) LIVE71' }] };
        }
        if (name.includes('claim_ledger')) {
          return { rows: [{ def: 'CREATE FUNCTION public.claim_ledger_link_or_create() LIVE44' }] };
        }
        if (name.includes('review_save_detected_claim_number')) {
          return { rows: [{ def: 'CREATE FUNCTION public.review_save_detected_claim_number() LIVE43' }] };
        }
        if (name.includes('aws_is_mortgage_ops_agent')) {
          return { rows: [{ def: 'CREATE FUNCTION public.aws_is_mortgage_ops_agent() LIVE39' }] };
        }
        if (name.includes('user_can_move_tenant_checks') || name.includes('admin_override_check_status')) {
          return { rows: [{ def: `CREATE FUNCTION public.${name}() LIVE601` }] };
        }
        return { rows: [] };
      }
      if (text.includes('mops-sql39-') || text.includes('routine_privileges') || text.includes('role_table_grants') || text.includes('column_privileges')) {
        return { rows: [] };
      }
      if (text.includes('FROM public.claims') || text.includes('FROM public.check_intake_items') || text.includes('FROM public.claim_')) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text.slice(0, 140)}`);
    },
    async end() {},
  };
  return { connect: async () => client, client };
}

function handlerFor(connect) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `compose-consumed-${process.pid}-${Date.now()}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({
    connect,
    now: () => NOW_MS,
    sqlFile: path.join(ROOT, AUTHORIZED_SQL44.filename),
    sqlFile601: path.join(ROOT, AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS.filename),
    sqlFile601Predecessor: path.join(ROOT, 'supabase/migrations/20261001193100_tenant_users_can_override_check_status.sql'),
    sqlFileMembership: path.join(ROOT, AUTHORIZED_MEMBERSHIP_ONLY.filename),
    sqlFile39: path.join(ROOT, 'aws/write-path/guarded-sql-executor/sql/39_mortgage_ops_agent_accept_complete.sql'),
    sqlFile71: path.join(ROOT, AUTHORIZED_SQL71.filename),
  });
}

test('composed package routes each live family and SQL 71 to its own handler', async () => {
  const sql44 = recordingConnect();
  const sql44Result = await handlerFor(sql44.connect)(familyEvent(AUTHORIZED_SQL44, {
    expected_live_definition_sha256: hashSqlDefinition('CREATE FUNCTION public.claim_ledger_link_or_create() LIVE44'),
  }));
  assert.equal(sql44Result.ok, true, sql44Result.message);
  assert.equal(sql44Result.details.receipt.sql_file, AUTHORIZED_SQL44.filename);
  assert.equal(sql44Result.details.receipt.result, 'authorize');
  assert.equal(sql44.client.seen().some((sql) => sql.includes('claim_ledger_link_or_create($1')), false);

  const tenant = recordingConnect();
  const tenantLiveHash = hashTenantPermissionLiveDefs({
    user_can_move_tenant_checks: 'CREATE FUNCTION public.user_can_move_tenant_checks() LIVE601',
    admin_override_check_status: 'CREATE FUNCTION public.admin_override_check_status() LIVE601',
  });
  const tenantResult = await handlerFor(tenant.connect)(familyEvent(AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS, {
    expected_live_definition_sha256: tenantLiveHash,
  }));
  assert.equal(tenantResult.ok, true, tenantResult.message);
  assert.equal(tenantResult.details.receipt.sql_file, AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS.filename);
  assert.equal(tenantResult.details.receipt.live_functions.admin_override_check_status, true);

  const membership = recordingConnect();
  const membershipResult = await handlerFor(membership.connect)(familyEvent(AUTHORIZED_MEMBERSHIP_ONLY, {
    expected_live_definition_sha256: tenantLiveHash,
  }));
  assert.equal(membershipResult.ok, true, membershipResult.message);
  assert.equal(membershipResult.details.receipt.sql_file, AUTHORIZED_MEMBERSHIP_ONLY.filename);
  assert.equal('helper_exact' in membershipResult.details.receipt, true);

  const sql39 = recordingConnect();
  const sql39Hash = hashMortgageOpsLiveSnapshot({
    policies: [],
    column_update_grants: [],
    table_grants: [],
    force_rls: [],
    aws_is_mortgage_ops_agent: 'CREATE FUNCTION public.aws_is_mortgage_ops_agent() LIVE39',
    user_can_move_tenant_checks_sha256: hashSqlDefinition('CREATE FUNCTION public.user_can_move_tenant_checks() LIVE601'),
    admin_override_check_status_sha256: hashSqlDefinition('CREATE FUNCTION public.admin_override_check_status() LIVE601'),
  });
  const sql39Result = await handlerFor(sql39.connect)(familyEvent(AUTHORIZED_MORTGAGE_OPS_AGENT_ACCEPT_COMPLETE, {
    expected_live_definition_sha256: sql39Hash,
  }));
  assert.equal(sql39Result.ok, true, sql39Result.message);
  assert.equal(sql39Result.details.receipt.sql_file, AUTHORIZED_MORTGAGE_OPS_AGENT_ACCEPT_COMPLETE.filename);
  assert.ok(sql39.client.seen().some((sql) => sql.includes('mops-sql39-')));

  const sql71 = recordingConnect();
  const sql71Result = await handlerFor(sql71.connect)(familyEvent(AUTHORIZED_SQL71));
  assert.equal(sql71Result.ok, true, sql71Result.message);
  assert.equal(sql71Result.details.receipt.sql_file, AUTHORIZED_SQL71.filename);
  assert.equal(sql71Result.details.receipt.function_identity, AUTHORIZED_SQL71.function_identity);
  assert.equal(sql71.client.seen().some((sql) => sql.includes('CREATE OR REPLACE FUNCTION public.claim_ledger_link_or_create')), false);
  assert.equal(sql71.client.seen().some((sql) => sql.includes('aws_public_homeowner_ledger_by_token($1')), false);
});

test('SQL 71 cannot fall through to SQL 44 and negatives stay fail-closed', () => {
  const { now } = { now: NOW_MS };
  const exact = familyEvent(AUTHORIZED_SQL71);
  const ok71 = evaluateSqlExecutorAuthorization(exact, { now });
  assert.equal(ok71.ok, true, ok71.message);
  assert.equal(ok71.details.allowlist_entry.filename, AUTHORIZED_SQL71.filename);

  assert.equal(evaluateSqlExecutorAuthorization({
    ...exact,
    source_sha256: '1'.repeat(64),
  }, { now }).code, CODES.SQL_COLLISION);
  assert.equal(evaluateSqlExecutorAuthorization({
    ...exact,
    commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }, { now }).code, CODES.SQL_COLLISION);
  assert.equal(evaluateSqlExecutorAuthorization({
    ...exact,
    filename: 'aws/workflows/sql/68_staging_class_a_grants.sql',
    migration_id: '68_staging_class_a_grants',
    owned_components: ['aws/workflows/sql/68_staging_class_a_grants.sql'],
  }, { now }).code, CODES.SQL_COLLISION);
  assert.equal(evaluateSqlExecutorAuthorization({
    ...exact,
    sql_text: 'DROP FUNCTION public.aws_public_homeowner_ledger_by_token(text)',
  }, { now }).code, CODES.UNRELATED_MUTATION);
  assert.equal(evaluateSqlExecutorAuthorization({
    ...exact,
    target_environment: 'production',
    target_component: 'production-sql',
  }, { now }).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
});
