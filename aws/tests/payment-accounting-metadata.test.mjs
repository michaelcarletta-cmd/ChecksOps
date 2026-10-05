import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { handlePaymentAccounting, parseAggregateKey, ALLOWED_DISPLAY_TYPES } from '../functions/api/payment-accounting.mjs';
import { CLASS_A_FUNCTIONS, handleAppServiceRequest } from '../functions/api/app-services.mjs';
import { classifyFunction, FUNCTION_BY_NAME } from '../functions/api/providers/catalog.mjs';
import { handleWrite } from '../functions/api/write.mjs';
import { denyTableReason, WRITE_ALLOWLIST, FINANCIAL_OR_PROVIDER_TABLES } from '../functions/api/write-allowlist.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const TENANT_A = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const TENANT_B = '4f172140-f57a-4744-8050-95f4f07b13b4';
const ACCT_ID = '11111111-1111-4111-8111-111111111111';
const SPLIT_EXT = '22222222-2222-4222-8222-222222222222';
const SPLIT_TENANT = '33333333-3333-4333-8333-333333333333';

const mappingFor = () => ({
  application_user_id: APP_ID,
  cognito_sub: COGNITO_SUB,
  email: 'checksops-tester@freedomadj.com',
  status: 'active',
});

const jwtEvent = (pathName, method, body) => ({
  rawPath: pathName,
  headers: { authorization: 'Bearer test-id-token' },
  body: body ? JSON.stringify(body) : undefined,
  requestContext: {
    stage: 'staging',
    http: { method, path: pathName },
    requestId: 'req-payment-accounting-test',
    authorizer: {
      jwt: {
        claims: {
          sub: COGNITO_SUB,
          email: 'checksops-tester@freedomadj.com',
          token_use: 'id',
        },
      },
    },
  },
});

const sourceOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const mockClient = ({
  memberships = [{ tenant_id: TENANT_A, role: 'admin' }],
  canWrite = [TENANT_A],
  canAccess = null,
  platformOwner = false,
  platformAdmin = false,
  overlayMissing = false,
  overlayRows = [],
  stakeholder = {
    id: ACCT_ID,
    tenant_id: TENANT_A,
    nickname: 'Jean Lindner',
    account_type: 'contractor',
  },
  extSplits = [{
    id: SPLIT_EXT,
    recipient_name: 'External Vendor',
    recipient_type: 'vendor',
  }],
  splitRow = {
    id: SPLIT_EXT,
    tenant_id: TENANT_A,
    recipient_type: 'vendor',
    recipient_tenant_id: null,
    stakeholder_account_id: null,
  },
} = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: params[0] === COGNITO_SUB ? [mappingFor()] : [] };
      }
      if (/is_platform_owner\(\)/.test(sql)) {
        return { rows: [{ is_owner: platformOwner, is_master: platformOwner }] };
      }
      if (/FROM public\.user_roles/.test(sql)) {
        return { rows: platformAdmin ? [{ role: 'admin' }] : [] };
      }
      if (/FROM public\.tenant_users tu/.test(sql)) {
        return { rows: memberships };
      }
      if (/aws_can_write_tenant/.test(sql)) {
        return { rows: [{ ok: canWrite.includes(String(params[0])) }] };
      }
      if (/aws_can_access_tenant/.test(sql)) {
        const allowed = Array.isArray(canAccess) ? canAccess : canWrite;
        return { rows: [{ ok: allowed.includes(String(params[0])) }] };
      }
      if (/FROM public\.stakeholder_accounts/.test(sql) && /SELECT/.test(sql)) {
        return { rows: stakeholder && String(params[0]) === stakeholder.id ? [stakeholder] : [] };
      }
      if (/UPDATE public\.stakeholder_accounts/.test(sql)) {
        return {
          rows: [{
            id: stakeholder.id,
            nickname: params[0],
            account_type: params[1],
          }],
        };
      }
      if (/FROM public\.disbursement_splits/.test(sql) && /lower\(btrim/.test(sql)) {
        return { rows: extSplits };
      }
      if (/FROM public\.disbursement_splits/.test(sql) && /WHERE id = \$1/.test(sql)) {
        return { rows: splitRow && String(params[0]) === splitRow.id ? [splitRow] : [] };
      }
      if (/UPDATE public\.disbursement_splits/.test(sql) && /recipient_name/.test(sql)) {
        return {
          rows: extSplits.map((row) => ({
            id: row.id,
            recipient_name: params[0],
            recipient_type: params[1],
          })),
        };
      }
      if (/UPDATE public\.disbursement_splits/.test(sql) && /recipient_type = \$1/.test(sql)) {
        return { rows: [{ id: splitRow.id, recipient_type: params[0] }] };
      }
      if (/FROM public\.tenant_payment_recipient_overrides/.test(sql) && /SELECT/.test(sql)) {
        if (overlayMissing) {
          const error = new Error('relation "tenant_payment_recipient_overrides" does not exist');
          error.code = '42P01';
          throw error;
        }
        return {
          rows: overlayRows.filter((row) => String(row.tenant_id) === String(params[0])),
        };
      }
      if (/INSERT INTO public\.tenant_payment_recipient_overrides/.test(sql)) {
        if (overlayMissing) {
          const error = new Error('relation "tenant_payment_recipient_overrides" does not exist');
          error.code = '42P01';
          throw error;
        }
        return {
          rows: [{
            tenant_id: params[0],
            aggregate_key: params[1],
            display_name: params[2],
            display_type: params[3],
          }],
        };
      }
      if (/INSERT INTO public\.audit_logs/.test(sql)) {
        return { rows: [{ id: 'audit-1' }] };
      }
      return { rows: [] };
    },
    end: async () => {},
  };
};

