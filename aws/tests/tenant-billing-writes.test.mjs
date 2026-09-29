import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { handleWrite } from '../functions/api/write.mjs';
import {
  denyTableReason,
  pickAllowlistedValues,
  WRITE_ALLOWLIST,
} from '../functions/api/write-allowlist.mjs';
import { executeAppMetadataWrite } from '../functions/api/write-app-metadata.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(ROOT, '..');
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = '04d85458-aaaa-4bbb-8ccc-ddddeeee0001';
const SPOOF_ID = '00000000-0000-0000-0000-000000000099';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C = '4f172140-f57a-4744-8050-95f4f07b13b4';
const STAKE_FREEDOM = 'f4746b48-9ccc-44b6-8967-2551ee0d53a6';
const STAKE_C1C = 'aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb';
const BILLING_ID = 'ca855dec-1631-44f1-bbfa-61c6f225954f';

const jwtEvent = (body, extra = {}) => ({
  rawPath: '/data/write',
  headers: {
    authorization: 'Bearer test-id-token',
    'x-user-id': SPOOF_ID,
    'x-tenant-id': C1C,
    'x-role': 'admin',
  },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/data/write' },
    authorizer: {
      jwt: {
        claims: {
          sub: extra.sub || COGNITO_SUB,
          email: 'checksops-tester@freedomadj.com',
          token_use: 'id',
        },
      },
    },
  },
});

const mapping = {
  application_user_id: APP_ID,
  cognito_sub: COGNITO_SUB,
  email: 'checksops-tester@freedomadj.com',
  status: 'active',
};

const authorizePayload = {
  tenant_id: FREEDOM,
  stakeholder_account_id: STAKE_FREEDOM,
  nickname: 'Operating',
  account_holder_name: 'Freedom Adj',
  account_type: 'checking',
  entity_type: 'business',
  verification_status: 'verified',
  account_number_last4: '0000',
  ach_authorized_at: '2026-09-14T02:00:00.000Z',
  auto_debit_enabled: true,
  ach_authorized_by: SPOOF_ID,
  routing_number: '021000021',
  account_number_encrypted: 'should-be-ignored',
};

const billingClient = ({ member = true, stakeTenant = FREEDOM, writeRows = [] } = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: params[0] === mapping.cognito_sub ? [mapping] : [] };
      }
      if (/FROM public.tenant_users/.test(sql)) {
        return { rows: member && params[1] === FREEDOM ? [{ '?column?': 1 }] : [] };
      }
      if (/FROM public.stakeholder_accounts/.test(sql)) {
        return { rows: params[0] === STAKE_FREEDOM && params[1] === stakeTenant ? [{ id: STAKE_FREEDOM }] : [] };
      }
      if (/aws_can_write_tenant/.test(sql)) {
        return { rows: [{ ok: false }] };
      }
      if (/INSERT INTO public.tenant_billing_accounts/.test(sql)) {
        return {
          rows: writeRows.length
            ? writeRows
            : [{ id: BILLING_ID, tenant_id: params[0], auto_debit_enabled: params[9], ach_authorized_by: null }],
        };
      }
      if (/SELECT id, tenant_id FROM public.tenant_billing_accounts/.test(sql)
        || /SELECT tenant_id FROM public.tenant_billing_accounts/.test(sql)) {
        if (params[0] === BILLING_ID || params[0] === FREEDOM) {
          return { rows: [{ id: BILLING_ID, tenant_id: FREEDOM }] };
        }
        return { rows: [] };
      }
      if (/UPDATE public.tenant_billing_accounts/.test(sql)) {
        return { rows: [{ id: BILLING_ID, tenant_id: FREEDOM, auto_debit_enabled: params[0] }] };
      }
      return { rows: writeRows };
    },
    end: async () => {},
  };
};

const depsFor = (client) => ({
  forceEnabled: true,
  forceWorkflow: true,
  loadDatabaseCredentials: async () => ({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    database: 'checksops',
  }),
  createClient: (config) => {
    client.lastConfig = config;
    return client;
  },
});

