/**
 * Durable S14 Deposit Payee Line Protection safeguard.
 * Runs in the existing AWS API regression suite (`npm run test:aws-api`).
 * Failure messages always identify S14 Deposit Payee Line Protection.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as helper from '../functions/api/check-deposited.mjs';
import { persistOcrDescriptiveHandoff } from '../functions/api/ocr-descriptive-persist.mjs';
import {
  buildIngestPlan,
  guardIngestPlanPayeeLine,
  persistIngest,
  persistIngestInline,
} from '../functions/api/ingest-shared-check.mjs';
import { handleWrite } from '../functions/api/write.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import * as allowlist from '../functions/api/write-allowlist.mjs';
import {
  S14_LABEL,
  assertAllowlistKeepsPreDepositCorrection,
  assertConfirmedDepositContract,
  assertHelperInvariants,
  assertNoUnguardedExistingCheckWriter,
  assertWritersCallHelper,
  expectS14Failure,
  importMutatedHelper,
  importMutatedOcrPersist,
  mutateFailOpen,
  mutateOcrBypass,
  mutateRemoveConfirmedProvider,
  mutateRemoveDepositedAt,
  mutateStripWriterHelperCalls,
  readRepo,
  s14Assert,
} from './lib/s14-deposit-payee-line-safeguard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const CHECK_ID = '8d2b1c3e-4f5a-4678-9abc-def012345678';
const TENANT_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';

const jwtEvent = (body) => ({
  rawPath: '/data/write',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/data/write' },
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } } },
  },
});

const writeClient = ({
  deposited_at = null,
  payee_line = 'Original Payee Line',
  confirmedDeposit = false,
  throwOn = null,
  claimRow = null,
} = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (throwOn && String(sql).includes(throwOn)) {
        const error = new Error('synthetic write failure');
        error.code = '40001';
        throw error;
      }
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE'
        || /^SAVEPOINT /i.test(sql) || /^ROLLBACK TO SAVEPOINT /i.test(sql) || /^RELEASE SAVEPOINT /i.test(sql)) {
        return { rows: [] };
      }
      if (String(sql).startsWith('SELECT set_config')) return { rows: [{ set_config: params?.[1] || '1' }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return {
          rows: [{
            application_user_id: APP_ID,
            cognito_sub: COGNITO_SUB,
            email: 'checksops-tester@freedomadj.com',
            status: 'active',
          }],
        };
      }
      if (/FROM public.check_intake_items WHERE id = \$1::uuid/.test(sql)) {
        return { rows: [{ id: params[0], tenant_id: TENANT_ID, deposited_at, payee_line }] };
      }
      if (/SELECT deposited_at, payee_line/.test(sql)) {
        return { rows: [{ deposited_at, payee_line }] };
      }
      if (/FROM public.aws_financial_operations/.test(sql)) {
        return { rows: confirmedDeposit ? [{ ok: 1 }] : [] };
      }
      if (/FROM public.claim_checks/.test(sql)) {
        return {
          rows: [claimRow || {
            id: params[0],
            check_intake_item_id: CHECK_ID,
            tenant_id: TENANT_ID,
            payee_line,
          }],
        };
      }
      if (/SELECT .* FROM public\.tenants/.test(sql) || /FROM public.tenant_memberships/.test(sql)) {
        return { rows: [{ tenant_id: TENANT_ID, role: 'owner' }] };
      }
      return { rows: [{ id: CHECK_ID, payee_line }] };
    },
  };
};

const depsFor = (client) => ({
  forceEnabled: true,
  loadDatabaseCredentials: async () => ({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    database: 'checksops',
  }),
  createClient: () => client,
});

const persistClient = ({
  deposited_at = null,
  payee_line = 'Corrected Payee Line',
  confirmedDeposit = false,
} = {}) => {
  const store = { payee_line, carrier_name: null, deposited_at, confirmedDeposit };
  const statements = [];
  return {
    store,
    statements,
    query: async (sql, params = []) => {
      statements.push({ sql: String(sql), params: [...params] });
      if (/SAVEPOINT |RELEASE SAVEPOINT |ROLLBACK TO SAVEPOINT /.test(sql)) return { rows: [] };
      if (/SELECT deposited_at, payee_line/.test(sql)) {
        return { rows: [{ deposited_at: store.deposited_at, payee_line: store.payee_line }] };
      }
      if (/FROM public.aws_financial_operations/.test(sql)) {
        return { rows: store.confirmedDeposit ? [{ ok: 1 }] : [] };
      }
      if (/UPDATE public\.check_intake_items/.test(sql) && /payee_line = COALESCE/.test(sql)) {
        if (params[1] != null) store.carrier_name = params[1];
        if (params[2] != null) store.payee_line = params[2];
        return { rows: [{ id: CHECK_ID, payee_line: store.payee_line }] };
      }
      if (/FROM public\.check_payees/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
};

test(`${S14_LABEL}: accepted helper invariants hold`, async () => {
  assertConfirmedDepositContract();
  await assertHelperInvariants(helper);
});

test(`${S14_LABEL}: pre-deposit /data/write correction remains permitted`, async () => {
  const client = writeClient({ payee_line: 'Original Payee Line' });
  const result = await handleWrite(jwtEvent({
    table: 'check_intake_items',
    op: 'update',
    values: { payee_line: 'Corrected Payee Line' },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
    single: true,
  }), depsFor(client));
  s14Assert(result.ok === true, `pre-deposit write was denied: ${JSON.stringify(result)}`);
  s14Assert(
    client.queries.some((q) => String(q.sql).startsWith('UPDATE public.check_intake_items')),
    'pre-deposit correction did not reach UPDATE',
  );
});

test(`${S14_LABEL}: /data/write cannot bypass the post-deposit lock`, async () => {
  const stamped = writeClient({ deposited_at: '2026-09-25T00:00:00Z', payee_line: 'Corrected Payee Line' });
  const stampedResult = await handleWrite(jwtEvent({
    table: 'check_intake_items',
    op: 'update',
    values: { payee_line: 'Anything Else' },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(stamped));
  s14Assert(stampedResult.statusCode === 403 && stampedResult.error === 'payee_line_locked', 'deposited_at write was not locked');

  const confirmed = writeClient({ confirmedDeposit: true, payee_line: 'Corrected Payee Line' });
  const confirmedResult = await handleWrite(jwtEvent({
    table: 'check_intake_items',
    op: 'update',
    values: { payee_line: 'Anything Else' },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(confirmed));
  s14Assert(confirmedResult.statusCode === 403 && confirmedResult.reason === 'confirmed_provider_deposit', 'confirmed-deposit write was not locked');
  s14Assert(!confirmed.queries.some((q) => String(q.sql).startsWith('UPDATE public.check_intake_items')), 'locked write still mutated intake');
});

test(`${S14_LABEL}: same-value post-deposit /data/write is a no-op`, async () => {
  const client = writeClient({
    confirmedDeposit: true,
    payee_line: 'Corrected Payee Line',
  });
  const result = await handleWrite(jwtEvent({
    table: 'check_intake_items',
    op: 'update',
    values: { payee_line: 'Corrected Payee Line' },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
    single: true,
  }), depsFor(client));
  s14Assert(result.ok === true, `same-value no-op failed: ${JSON.stringify(result)}`);
  s14Assert(
    !client.queries.some((q) => String(q.sql).startsWith('UPDATE public.check_intake_items')),
    'same-value request performed an intake UPDATE',
  );
});

test(`${S14_LABEL}: claim_checks cannot bypass the lock`, async () => {
  const client = writeClient({
    confirmedDeposit: true,
    payee_line: 'Corrected Payee Line',
    claimRow: {
      id: '44444444-4444-4444-8444-444444444444',
      check_intake_item_id: CHECK_ID,
      tenant_id: TENANT_ID,
      payee_line: 'Corrected Payee Line',
    },
  });
  const result = await handleWrite(jwtEvent({
    table: 'claim_checks',
    op: 'update',
    values: { payee_line: 'Mirror Bypass' },
    filters: [{ column: 'id', op: 'eq', value: '44444444-4444-4444-8444-444444444444' }],
  }), depsFor(client));
  s14Assert(result.statusCode === 403 && result.error === 'payee_line_locked', 'claim_checks bypassed the lock');
  s14Assert(!client.queries.some((q) => String(q.sql).includes('UPDATE public.claim_checks')), 'claim_checks UPDATE still ran');
});

test(`${S14_LABEL}: persistOcrDescriptiveHandoff and OCR path cannot overwrite after deposit`, async () => {
  const client = persistClient({ confirmedDeposit: true, payee_line: 'Corrected Payee Line' });
  await persistOcrDescriptiveHandoff({
    client,
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: { carrier_name: 'Still Writable Carrier', payee_line: 'OCR Rewrite After Deposit' },
  });
  s14Assert(client.store.payee_line === 'Corrected Payee Line', 'OCR persist overwrote post-deposit payee_line');
  s14Assert(client.store.carrier_name === 'Still Writable Carrier', 'OCR persist blocked a non-payee descriptive field');
});

test(`${S14_LABEL}: existing-row ingest cannot overwrite post-deposit payee_line`, async () => {
  const statements = [];
  const client = {
    query: async (sql, params = []) => {
      statements.push({ sql: String(sql), params });
      if (/external_origin->>'source_check_id'/.test(sql) || /SELECT id, payee_line FROM public.check_intake_items/.test(sql)) {
        return { rows: [{ id: CHECK_ID, payee_line: 'Corrected Payee Line' }] };
      }
      if (/SELECT deposited_at, payee_line/.test(sql)) {
        return { rows: [{ deposited_at: null, payee_line: 'Corrected Payee Line' }] };
      }
      if (/FROM public.aws_financial_operations/.test(sql)) return { rows: [{ ok: 1 }] };
      if (/aws_ingest_shared_check/.test(sql)) return { rows: [{ doc: { ok: true, check_id: CHECK_ID } }] };
      return { rows: [] };
    },
  };
  const plan = buildIngestPlan({
    source_check_id: '11111111-1111-4111-8111-111111111111',
    target_partner_code: 'abc',
    source_tenant_id: '22222222-2222-4222-8222-222222222222',
    source_partner_code: 'DF9CC985',
    check: { amount: 10, payee_line: 'Ingest Rewrite After Deposit', carrier_name: 'Still Ok' },
  });
  const guarded = await guardIngestPlanPayeeLine(client, plan);
  s14Assert(guarded.check.payee_line === undefined, 'guardIngestPlanPayeeLine left locked payee_line in the plan');
  const persisted = await persistIngest(client, plan);
  const sqlCall = statements.find((row) => /aws_ingest_shared_check/.test(row.sql));
  s14Assert(sqlCall, 'persistIngest did not call the ingest SQL');
  s14Assert(JSON.parse(sqlCall.params[0]).check.payee_line === undefined, 'persistIngest forwarded locked payee_line');
  s14Assert(persisted.check_id === CHECK_ID, 'persistIngest did not return the existing check');

  const inlineStatements = [];
  const inlineClient = {
    query: async (sql, params = []) => {
      inlineStatements.push({ sql: String(sql), params });
      if (/lookup_tenant_by_partner_code/.test(sql)) return { rows: [{ id: TENANT_ID }] };
      if (/external_origin->>'source_check_id'/.test(sql)) {
        return { rows: [{ id: CHECK_ID, payee_line: 'Corrected Payee Line' }] };
      }
      if (/SELECT deposited_at, payee_line/.test(sql)) {
        return { rows: [{ deposited_at: null, payee_line: 'Corrected Payee Line' }] };
      }
      if (/FROM public.aws_financial_operations/.test(sql)) return { rows: [{ ok: 1 }] };
      return { rows: [] };
    },
  };
  await persistIngestInline(inlineClient, buildIngestPlan({
    source_check_id: '11111111-1111-4111-8111-111111111111',
    target_partner_code: 'abc',
    source_tenant_id: '22222222-2222-4222-8222-222222222222',
    source_partner_code: 'DF9CC985',
    check: { amount: 10, payee_line: 'Ingest Rewrite After Deposit', carrier_name: 'Still Ok' },
  }));
  const update = inlineStatements.find((row) => /UPDATE public.check_intake_items SET/.test(row.sql));
  s14Assert(update, 'existing-row ingest did not UPDATE the row');
  s14Assert(!/payee_line =/.test(update.sql), 'existing-row ingest still wrote payee_line');
});

test(`${S14_LABEL}: payee_line stays off INTAKE_PROHIBITED_COLUMNS`, () => {
  assertAllowlistKeepsPreDepositCorrection(allowlist);
});

test(`${S14_LABEL}: every accepted writer still calls the shared helper`, () => {
  assertWritersCallHelper(ROOT);
  assertNoUnguardedExistingCheckWriter(ROOT);
});

test(`${S14_LABEL}: lookup failure fails closed on /data/write`, async () => {
  const client = writeClient({ payee_line: 'Corrected Payee Line', throwOn: 'aws_financial_operations' });
  const result = await handleWrite(jwtEvent({
    table: 'check_intake_items',
    op: 'update',
    values: { payee_line: 'Anything Else' },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(client));
  s14Assert(result.statusCode === 403 && result.error === 'payee_line_locked', 'fail-open write was accepted');
});

test(`${S14_LABEL}: mutation removing confirmed-provider detection is rejected`, async () => {
  const mutated = await importMutatedHelper(ROOT, mutateRemoveConfirmedProvider);
  await expectS14Failure('confirmed-provider-deposit detection removed', () => assertHelperInvariants(mutated));
});

test(`${S14_LABEL}: mutation making lookup fail-open is rejected`, async () => {
  const mutated = await importMutatedHelper(ROOT, mutateFailOpen);
  await expectS14Failure('deposited-state lookup became fail-open', () => assertHelperInvariants(mutated));
});

test(`${S14_LABEL}: mutation removing deposited_at detection is rejected`, async () => {
  const mutated = await importMutatedHelper(ROOT, mutateRemoveDepositedAt);
  await expectS14Failure('deposited_at check removed', () => assertHelperInvariants(mutated));
});

test(`${S14_LABEL}: mutation deleting the helper is rejected`, async () => {
  await expectS14Failure('helper deletion', () => assertHelperInvariants({}));
});

test(`${S14_LABEL}: mutation stripping writer helper calls is rejected`, async () => {
  const original = {
    readFileSync: (filePath, encoding) => {
      const rel = path.relative(ROOT, filePath).replaceAll('\\', '/');
      if (rel === 'aws/functions/api/write-check-workflow.mjs') {
        return mutateStripWriterHelperCalls(readRepo(ROOT, rel));
      }
      if (rel === 'aws/functions/api/ocr.mjs') {
        return mutateStripWriterHelperCalls(readRepo(ROOT, rel));
      }
      if (rel === 'aws/functions/api/ocr-descriptive-persist.mjs') {
        return mutateStripWriterHelperCalls(readRepo(ROOT, rel));
      }
      if (rel === 'aws/functions/api/ingest-shared-check.mjs') {
        return mutateStripWriterHelperCalls(readRepo(ROOT, rel));
      }
      return readRepo(ROOT, rel);
    },
  };
  await expectS14Failure('writer stopped calling helper', () => {
    for (const writer of [
      'aws/functions/api/write-check-workflow.mjs',
      'aws/functions/api/ocr.mjs',
      'aws/functions/api/ocr-descriptive-persist.mjs',
      'aws/functions/api/ingest-shared-check.mjs',
    ]) {
      const source = original.readFileSync(path.join(ROOT, writer), 'utf8');
      s14Assert(
        source.includes("from './check-deposited.mjs'") && /rejectPayeeLineIfDeposited|resolveWritablePayeeLine/.test(source),
        `${writer} no longer calls the S14 helper`,
      );
    }
  });
});

test(`${S14_LABEL}: mutation letting OCR persist overwrite after deposit is rejected`, async () => {
  const mutated = await importMutatedOcrPersist(ROOT, mutateOcrBypass);
  const client = persistClient({ confirmedDeposit: true, payee_line: 'Corrected Payee Line' });
  await mutated.persistOcrDescriptiveHandoff({
    client,
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: { carrier_name: 'Still Writable Carrier', payee_line: 'OCR Rewrite After Deposit' },
  });
  await expectS14Failure('OCR bypassed the lock', () => {
    s14Assert(
      client.store.payee_line === 'Corrected Payee Line',
      'OCR persist overwrote post-deposit payee_line',
    );
  });
});
