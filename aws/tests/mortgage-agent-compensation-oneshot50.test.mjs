import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FUNCTION_NAME,
  FORBIDDEN_FUNCTIONS,
  PINNED_SQL50_DOC_SHA256,
  PINNED_TEMP_TRIGGER_SHA256,
  PINNED_RESTORE_TRIGGER_SHA256,
  APPLY_CONFIRM,
  KNOWN_ROOT_IDS,
  ALLOWED_REQUESTS,
  EXCLUDE_REASON,
  EXCLUSIONS_INSERT_SQL,
  EXCLUDE_UPDATE_SQL,
  readEmbeddedSql,
  refuseEvent,
  handleEvent,
  sha256,
  classifyFamily,
  monthlyFromRows,
  summarizeCleanup,
  triggerPreservesPaidImmutability,
  SYNTHETIC_TENANT_ID,
} from '../isolated/mortgage-agent-compensation/oneshot50/index.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL_DIR = path.join(ROOT, 'isolated/mortgage-agent-compensation/sql');
const SQL_DOC = fs.readFileSync(path.join(SQL_DIR, '50_exclude_mortgage_agent_compensation.sql'), 'utf8');
const SQL_TEMP = fs.readFileSync(path.join(SQL_DIR, '50_temp_allowlist_trigger.sql'), 'utf8');
const SQL_RESTORE = fs.readFileSync(path.join(SQL_DIR, '50_restore_sql47_trigger.sql'), 'utf8');
const SQL47 = fs.readFileSync(path.join(SQL_DIR, '47_mortgage_agent_compensation.sql'), 'utf8');
const PANEL = fs.readFileSync(path.join(ROOT, '..', 'src/components/admin/MortgageAgentsPanel.tsx'), 'utf8');
const API = fs.readFileSync(path.join(ROOT, 'functions/api/mortgage-agent-compensation.mjs'), 'utf8');

const family = [
  {
    id: '50509ac0-f3c3-4051-acf6-69fc9988be74',
    parent_entry_id: null,
    agent_user_id: 'b100f05d-9e81-4a7b-b9cc-9baf173131d9',
    mortgage_request_id: 'a47cad99-0000-4000-8000-000000000021',
    check_intake_item_id: 'a47cad99-0000-4000-8000-000000000011',
    tenant_id: SYNTHETIC_TENANT_ID,
    classification: 'initial',
    amount_cents: 1000,
    status: 'paid',
    payment_reference: 'MACOMP-STAGING-15',
    pay_period: '2026-10',
  },
  {
    id: '60745413-ce5e-4c65-8992-b0fd401bfa42',
    parent_entry_id: null,
    agent_user_id: 'b100f05d-9e81-4a7b-b9cc-9baf173131d9',
    mortgage_request_id: 'a47cad99-0000-4000-8000-000000000022',
    check_intake_item_id: 'a47cad99-0000-4000-8000-000000000012',
    tenant_id: SYNTHETIC_TENANT_ID,
    classification: 'additional',
    amount_cents: 500,
    status: 'paid',
    payment_reference: 'MACOMP-STAGING-15',
    pay_period: '2026-10',
  },
  {
    id: '144e5657-f0c9-4fab-9bb8-eea28ad41136',
    parent_entry_id: null,
    agent_user_id: '4584ac20-2703-4a2f-835e-7bd574aa5376',
    mortgage_request_id: 'a48cad99-0000-4000-8000-000000000021',
    check_intake_item_id: 'a48cad99-0000-4000-8000-000000000011',
    tenant_id: SYNTHETIC_TENANT_ID,
    classification: 'initial',
    amount_cents: 1000,
    status: 'paid',
    payment_reference: 'MACOMP48',
    pay_period: '2026-10',
  },
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000024',
    parent_entry_id: null,
    agent_user_id: '4584ac20-2703-4a2f-835e-7bd574aa5376',
    mortgage_request_id: 'a48cad99-0000-4000-8000-000000000024',
    check_intake_item_id: 'a48cad99-0000-4000-8000-000000000013',
    tenant_id: SYNTHETIC_TENANT_ID,
    classification: 'additional',
    amount_cents: 500,
    status: 'earned',
    payment_reference: null,
    pay_period: '2026-10',
  },
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000101',
    parent_entry_id: '144e5657-f0c9-4fab-9bb8-eea28ad41136',
    agent_user_id: '4584ac20-2703-4a2f-835e-7bd574aa5376',
    mortgage_request_id: 'a48cad99-0000-4000-8000-000000000021',
    check_intake_item_id: 'a48cad99-0000-4000-8000-000000000011',
    tenant_id: SYNTHETIC_TENANT_ID,
    classification: 'initial',
    amount_cents: 250,
    status: 'earned',
    pay_period: '2026-10',
  },
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000102',
    parent_entry_id: '144e5657-f0c9-4fab-9bb8-eea28ad41136',
    agent_user_id: '4584ac20-2703-4a2f-835e-7bd574aa5376',
    mortgage_request_id: 'a48cad99-0000-4000-8000-000000000021',
    check_intake_item_id: 'a48cad99-0000-4000-8000-000000000011',
    tenant_id: SYNTHETIC_TENANT_ID,
    classification: 'initial',
    amount_cents: -100,
    status: 'earned',
    pay_period: '2026-10',
  },
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000103',
    parent_entry_id: '144e5657-f0c9-4fab-9bb8-eea28ad41136',
    agent_user_id: '4584ac20-2703-4a2f-835e-7bd574aa5376',
    mortgage_request_id: 'a48cad99-0000-4000-8000-000000000021',
    check_intake_item_id: 'a48cad99-0000-4000-8000-000000000011',
    tenant_id: SYNTHETIC_TENANT_ID,
    classification: 'initial',
    amount_cents: -1000,
    status: 'earned',
    pay_period: '2026-10',
  },
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000104',
    parent_entry_id: '144e5657-f0c9-4fab-9bb8-eea28ad41136',
    agent_user_id: 'b100f05d-9e81-4a7b-b9cc-9baf173131d9',
    mortgage_request_id: 'a48cad99-0000-4000-8000-000000000021',
    check_intake_item_id: 'a48cad99-0000-4000-8000-000000000011',
    tenant_id: SYNTHETIC_TENANT_ID,
    classification: 'initial',
    amount_cents: 1000,
    status: 'earned',
    pay_period: '2026-10',
  },
];