const depsFor = (client) => ({
  loadDatabaseCredentials: async () => ({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    database: 'checksops',
  }),
  createClient: () => client,
  forceEnabled: true,
});

const invoke = (body, client = mockClient()) => handlePaymentAccounting(
  jwtEvent('/functions/v1/tenant-payment-accounting', 'POST', body),
  depsFor(client),
).then((result) => ({ result, client }));

test('parseAggregateKey accepts tenant/acct/ext and rejects junk', () => {
  assert.equal(parseAggregateKey(`acct:${ACCT_ID}`).kind, 'acct');
  assert.equal(parseAggregateKey(`tenant:${TENANT_B}`).kind, 'tenant');
  assert.deepEqual(parseAggregateKey('ext:vendor|external vendor'), {
    kind: 'ext',
    type: 'vendor',
    name: 'external vendor',
    key: 'ext:vendor|external vendor',
  });
  assert.equal(parseAggregateKey('ext:not-a-type|x').error, 'invalid_display_type');
  assert.equal(parseAggregateKey('row:other|unknown').error, 'invalid_aggregate_key');
  assert.ok(ALLOWED_DISPLAY_TYPES.has('subcontractor'));
});

test('Class A registry owns the contract and providers do not', () => {
  assert.equal(CLASS_A_FUNCTIONS.has('tenant-payment-accounting'), true);
  assert.equal(classifyFunction('tenant-payment-accounting'), null);
  assert.equal('tenant-payment-accounting' in FUNCTION_BY_NAME, false);
  assert.equal(CLASS_A_FUNCTIONS.has('moov-disburse'), false);
  assert.equal(CLASS_A_FUNCTIONS.has('moov-invoice'), false);
});

test('app-services source routes Class A payment accounting before providers', () => {
  const src = sourceOf('aws/functions/api/app-services.mjs');
  assert.match(src, /handlePaymentAccounting/);
  assert.match(src, /case 'tenant-payment-accounting'/);
  assert.equal(typeof handleAppServiceRequest, 'function');
});

test('acct: display edit persists nickname and account_type only', async () => {
  const { result, client } = await invoke({
    action: 'update_recipient_display',
    tenant_id: TENANT_A,
    aggregate_key: `acct:${ACCT_ID}`,
    display_name: 'Jean L.',
    display_type: 'subcontractor',
  });
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'acct');
  assert.equal(result.updated_count, 1);
  const update = client.queries.find((q) => /UPDATE public\.stakeholder_accounts/.test(q.sql));
  assert.ok(update);
  assert.match(update.sql, /SET\s+nickname = \$1,\s+account_type = \$2/s);
  assert.equal(update.params[0], 'Jean L.');
  assert.equal(update.params[1], 'subcontractor');
  assert.doesNotMatch(update.sql, /chk_acct|routing_number|consumer_unique|custname|recipient_tenant_id|amount|moov_/);
  assert.equal(client.queries.some((q) => /INSERT INTO public\.disbursement_splits/.test(q.sql)), false);
});

