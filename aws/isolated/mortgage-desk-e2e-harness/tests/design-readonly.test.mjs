import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HARNESS_FUNCTION_NAME, STAGING_RDS_HOST, STAGING_SECRET_ARN_PREFIX } from '../src/constants.mjs';
import { handler } from '../src/index.mjs';

const stagingArn = `${STAGING_SECRET_ARN_PREFIX}-b4U0Rn`;

test('design is an allowed read-only action and does not write', async () => {
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
      if (/FROM pg_roles/.test(sql)) {
        return { rows: [{ rolname: 'checksops', rolsuper: false, rolcanlogin: true, rolbypassrls: false }] };
      }
      if (/has_table_privilege/.test(sql)) {
        return { rows: [{ rolname: 'checksops', claims_insert: false, checks_insert: false }] };
      }
      if (/set_config|auth.uid|is_master_owner|is_platform_owner|cross_tenant|can_access|can_write/.test(sql)) {
        return { rows: [{ app_user_id: 'x', email: '', auth_uid: 'x', is_master_owner: false, is_platform_owner: false, cross_tenant_reader: false, can_access_billing_tenant: true, can_write_billing_tenant: false }] };
      }
      return { rows: [] };
    },
    end: async () => {},
  };

  try {
    const result = await handler({ action: 'design' }, {
      captureApplicationShas: async () => ({ unchanged: true, matches: { staging: true, prep: true } }),
      getSecretString: async () => JSON.stringify({
        username: 'checksops',
        host: STAGING_RDS_HOST,
        port: 5432,
        password: 'redacted-test-only',
      }),
      openClient: async () => fakeClient,
    });
    assert.equal(result.action, 'design');
    assert.equal(result.readOnly, true);
    assert.equal(result.rowsCreated, 0);
    assert.equal(result.grantsIssued, 0);
    assert.equal(result.schemaChanged, false);
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