const SQL47_TRIGGER = `
CREATE OR REPLACE FUNCTION public.tg_protect_mortgage_agent_compensation_facts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'paid' AND NEW.status IS DISTINCT FROM 'paid' THEN
    RAISE EXCEPTION 'compensation_paid_immutable';
  END IF;
  RETURN NEW;
END;
$$;
`;

test('SQL 50 oneshot is inspect-default and refuses production, delete, and unconfirmed apply', () => {
  assert.equal(FUNCTION_NAME, 'checksops-staging-macomp50-oneshot');
  assert.equal(FORBIDDEN_FUNCTIONS.includes('checksops-staging-api'), true);
  assert.equal(FORBIDDEN_FUNCTIONS.includes('checksops-staging-guarded-sql-executor'), true);
  assert.equal(sha256(SQL_DOC), PINNED_SQL50_DOC_SHA256);
  assert.equal(sha256(SQL_TEMP), PINNED_TEMP_TRIGGER_SHA256);
  assert.equal(sha256(SQL_RESTORE), PINNED_RESTORE_TRIGGER_SHA256);
  assert.equal(readEmbeddedSql().ok, true);
  assert.equal(refuseEvent({ sql_text: 'DELETE FROM public.mortgage_agent_compensation_entries' }).ok, false);
  assert.equal(refuseEvent({ action: 'inspect' }, { RDS_HOST: 'checksops-production.example' }).ok, false);
  assert.equal(refuseEvent({ action: 'demo' }).ok, false);
  assert.equal(refuseEvent({ action: 'apply' }).ok, false);
  assert.equal(refuseEvent({ action: 'apply', confirm: APPLY_CONFIRM, function_name: FUNCTION_NAME }, {
    RDS_HOST: 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com',
  }), null);
});