test('ext: display edit persists recipient_name/type on resolved outgoing splits only', async () => {
  const { result, client } = await invoke({
    action: 'update_recipient_display',
    tenant_id: TENANT_A,
    aggregate_key: 'ext:vendor|external vendor',
    display_name: 'Ext Co',
    display_type: 'supplier',
  });
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'ext');
  assert.equal(result.updated_count, 1);
  const select = client.queries.find((q) => /FROM public\.disbursement_splits/.test(q.sql) && /recipient_tenant_id IS NULL/.test(q.sql));
  assert.ok(select);
  const update = client.queries.find((q) => /UPDATE public\.disbursement_splits/.test(q.sql));
  assert.ok(update);
  assert.match(update.sql, /recipient_name = \$1/);
  assert.match(update.sql, /recipient_type = \$2/);
  assert.match(update.sql, /recipient_tenant_id IS NULL/);
  assert.match(update.sql, /stakeholder_account_id IS NULL/);
  assert.doesNotMatch(update.sql, /amount|status|moov_transfer_id|recipient_tenant_id =/);
  assert.equal(client.queries.some((q) => /INSERT INTO public\.disbursement_splits/.test(q.sql)), false);
});

test('tenant: overlay does not rewrite tenant identity; missing table fails closed', async () => {
  const present = await invoke({
    action: 'update_recipient_display',
    tenant_id: TENANT_A,
    aggregate_key: `tenant:${TENANT_B}`,
    display_name: 'Partner Co',
    display_type: 'contractor',
  });
  assert.equal(present.result.ok, true);
  assert.equal(present.result.kind, 'tenant');
  assert.equal(present.result.overlay, true);
  assert.equal(present.client.queries.some((q) => /UPDATE public\.tenants/.test(q.sql)), false);
  assert.equal(present.client.queries.some((q) => /recipient_tenant_id/.test(q.sql) && /UPDATE/.test(q.sql)), false);
  assert.equal(present.client.queries.some((q) => /destination_tenant_id/.test(q.sql)), false);

  const missing = mockClient({ overlayMissing: true });
  const closed = await invoke({
    action: 'update_recipient_display',
    tenant_id: TENANT_A,
    aggregate_key: `tenant:${TENANT_B}`,
    display_name: 'Partner Co',
    display_type: 'contractor',
  }, missing);
  assert.equal(closed.result.ok, false);
  assert.equal(closed.result.statusCode, 409);
  assert.equal(closed.result.error, 'overlay_table_not_applied');
  assert.equal(missing.queries.some((q) => /UPDATE public\.disbursement_splits/.test(q.sql)), false);
  assert.equal(missing.queries.some((q) => /UPDATE public\.tenants/.test(q.sql)), false);
});