test('tenant_billing_accounts is a narrow allowed write table', () => {
  const spec = WRITE_ALLOWLIST.tenant_billing_accounts;
  assert.equal(denyTableReason('tenant_billing_accounts'), null);
  assert.equal(spec.tranche, 6);
  assert.equal(spec.ops.has('insert'), true);
  assert.equal(spec.ops.has('update'), true);
  assert.equal(spec.ops.has('delete'), false);
  assert.equal(spec.columns.has('tenant_id'), true);
  assert.equal(spec.columns.has('auto_debit_enabled'), true);
  assert.equal(spec.columns.has('ach_authorized_by'), false);
  assert.equal(spec.columns.has('routing_number'), false);
  assert.equal(spec.clientIgnored.has('ach_authorized_by'), true);
  assert.equal(WRITE_ALLOWLIST.tenants.columns.has('checkalt_enabled'), false);
  assert.equal(WRITE_ALLOWLIST.disbursement_batches, undefined);
  assert.equal(denyTableReason('disbursement_batches'), 'financial_or_provider');
  const picked = pickAllowlistedValues('tenant_billing_accounts', authorizePayload);
  assert.equal(picked.error, undefined);
  assert.equal(picked.values.ach_authorized_by, undefined);
  assert.equal(picked.values.routing_number, undefined);
  assert.equal(picked.values.account_number_encrypted, undefined);
  assert.equal(picked.values.auto_debit_enabled, true);
  assert.equal(picked.ignored.includes('ach_authorized_by'), true);
});

test('authorized tenant can insert and toggle own billing account', async () => {
  const client = billingClient();
  const inserted = await handleWrite(jwtEvent({
    table: 'tenant_billing_accounts',
    op: 'insert',
    values: authorizePayload,
  }), depsFor(client));
  assert.equal(inserted.ok, true);
  assert.equal(inserted.applicationUserId, APP_ID);
  const insert = client.queries.find((q) => String(q.sql).includes('INSERT INTO public.tenant_billing_accounts'));
  assert.ok(insert);
  assert.equal(insert.params[0], FREEDOM);
  assert.equal(insert.params[1], STAKE_FREEDOM);
  assert.equal(String(insert.sql).includes('ach_authorized_by'), false);
  assert.equal(insert.params.includes(SPOOF_ID), false);
  assert.equal(insert.params.includes(C1C), false);

  const toggled = await handleWrite(jwtEvent({
    table: 'tenant_billing_accounts',
    op: 'update',
    values: { auto_debit_enabled: false, ach_authorized_by: SPOOF_ID },
    filters: [{ column: 'tenant_id', op: 'eq', value: FREEDOM }],
  }), depsFor(client));
  assert.equal(toggled.ok, true);
  const update = client.queries.find((q) => String(q.sql).includes('UPDATE public.tenant_billing_accounts'));
  assert.ok(update);
  assert.equal(String(update.sql).includes('ach_authorized_by'), false);
});

test('cross-tenant billing writes remain denied and do not INSERT/UPDATE', async () => {
  const client = billingClient({ member: false });
  const insertOther = await handleWrite(jwtEvent({
    table: 'tenant_billing_accounts',
    op: 'insert',
    values: { ...authorizePayload, tenant_id: C1C, stakeholder_account_id: STAKE_C1C },
  }), depsFor(client));
  assert.equal(insertOther.ok, false);
  assert.equal(insertOther.statusCode, 403);
  assert.equal(insertOther.error, 'not_authorized');
  assert.equal(client.queries.some((q) => String(q.sql).includes('INSERT INTO public.tenant_billing_accounts')), false);

  const executor = await executeAppMetadataWrite({
    client: billingClient({ member: true }),
    mapping,
    table: 'tenant_billing_accounts',
    op: 'insert',
    values: { ...authorizePayload, tenant_id: FREEDOM, stakeholder_account_id: STAKE_C1C },
    filters: [],
  });
  assert.equal(executor.error, 'not_authorized');

  const updateOther = await executeAppMetadataWrite({
    client: billingClient({ member: false }),
    mapping,
    table: 'tenant_billing_accounts',
    op: 'update',
    values: { auto_debit_enabled: false },
    filters: [{ column: 'tenant_id', op: 'eq', value: C1C }],
  });
  assert.equal(updateOther.error, 'not_authorized');
});

test('unrelated tables and SPA writes_disabled guard stay unchanged except this table', () => {
  const clientSrc = fs.readFileSync(path.join(REPO, 'src/integrations/aws/client.ts'), 'utf8');
  const panel = fs.readFileSync(
    path.join(REPO, 'src/components/settings/TenantBillingAccountPanel.tsx'),
    'utf8',
  );
  const match = clientSrc.match(/const AWS_WRITE_TABLES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(match);
  const tables = [...match[1].matchAll(/"([^"]+)"/g)].map((row) => row[1]);
  assert.equal(tables.includes('tenant_billing_accounts'), true);
  assert.equal(tables.includes('disbursement_batches'), false);
  assert.equal(tables.includes('auth.users'), false);
  assert.match(clientSrc, /if \(!AWS_WRITE_TABLES\.has\(state\.table\)\)/);
  assert.match(clientSrc, /postgrestError\("writes_disabled", "42501"/);
  assert.equal(/ach_authorized_by/.test(panel), false);
  assert.equal(WRITE_ALLOWLIST.tenant_users.columns.has('role'), true);
  assert.equal(WRITE_ALLOWLIST.check_message_reads.ops.has('upsert'), true);
});
