import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertReadOnlySql } from '../src/db.mjs';
import { handler } from '../src/index.mjs';
import { FIXTURE_TABLES, HARNESS_FUNCTION_NAME, STAGING_RDS_HOST, STAGING_SECRET_ARN_PREFIX } from '../src/constants.mjs';

const stagingArn = `${STAGING_SECRET_ARN_PREFIX}-b4U0Rn`;

test('preflight SQL helper refuses write statements', () => {
  assert.doesNotThrow(() => assertReadOnlySql('SELECT id FROM public.claims'));
  assert.throws(() => assertReadOnlySql('INSERT INTO public.claims (id) VALUES (gen_random_uuid())'));
  assert.throws(() => assertReadOnlySql('UPDATE public.tenants SET name = \'x\''));
  assert.throws(() => assertReadOnlySql('DELETE FROM public.claims'));
  assert.throws(() => assertReadOnlySql('GRANT INSERT ON public.claims TO checksops'));
});

test('preflight mocked path stays read-only and creates no rows', async () => {
  const prev = { ...process.env };
  process.env.CHECKSOPS_ENV = 'staging';
  process.env.DATABASE_NAME = 'checksops';
  process.env.RDS_HOST = STAGING_RDS_HOST;
  process.env.DATABASE_SECRET_ARN = stagingArn;
  process.env.AWS_LAMBDA_FUNCTION_NAME = HARNESS_FUNCTION_NAME;
  process.env.HARNESS_FUNCTION_NAME = HARNESS_FUNCTION_NAME;
  process.env.ALLOW_SYNTHETIC_WRITES = 'false';

  const queries = [];
  const fakeClient = {
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (/^SET default_transaction_read_only|^BEGIN READ ONLY|^ROLLBACK/.test(sql.trim())) return { rows: [] };
      if (/has_table_privilege/.test(sql)) {
        return {
          rows: FIXTURE_TABLES.map((table) => ({
            table_name: table,
            select: true,
            insert: table === 'claims' || table === 'check_intake_items' || table === 'mortgage_handling_requests',
            update: table === 'mortgage_handling_requests',
            delete: table !== 'check_billing_events',
          })),
        };
      }
      if (/set_config\('request.app_user_id'/.test(sql)) return { rows: [{ app_user_id: 'b100f05d-9e81-4a7b-b9cc-9baf173131d9' }] };
      if (/set_config\('request.jwt.claim.email'/.test(sql)) return { rows: [{ email: 'claims@freedomadj.com' }] };
      if (/auth.uid\(\)/.test(sql)) return { rows: [{ auth_uid: 'b100f05d-9e81-4a7b-b9cc-9baf173131d9' }] };
      if (/has_role\(/.test(sql)) return { rows: [{ mortgage_agent: true, admin: false }] };
      if (/relrowsecurity/.test(sql)) return { rows: [{ table_name: 'claims', rls: true, force_rls: false }] };
      if (/pg_constraint|contype = 'f'/.test(sql)) {
        return {
          rows: [{
            from_table: 'mortgage_handling_requests',
            from_column: 'check_intake_item_id',
            to_table: 'check_intake_items',
            to_column: 'id',
            delete_rule: 'RESTRICT',
            update_rule: 'NO ACTION',
            constraint_name: 'mortgage_handling_requests_check_intake_item_id_fkey',
          }],
        };
      }
      if (/current_database\(\)/.test(sql)) {
        return {
          rows: [{
            current_database: 'checksops',
            current_user: 'checksops',
            server_addr: '10.0.0.1',
            default_transaction_read_only: 'on',
            transaction_read_only: 'on',
          }],
        };
      }
      if (/role_table_grants/.test(sql)) {
        return {
          rows: [
            { table_name: 'claims', privilege_type: 'SELECT' },
            { table_name: 'claims', privilege_type: 'INSERT' },
            { table_name: 'claims', privilege_type: 'DELETE' },
            { table_name: 'check_intake_items', privilege_type: 'SELECT' },
            { table_name: 'check_intake_items', privilege_type: 'INSERT' },
            { table_name: 'check_intake_items', privilege_type: 'DELETE' },
            { table_name: 'mortgage_handling_requests', privilege_type: 'SELECT' },
            { table_name: 'mortgage_handling_requests', privilege_type: 'INSERT' },
            { table_name: 'mortgage_handling_requests', privilege_type: 'UPDATE' },
            { table_name: 'mortgage_handling_requests', privilege_type: 'DELETE' },
            { table_name: 'check_billing_events', privilege_type: 'SELECT' },
            { table_name: 'check_billing_events', privilege_type: 'DELETE' },
            { table_name: 'check_audit_log', privilege_type: 'SELECT' },
            { table_name: 'check_audit_log', privilege_type: 'DELETE' },
            { table_name: 'check_messages', privilege_type: 'SELECT' },
            { table_name: 'check_messages', privilege_type: 'DELETE' },
          ],
        };
      }
      if (/information_schema.columns/.test(sql) && /is_nullable = 'NO'/.test(sql)) {
        return { rows: [{ table_name: 'check_intake_items', column_name: 'front_image_path' }] };
      }
      if (/information_schema.columns/.test(sql)) {
        return { rows: [{ table_name: 'claims', column_name: 'id', is_nullable: 'NO', data_type: 'uuid', column_default: 'gen_random_uuid()' }] };
      }
      if (/FOREIGN KEY/.test(sql)) {
        return {
          rows: [{
            from_table: 'mortgage_handling_requests',
            from_column: 'check_intake_item_id',
            to_table: 'check_intake_items',
            to_column: 'id',
            delete_rule: 'RESTRICT',
            update_rule: 'NO ACTION',
            constraint_name: 'mortgage_handling_requests_check_intake_item_id_fkey',
          }],
        };
      }
      if (/FROM public.tenants/.test(sql)) {
        return {
          rows: [{
            id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
            name: 'Freedom',
            mortgage_ops_initial_rate_cents: 1000,
            mortgage_ops_additional_rate_cents: 500,
          }],
        };
      }
      if (/mortgage_ops_billing_launch/.test(sql)) {
        return { rows: [{ singleton: true, launched_at: '2026-09-25T00:00:00Z', environment: 'staging', note: 'launch' }] };
      }
      if (/FROM public.user_roles/.test(sql)) {
        return { rows: [{ role: 'mortgage_agent' }] };
      }
      if (/to_regclass\('public.identity_accounts'\)/.test(sql)) {
        return { rows: [{ ok: true }] };
      }
      if (/FROM public.identity_accounts/.test(sql)) {
        return { rows: [{ application_user_id: 'b100f05d-9e81-4a7b-b9cc-9baf173131d9', status: 'active', cognito_sub: '2498c4b8-f0a1-701b-da4b-a1f5c79f675a' }] };
      }
      if (/pg_get_functiondef/.test(sql)) {
        return { rows: [{ def: "v_event_type := 'mortgage_ops_initial'; mortgage_ops_additional_check; v_cutoff IS NULL; mortgage_ops_billing_launch; v_claim_id" }] };
      }
      if (/tgname = 'tr_accrue_mortgage_ops_billing'/.test(sql)) {
        return { rows: [{ n: 1 }] };
      }
      if (/claim_number LIKE/.test(sql)) {
        return { rows: [{ claims: 0, checks: 0, requests: 0 }] };
      }
      return { rows: [] };
    },
    end: async () => {},
  };

  try {
    const result = await handler({ action: 'preflight' }, {
      captureApplicationShas: async () => ({ unchanged: true, matches: { staging: true, prep: true } }),
      getSecretString: async () => JSON.stringify({
        username: 'checksops',
        host: STAGING_RDS_HOST,
        port: 5432,
        dbname: 'postgres',
        password: 'redacted-test-only',
      }),
      openClient: async () => {
        await fakeClient.query('SET default_transaction_read_only = on');
        await fakeClient.query('BEGIN READ ONLY');
        return fakeClient;
      },
      fetchImpl: async (url) => ({
        status: String(url).includes('/workflow/status') ? 200 : 401,
        json: async () => ({
          flags: {
            AWS_APPLICATION_WORKFLOW_WRITES_ENABLED: true,
            AWS_PROVIDER_EXECUTION_ENABLED: false,
            AWS_MOOV_ENABLED: false,
            AWS_CHECKALT_ENABLED: false,
          },
        }),
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.readOnly, true);
    assert.equal(result.rowsCreated, 0);
    assert.equal(result.syntheticRowsCreated, 0);
    assert.equal(result.grantsIssued, 0);
    assert.equal(result.freedomRates.initialMatches, true);
    assert.equal(result.workflowPlan.usesCopiedSqlAsWorkflow, false);
    const writeStatement = /(?:^|;)[\s(]*(INSERT|UPDATE|DELETE|GRANT)\b/i;
    assert.ok(queries.every((q) => !writeStatement.test(q.sql) || /BEGIN READ ONLY|ROLLBACK/.test(q.sql)));
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in prev)) delete process.env[key];
    }
    Object.assign(process.env, prev);
  }
});