test('update_split_type uses durable split id and refuses tenant/stakeholder rows', async () => {
  const ok = await invoke({
    action: 'update_split_type',
    tenant_id: TENANT_A,
    split_id: SPLIT_EXT,
    display_type: 'supplier',
  });
  assert.equal(ok.result.ok, true);
  assert.equal(ok.result.split_id, SPLIT_EXT);
  const update = ok.client.queries.find((q) => /UPDATE public\.disbursement_splits/.test(q.sql));
  assert.match(update.sql, /recipient_type = \$1/);
  assert.equal(update.params[1], SPLIT_EXT);
  assert.doesNotMatch(update.sql, /amount|status|moov_|recipient_name/);

  const tenantDest = mockClient({
    splitRow: {
      id: SPLIT_TENANT,
      tenant_id: TENANT_A,
      recipient_type: 'contractor',
      recipient_tenant_id: TENANT_B,
      stakeholder_account_id: null,
    },
  });
  const refused = await invoke({
    action: 'update_split_type',
    tenant_id: TENANT_A,
    split_id: SPLIT_TENANT,
    display_type: 'vendor',
  }, tenantDest);
  assert.equal(refused.result.statusCode, 409);
  assert.equal(refused.result.error, 'durable_tenant_destination');
  assert.equal(tenantDest.queries.some((q) => /UPDATE public\.disbursement_splits/.test(q.sql)), false);

  const stakeholderLinked = mockClient({
    splitRow: {
      id: SPLIT_EXT,
      tenant_id: TENANT_A,
      recipient_type: 'contractor',
      recipient_tenant_id: null,
      stakeholder_account_id: ACCT_ID,
    },
  });
  const stakeholderRefused = await invoke({
    action: 'update_split_type',
    tenant_id: TENANT_A,
    split_id: SPLIT_EXT,
    display_type: 'vendor',
  }, stakeholderLinked);
  assert.equal(stakeholderRefused.result.statusCode, 409);
  assert.equal(stakeholderRefused.result.error, 'stakeholder_identity');
  assert.equal(stakeholderLinked.queries.some((q) => /UPDATE public\.disbursement_splits/.test(q.sql)), false);
});

test('cross-tenant modification is 403 and writes nothing', async () => {
  const client = mockClient({
    memberships: [{ tenant_id: TENANT_B, role: 'admin' }],
    canWrite: [TENANT_B],
  });
  const { result } = await invoke({
    action: 'update_recipient_display',
    tenant_id: TENANT_A,
    aggregate_key: `acct:${ACCT_ID}`,
    display_name: 'Nope',
    display_type: 'vendor',
  }, client);
  assert.equal(result.statusCode, 403);
  assert.equal(result.code, 'cross_tenant_denied');
  assert.equal(client.queries.some((q) => /UPDATE /.test(q.sql)), false);
  assert.equal(client.queries.some((q) => /INSERT INTO public\.audit_logs/.test(q.sql)), false);
});

test('amount, status, provider id, and destination fields are rejected', async () => {
  for (const extra of [
    { amount: 1 },
    { status: 'failed' },
    { moov_transfer_id: 'moov-x' },
    { destination_tenant_id: TENANT_B },
    { recipient_tenant_id: TENANT_B },
  ]) {
    const { result, client } = await invoke({
      action: 'update_recipient_display',
      tenant_id: TENANT_A,
      aggregate_key: `acct:${ACCT_ID}`,
      display_name: 'Jean',
      display_type: 'vendor',
      ...extra,
    });
    assert.equal(result.statusCode, 400, JSON.stringify(extra));
    assert.equal(result.error, 'field_not_allowed');
    assert.equal(client.queries.some((q) => /UPDATE /.test(q.sql)), false);
  }
});

test('generic /data/write against disbursement_splits remains denied', async () => {
  const client = mockClient();
  const result = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'disbursement_splits',
    op: 'update',
    values: { recipient_type: 'vendor' },
  }), depsFor(client));
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'table_not_allowlisted');
  assert.equal(result.reason, 'financial_or_provider');
  assert.equal(denyTableReason('disbursement_splits'), 'financial_or_provider');
  assert.equal(denyTableReason('stakeholder_accounts'), 'unknown_table');
  assert.equal('disbursement_splits' in WRITE_ALLOWLIST, false);
  assert.equal('stakeholder_accounts' in WRITE_ALLOWLIST, false);
  assert.equal('tenant_payment_recipient_overrides' in WRITE_ALLOWLIST, false);
  assert.equal(FINANCIAL_OR_PROVIDER_TABLES.has('disbursement_splits'), true);
  assert.doesNotMatch(sourceOf('src/integrations/aws/client.ts'), /disbursement_splits/);
  assert.doesNotMatch(sourceOf('src/integrations/aws/client.ts'), /stakeholder_accounts/);
  assert.doesNotMatch(sourceOf('src/integrations/aws/client.ts'), /tenant_payment_recipient_overrides/);
});

