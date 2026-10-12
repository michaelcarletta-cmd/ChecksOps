import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HARNESS_FUNCTION_NAME, STAGING_RDS_HOST, STAGING_SECRET_ARN_PREFIX } from '../src/constants.mjs';
import { handler } from '../src/index.mjs';

const stagingArn = `${STAGING_SECRET_ARN_PREFIX}-b4U0Rn`;

test('investigate is an allowed read-only action and does not write', async () => {
  const prev = { ...process.env };
  process.env.CHECKSOPS_ENV = 'staging';
  process.env.DATABASE_NAME = 'checksops';
  process.env.RDS_HOST = STAGING_RDS_HOST;
  process.env.DATABASE_SECRET_ARN = stagingArn;
  process.env.AWS_LAMBDA_FUNCTION_NAME = HARNESS_FUNCTION_NAME;
  process.env.ALLOW_SYNTHETIC_WRITES = 'false';

  const queries = [];
  const fakeClient = {
    query: async (sql) => {
      queries.push(sql);
      if (/current_database/.test(sql)) {
        return { rows: [{ current_database: 'checksops', current_user: 'checksops', transaction_read_only: 'on' }] };
      }
      if (/has_table_privilege/.test(sql)) {
        return { rows: [{ table_name: 'claims', insert: false, update: false, delete: false, select: true }] };
      }
      if (/information_schema.columns/.test(sql)) {
        return { rows: [{ column_name: 'id' }, { column_name: 'name' }, { column_name: 'claim_number' }] };
      }
      if (/FROM public.identity_accounts/.test(sql)) return { rows: [] };
      if (/FROM public.tenants/.test(sql)) return { rows: [] };
      if (/FROM public.claims/.test(sql)) return { rows: [] };
      if (/pg_get_functiondef/.test(sql)) return { rows: [{ def: "v_event_type := 'mortgage_ops_initial'" }] };
      if (/mortgage_ops_billing_launch/.test(sql)) return { rows: [{ singleton: true }] };
      if (/check_billing_config|tenant_credit_balances/.test(sql)) return { rows: [] };
      if (/set_config|auth.uid|is_master_owner|is_platform_owner|cross_tenant/.test(sql)) {
        return { rows: [{ app_user_id: 'x', email: '', auth_uid: 'x', is_master_owner: false, is_platform_owner: false, cross_tenant_reader: false }] };
      }
      return { rows: [] };
    },
    end: async () => {},
  };

  try {
    const result = await handler({ action: 'investigate' }, {
      captureApplicationShas: async () => ({ unchanged: true, matches: { staging: true, prep: true } }),
      getSecretString: async () => JSON.stringify({
        username: 'checksops',
        host: STAGING_RDS_HOST,
        port: 5432,
        password: 'redacted-test-only',
      }),
      openClient: async () => fakeClient,
    });
    assert.equal(result.action, 'investigate');
    assert.equal(result.readOnly, true);
    assert.equal(result.rowsCreated, 0);
    assert.equal(result.grantsIssued, 0);
    assert.ok(result.ok === true || result.error);
    const writeStatement = /(?:^|;)[\s(]*(INSERT|UPDATE|DELETE|GRANT)\b/i;
    assert.ok(queries.every((sql) => !writeStatement.test(sql)));
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in prev)) delete process.env[key];
    }
    Object.assign(process.env, prev);
  }
});