test('SQL 50 is not a permanent paid→excluded|voided capability', () => {
  assert.match(SQL_DOC, /NOT a permanent catalog migration/);
  assert.doesNotMatch(SQL_DOC, /CREATE OR REPLACE FUNCTION public\.exclude_mortgage_agent_compensation/);
  assert.match(SQL_TEMP, /a47cad99-0000-4000-8000-000000000021/);
  assert.match(SQL_TEMP, /a2c0fbfe-e8c5-42dc-bc32-2c4edf8f2074/);
  assert.doesNotMatch(SQL_TEMP, /NEW\.status NOT IN \('voided', 'excluded'\)/);
  assert.match(SQL_RESTORE, /OLD\.status = 'paid' AND NEW\.status IS DISTINCT FROM 'paid'/);
  assert.doesNotMatch(SQL_RESTORE, /NEW\.status = 'excluded'/);
  assert.match(SQL47, /OLD\.status = 'paid' AND NEW\.status IS DISTINCT FROM 'paid'/);
  assert.equal(triggerPreservesPaidImmutability(SQL_RESTORE), true);
  assert.equal(triggerPreservesPaidImmutability(SQL_TEMP), false);
  assert.doesNotMatch(EXCLUDE_UPDATE_SQL, /payment_reference\s*=/);
  assert.doesNotMatch(EXCLUDE_UPDATE_SQL, /amount_cents\s*=/);
  assert.doesNotMatch(EXCLUDE_UPDATE_SQL, /paid_at\s*=/);
  for (const text of [SQL_DOC, SQL_TEMP, SQL_RESTORE, EXCLUDE_UPDATE_SQL]) {
    const executable = String(text).replace(/--.*$/gm, '');
    assert.doesNotMatch(text, /DELETE\s+FROM\s+public\.mortgage_agent_compensation_entries/i);
    assert.doesNotMatch(executable, /mortgage_handling_requests|check_billing_events/i);
    assert.doesNotMatch(executable, /\bmoov_|\bstripe_|\bach_|\bwallet\b/i);
  }
});

test('allowlist accepts only a47/a48 synthetic family and expected monthly fingerprint', () => {
  const classified = classifyFamily(family);
  assert.equal(classified.rejected.length, 0);
  assert.equal(classified.accepted.length, 8);
  const monthly = monthlyFromRows(family, '2026-10');
  assert.deepEqual(monthly, {
    initial_count: 2,
    additional_count: 2,
    files_worked: 4,
    adjustment_cents: 150,
    gross_owed_cents: 3150,
    paid_cents: 2500,
    balance_cents: 650,
  });
  const summary = summarizeCleanup(family, family, '2026-10');
  assert.equal(summary.safe, true);
  assert.deepEqual(summary.after_family, {
    initial_count: 0,
    additional_count: 0,
    files_worked: 0,
    adjustment_cents: 0,
    gross_owed_cents: 0,
    paid_cents: 0,
    balance_cents: 0,
  });
  assert.deepEqual(summary.after_period, summary.after_family);
  KNOWN_ROOT_IDS.forEach((id) => assert.equal(summary.entry_ids.includes(id), true));
});

test('allowlist rejects Freedom, GATE4, and other-tenant rows', () => {
  const rejected = classifyFamily([{
    ...family[0],
    id: 'ffffffff-0000-4000-8000-000000000099',
    mortgage_request_id: '5b20db20-13e1-4919-9528-06388d8661d2',
    tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
  }]);
  assert.equal(rejected.accepted.length, 0);
  assert.equal(rejected.rejected[0].reject_reasons.includes('forbidden_request'), true);
});