test('handler has no Moov/provider/money path', () => {
  const src = sourceOf('aws/functions/api/payment-accounting.mjs');
  assert.doesNotMatch(src, /moovFetch|api\.moov\.io|handleProviderRequest|providerSandbox|moov-disburse|moov-invoice/);
  assert.match(src, /moov_transfer_id/);
  const frontend = [
    sourceOf('src/components/ledger/RecipientReport.tsx'),
    sourceOf('src/components/ledger/PaymentLedger.tsx'),
    sourceOf('src/lib/payments/paymentAccounting.ts'),
  ].join('\n');
  assert.doesNotMatch(frontend, /\.from\(["']disbursement_splits["']\)[\s\S]{0,80}\.update/);
  assert.match(frontend, /updateRecipientDisplay|updateSplitType|listRecipientOverlays/);
  assert.doesNotMatch(sourceOf('aws/functions/api/allowed-tables.json'), /tenant_payment_recipient_overrides/);
  assert.match(sourceOf('src/lib/payments/tenantPaymentAccuracyQueries.ts'), /listRecipientOverlays/);
});

test('audit entry is generated without secrets', async () => {
  const { client } = await invoke({
    action: 'update_recipient_display',
    tenant_id: TENANT_A,
    aggregate_key: `acct:${ACCT_ID}`,
    display_name: 'Jean Lindner',
    display_type: 'subcontractor',
  });
  const audit = client.queries.find((q) => /INSERT INTO public\.audit_logs/.test(q.sql));
  assert.ok(audit);
  assert.equal(audit.params[1], 'payment_recipient_display_update');
  const blob = JSON.stringify(audit.params);
  assert.doesNotMatch(blob, /tin|routing|chk_acct|consumer_unique|moov_secret/i);
});

test('list_recipient_overlays returns payer overlay and refuses cross-tenant read', async () => {
  const overlay = {
    tenant_id: TENANT_A,
    aggregate_key: `tenant:${TENANT_B}`,
    display_name: 'Condition 1 Commercial',
    display_type: 'contractor',
  };
  const owner = mockClient({ overlayRows: [overlay] });
  const listed = await invoke({
    action: 'list_recipient_overlays',
    tenant_id: TENANT_A,
  }, owner);
  assert.equal(listed.result.ok, true);
  assert.deepEqual(listed.result.overlays, [overlay]);
  const select = owner.queries.find((q) => /FROM public\.tenant_payment_recipient_overrides/.test(q.sql));
  assert.ok(select);
  assert.equal(select.params[0], TENANT_A);
  assert.equal(owner.queries.some((q) => /UPDATE /.test(q.sql)), false);
  assert.equal(owner.queries.some((q) => /INSERT INTO public\.tenant_payment_recipient_overrides/.test(q.sql)), false);

  const stranger = mockClient({
    memberships: [{ tenant_id: TENANT_B, role: 'admin' }],
    canWrite: [TENANT_B],
    canAccess: [TENANT_B],
    overlayRows: [overlay],
  });
  const denied = await invoke({
    action: 'list_recipient_overlays',
    tenant_id: TENANT_A,
  }, stranger);
  assert.equal(denied.result.statusCode, 403);
  assert.equal(denied.result.code, 'cross_tenant_denied');
  assert.equal(stranger.queries.some((q) => /FROM public\.tenant_payment_recipient_overrides/.test(q.sql)), false);
});

test('list_recipient_overlays fails open when the overlay table is absent', async () => {
  const missing = mockClient({ overlayMissing: true });
  const { result } = await invoke({
    action: 'list_recipient_overlays',
    tenant_id: TENANT_A,
  }, missing);
  assert.equal(result.ok, true);
  assert.deepEqual(result.overlays, []);
  assert.equal(result.overlay_table_not_applied, true);
});

test('client-supplied tenant_id is a selector only after membership is proven', async () => {
  const client = mockClient({
    memberships: [{ tenant_id: TENANT_A, role: 'member' }],
    canWrite: [TENANT_A],
  });
  const ok = await invoke({
    action: 'update_recipient_display',
    tenant_id: TENANT_A,
    aggregate_key: `acct:${ACCT_ID}`,
    display_name: 'Jean',
    display_type: 'vendor',
  }, client);
  assert.equal(ok.result.ok, true);
  assert.equal(ok.result.access, 'tenant_member');
});