test('inspect does not exclude; confirmed apply uses allowlisted update and restores SQL 47 trigger', async () => {
  const calls = [];
  let triggerDef = SQL47_TRIGGER;
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      const text = String(sql);
      if (text.includes('FROM public.mortgage_agent_compensation_entries')) {
        return { rows: family };
      }
      if (text.includes('pg_get_functiondef')) {
        return { rows: [{ def: triggerDef }] };
      }
      if (text.includes('FROM public.user_roles')) {
        return { rows: [{ user_id: '233c588f-dc33-4307-8c3f-3da49c9fd2b3' }] };
      }
      if (text.includes("SET status = 'excluded'")) {
        return {
          rows: family.map((row) => ({
            id: row.id,
            status: 'excluded',
            payment_reference: row.payment_reference || null,
            paid_at: row.status === 'paid' ? '2026-10-03T17:00:46.472Z' : null,
            amount_cents: row.amount_cents,
          })),
        };
      }
      if (text.includes('CREATE OR REPLACE FUNCTION public.tg_protect_mortgage_agent_compensation_facts()')) {
        triggerDef = text;
        return { rows: [] };
      }
      return { rows: [] };
    },
    async end() {},
  };
  const env = {
    RDS_HOST: 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com',
    AWS_LAMBDA_FUNCTION_NAME: FUNCTION_NAME,
  };
  const inspect = await handleEvent({ action: 'inspect', function_name: FUNCTION_NAME }, env, { client });
  assert.equal(inspect.ok, true);
  assert.equal(inspect.details.executed, false);
  assert.equal(inspect.details.trigger_restored, true);
  assert.equal(calls.some((call) => String(call.sql).includes("SET status = 'excluded'")), false);
  assert.equal(calls.some((call) => String(call.sql).includes('mortgage_agent_compensation_exclusions')), false);

  const apply = await handleEvent({
    action: 'apply',
    confirm: APPLY_CONFIRM,
    function_name: FUNCTION_NAME,
    one_use_id: 'oneshot50-test-apply',
    expected_ids_fingerprint: inspect.details.ids_fingerprint,
  }, env, { client });
  assert.equal(apply.ok, true, apply.message);
  assert.equal(apply.details.executed, true);
  assert.equal(apply.details.excluded, family.length);
  assert.equal(apply.details.trigger_restored, true);
  assert.equal(apply.details.trigger_has_demo_allowlist, false);
  assert.equal(apply.details.payment_references_preserved[0].payment_reference, 'MACOMP-STAGING-15');
  const updateCall = calls.find((call) => String(call.sql).includes("SET status = 'excluded'"));
  assert.ok(updateCall);
  assert.deepEqual(updateCall.params[0], inspect.details.entry_ids);
  assert.equal(updateCall.params[1], EXCLUDE_REASON);
  assert.equal(updateCall.params[2], SYNTHETIC_TENANT_ID);
  const requestInsert = calls.find((call) => String(call.sql).includes('unnest($1::uuid[])'));
  assert.ok(requestInsert);
  assert.deepEqual(requestInsert.params[0], [...ALLOWED_REQUESTS]);
  assert.match(EXCLUSIONS_INSERT_SQL, /ON CONFLICT \(mortgage_request_id\) DO NOTHING/);
  assert.equal(calls.some((call) => String(call.sql) === 'BEGIN'), true);
  assert.equal(calls.some((call) => String(call.sql) === 'COMMIT'), true);
  assert.equal(triggerPreservesPaidImmutability(triggerDef), true);
});

test('inspect helper and pack-and-create refuse apply', () => {
  const invoke = fs.readFileSync(path.join(ROOT, 'isolated/mortgage-agent-compensation/oneshot50/invoke.mjs'), 'utf8');
  const pack = fs.readFileSync(path.join(ROOT, 'isolated/mortgage-agent-compensation/oneshot50/pack-and-create.mjs'), 'utf8');
  assert.match(invoke, /this helper is inspect-only/);
  assert.match(pack, /pack-and-create is inspect-setup only/);
  assert.match(pack, /refusing overwrite/);
  assert.doesNotMatch(pack, /update-function-code/);
  assert.doesNotMatch(pack, /delete-function/);
  assert.match(pack, /get-function-configuration', '--function-name', 'checksops-staging-api'/);
});

test('monthly UI/API expose Adjustments without changing Gross/Paid/Balance formula', () => {
  assert.match(API, /parent_entry_id IS NOT NULL\), 0\)::int AS adjustment_cents/);
  assert.match(API, /coalesce\(sum\(e.amount_cents\), 0\)::int AS gross_owed_cents/);
  assert.match(PANEL, /label="Adjustments"/);
  assert.match(PANEL, /Number\(totals.adjustment_cents \|\| 0\) !== 0/);
  assert.match(PANEL, /label="Gross Owed"/);
  assert.match(PANEL, /label="Paid"/);
  assert.match(PANEL, /label="Balance"/);
});
