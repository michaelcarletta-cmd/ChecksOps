import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SQL71 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/71_homeowner_ledger_view_contract.sql'), 'utf8');
const SQL68 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/68_staging_class_a_grants.sql'), 'utf8');
const PG_BIN = '/usr/lib/postgresql/16/bin';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CLAIM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const CLAIM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const CHECK_A = '33333333-3333-4333-8333-333333333331';
const CHECK_B = '33333333-3333-4333-8333-333333333332';
const CHECK_OTHER_CLAIM = '33333333-3333-4333-8333-333333333333';
const TOKEN_CLAIM = '44444444-4444-4444-8444-444444444441';
const TOKEN_PRE = '55555555-5555-4555-8555-555555555551';
const TOKEN_EXPIRED = '66666666-6666-4666-8666-666666666661';
const TOKEN_REVOKED = '77777777-7777-4777-8777-777777777771';
const TOKEN_MISMATCH = '88888888-8888-4888-8888-888888888881';
const BATCH_A = '99999999-9999-4999-8999-999999999991';

test('SQL 71 accepted source SHA256 is exact and grants are constrained', () => {
  const sha = createHash('sha256').update(SQL71).digest('hex');
  assert.equal(sha, '21d0968676097bb771e0271a6793e9ad0d48d4be02c70e85d728eb0f0b657ab5');
  assert.match(SQL71, /CREATE OR REPLACE FUNCTION public\.aws_public_homeowner_ledger_by_token\(p_token text\)/);
  assert.equal((SQL71.match(/CREATE OR REPLACE FUNCTION/g) || []).length, 1);
  assert.match(SQL71, /REVOKE ALL ON FUNCTION public\.aws_public_homeowner_ledger_by_token\(text\) FROM PUBLIC/);
  assert.match(SQL71, /REVOKE ALL ON FUNCTION public\.aws_public_homeowner_ledger_by_token\(text\) FROM authenticated/);
  assert.match(SQL71, /GRANT EXECUTE ON FUNCTION public\.aws_public_homeowner_ledger_by_token\(text\) TO checksops/);
  assert.doesNotMatch(SQL71, /CREATE TABLE|ALTER TABLE|ENABLE ROW LEVEL SECURITY|CREATE POLICY/);
  assert.doesNotMatch(SQL71, /cognito|moov_|plaid_|wallet_|GRANT SELECT ON TABLE/i);
});

test('SQL 71 replaces the RPC in a new file and keeps historical 68 intact', () => {
  assert.match(SQL68, /CREATE OR REPLACE FUNCTION public\.aws_public_homeowner_ledger_by_token/);
  assert.match(SQL68, /'ok', true/);
  assert.doesNotMatch(SQL68, /'mode', 'claim'/);
  assert.match(SQL71, /Does NOT rewrite historical aws\/workflows\/sql\/68_staging_class_a_grants\.sql/);
  assert.match(SQL71, /CREATE OR REPLACE FUNCTION public\.aws_public_homeowner_ledger_by_token\(p_token text\)/);
  assert.match(SQL71, /SECURITY DEFINER/);
  assert.match(SQL71, /SET search_path = public/);
  assert.match(SQL71, /GRANT EXECUTE ON FUNCTION public\.aws_public_homeowner_ledger_by_token\(text\) TO checksops/);
  assert.match(SQL71, /REVOKE ALL ON FUNCTION public\.aws_public_homeowner_ledger_by_token\(text\) FROM PUBLIC/);
  assert.match(SQL71, /REVOKE ALL ON FUNCTION public\.aws_public_homeowner_ledger_by_token\(text\) FROM authenticated/);
  assert.match(SQL71, /c\.org_id = tok\.tenant_id/);
  assert.match(SQL71, /i\.tenant_id = tok\.tenant_id/);
  assert.match(SQL71, /e\.tenant_id = tok\.tenant_id/);
  assert.match(SQL71, /s\.tenant_id = tok\.tenant_id/);
  assert.match(SQL71, /b\.tenant_id = tok\.tenant_id/);
  assert.match(SQL71, /AND i\.claim_id = tok\.claim_id/);
  assert.match(SQL71, /WHERE claim_id = tok\.claim_id\s+AND tenant_id = tok\.tenant_id/);
  assert.match(SQL71, /WHERE e\.claim_id = tok\.claim_id\s+AND e\.tenant_id = tok\.tenant_id/);
  assert.match(SQL71, /payee_type IN \('insured', 'mortgage_company'\)/);
  assert.match(SQL71, /pending_signatures', '\[\]'::jsonb/);
  assert.match(SQL71, /'money', NULL/);
  assert.match(SQL71, /allow_deductible_payment', false/);
  assert.match(SQL71, /handleHomeownerLedgerSignLink is not/);
  assert.doesNotMatch(SQL71, /wallet_balance|routing_number|account_number|moov_transfer|plaid_transfer/);
  assert.doesNotMatch(SQL71, /ALTER TABLE[\s\S]*ENABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(SQL71, /GRANT SELECT ON TABLE public\.claims TO authenticated/);
  assert.doesNotMatch(SQL71, /payee_type IN \([^)]*public_adjuster/);
  assert.doesNotMatch(SQL71, /payee_type IN \([^)]*contractor/);
});

const run = (bin, args, opts = {}) => spawnSync(bin, args, {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
  ...opts,
});

const mustRun = (bin, args, opts = {}) => {
  const result = run(bin, args, opts);
  if (result.status !== 0) {
    throw new Error(`${bin} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result;
};

const SCHEMA = `
CREATE TABLE public.homeowner_ledger_tokens (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  claim_id uuid,
  token text NOT NULL,
  homeowner_email text,
  homeowner_name text,
  revoked_at timestamptz,
  expires_at timestamptz,
  last_viewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.claims (
  id uuid PRIMARY KEY,
  org_id uuid,
  claim_number text,
  policyholder_address text,
  loss_type text,
  status text,
  created_at timestamptz
);
CREATE TABLE public.check_intake_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  claim_id uuid,
  amount numeric,
  check_stage text,
  check_number text
);
CREATE TABLE public.homeowner_ledger_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  check_id uuid,
  event_type text,
  occurred_at timestamptz NOT NULL,
  amount numeric,
  actor_label text,
  payload_json jsonb
);
CREATE TABLE public.homeowner_ledger_check_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id uuid,
  tenant_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.check_endorsements (
  id uuid PRIMARY KEY,
  check_id uuid NOT NULL,
  tenant_id uuid,
  payee_name text,
  payee_type text,
  status text,
  token text,
  contact_email text,
  signed_at timestamptz,
  request_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.disbursement_batches (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  check_intake_item_id uuid
);
CREATE TABLE public.disbursement_splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  amount numeric,
  status text
);
CREATE TABLE public.claim_disbursements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL,
  check_id uuid,
  amount numeric,
  status text
);
`;

const SEED = `
INSERT INTO public.claims (id, org_id, claim_number, policyholder_address, loss_type, status, created_at) VALUES
  ('${CLAIM_A}', '${TENANT_A}', 'CL-100', '1 Main St', 'wind', 'open', '2026-01-01T00:00:00Z'),
  ('${CLAIM_B}', '${TENANT_B}', 'CL-FOREIGN', '9 Other Rd', 'hail', 'open', '2026-01-01T00:00:00Z');

INSERT INTO public.check_intake_items (id, tenant_id, claim_id, amount, check_stage, check_number) VALUES
  ('${CHECK_A}', '${TENANT_A}', '${CLAIM_A}', 1000, 'deposited', '1001'),
  ('${CHECK_B}', '${TENANT_A}', '${CLAIM_A}', 250, 'review', '1002'),
  ('${CHECK_OTHER_CLAIM}', '${TENANT_B}', '${CLAIM_B}', 9000, 'deposited', '9999');

INSERT INTO public.homeowner_ledger_events
  (id, tenant_id, claim_id, check_id, event_type, occurred_at, amount, actor_label, payload_json)
VALUES
  ('e1111111-1111-4111-8111-111111111111', '${TENANT_A}', '${CLAIM_A}', '${CHECK_A}', 'check_received', '2026-01-02T00:00:00Z', 1000, 'Intake', '{}'::jsonb),
  ('e2222222-2222-4222-8222-222222222222', '${TENANT_B}', '${CLAIM_B}', '${CHECK_OTHER_CLAIM}', 'check_received', '2026-01-02T00:00:00Z', 9000, 'Foreign', '{}'::jsonb);

INSERT INTO public.check_endorsements
  (id, check_id, tenant_id, payee_name, payee_type, status, token, contact_email, signed_at, request_sent_at, created_at)
VALUES
  ('d1111111-1111-4111-8111-111111111111', '${CHECK_A}', '${TENANT_A}', 'Ada Lovelace', 'insured', 'pending', 'endorse-ada', 'ada@example.com', NULL, NULL, now()),
  ('d2222222-2222-4222-8222-222222222222', '${CHECK_A}', '${TENANT_A}', 'First National', 'mortgage_company', 'sent', 'endorse-mtg', 'bank@example.com', NULL, '2026-01-03T00:00:00Z', now()),
  ('d3333333-3333-4333-8333-333333333333', '${CHECK_A}', '${TENANT_A}', 'Internal PA', 'public_adjuster', 'sent', 'endorse-pa', 'pa@example.com', NULL, '2026-01-03T00:00:00Z', now()),
  ('d4444444-4444-4444-8444-444444444444', '${CHECK_OTHER_CLAIM}', '${TENANT_B}', 'Other Insured', 'insured', 'pending', 'endorse-other', 'other@example.com', NULL, NULL, now());

INSERT INTO public.disbursement_batches (id, tenant_id, check_intake_item_id)
VALUES ('${BATCH_A}', '${TENANT_A}', '${CHECK_A}');
INSERT INTO public.disbursement_splits (batch_id, tenant_id, amount, status)
VALUES ('${BATCH_A}', '${TENANT_A}', 400, 'sent');
INSERT INTO public.claim_disbursements (claim_id, check_id, amount, status)
VALUES ('${CLAIM_A}', '${CHECK_A}', 25, 'paid'),
       ('${CLAIM_B}', '${CHECK_OTHER_CLAIM}', 8000, 'paid');

INSERT INTO public.homeowner_ledger_tokens
  (id, tenant_id, claim_id, token, homeowner_email, homeowner_name, revoked_at, expires_at)
VALUES
  ('${TOKEN_CLAIM}', '${TENANT_A}', '${CLAIM_A}', 'valid-claim-token-value', 'ada@example.com', 'Ada Lovelace', NULL, NULL),
  ('${TOKEN_PRE}', '${TENANT_A}', NULL, 'valid-preclaim-token-value', 'ada@example.com', 'Ada Lovelace', NULL, NULL),
  ('${TOKEN_EXPIRED}', '${TENANT_A}', '${CLAIM_A}', 'expired-token-value', 'ada@example.com', 'Ada Lovelace', NULL, now() - interval '1 day'),
  ('${TOKEN_REVOKED}', '${TENANT_A}', '${CLAIM_A}', 'revoked-token-value', 'ada@example.com', 'Ada Lovelace', now(), NULL),
  ('${TOKEN_MISMATCH}', '${TENANT_B}', '${CLAIM_A}', 'mismatch-token-value', 'eve@example.com', 'Eve', NULL, NULL);

INSERT INTO public.homeowner_ledger_check_uploads (token_id, tenant_id)
VALUES ('${TOKEN_PRE}', '${TENANT_A}'), ('${TOKEN_PRE}', '${TENANT_A}');
`;

test('isolated PostgreSQL RPC enforces the view contract and fail-closed isolation', { timeout: 180000 }, async (t) => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) {
    t.skip('PostgreSQL 16 initdb is not installed in this environment');
    return;
  }
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-homeowner-ledger-'));
  const port = 55900 + (process.pid % 1000);
  const logPath = path.join(pgData, 'pg.log');
  mustRun(path.join(PG_BIN, 'initdb'), [
    '-D', pgData, '--auth=trust', '--no-sync', '--username=ubuntu', '--encoding=UTF8',
  ]);
  fs.appendFileSync(path.join(pgData, 'postgresql.conf'), `
listen_addresses = ''
port = ${port}
unix_socket_directories = '${pgData}'
logging_collector = off
shared_buffers = 32MB
max_connections = 20
`);
  const started = run(path.join(PG_BIN, 'pg_ctl'), [
    '-D', pgData, '-l', logPath, '-w', '-t', '30', 'start',
  ]);
  if (started.status !== 0) {
    throw new Error(`pg_ctl start failed: ${started.stderr || fs.readFileSync(logPath, 'utf8')}`);
  }
  const psql = (sql) => {
    const result = mustRun(path.join(PG_BIN, 'psql'), [
      '-h', pgData, '-p', String(port), '-U', 'ubuntu', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql,
    ]);
    return result.stdout.trim();
  };
  try {
    psql(SCHEMA);
    psql(SQL71);
    psql(SEED);

    const claimDoc = JSON.parse(psql(`SELECT public.aws_public_homeowner_ledger_by_token('valid-claim-token-value')::text`));
    assert.equal(claimDoc.ok, true);
    assert.equal(claimDoc.mode, 'claim');
    assert.deepEqual(claimDoc.homeowner, { name: 'Ada Lovelace', email: 'ada@example.com' });
    assert.equal(claimDoc.claim.claim_number, 'CL-100');
    assert.equal(claimDoc.claim.property_address, '1 Main St');
    assert.equal(Number(claimDoc.totals.received), 1250);
    assert.equal(Number(claimDoc.totals.deposited), 1000);
    assert.equal(Number(claimDoc.totals.released), 425);
    assert.equal(Number(claimDoc.totals.remaining), 825);
    assert.equal(claimDoc.events.length, 1);
    assert.equal(claimDoc.events[0].event_type, 'check_received');
    assert.equal(claimDoc.pending_endorsements.length, 1);
    assert.deepEqual(claimDoc.pending_endorsements[0].parties.map((row) => row.payee_type).sort(), [
      'insured',
      'mortgage_company',
    ]);
    const insured = claimDoc.pending_endorsements[0].parties.find((row) => row.payee_type === 'insured');
    const mortgage = claimDoc.pending_endorsements[0].parties.find((row) => row.payee_type === 'mortgage_company');
    assert.equal(insured.is_homeowner, true);
    assert.equal(insured.sign_url, '/endorse?token=endorse-ada');
    assert.equal(mortgage.is_homeowner, false);
    assert.equal(mortgage.sign_url, null);
    assert.deepEqual(claimDoc.pending_signatures, []);
    assert.deepEqual(claimDoc.shared_documents, []);
    assert.equal(claimDoc.project_plan, null);
    assert.equal(claimDoc.can_upload, true);
    assert.equal(claimDoc.money, null);
    assert.equal(claimDoc.allow_deductible_payment, false);
    assert.deepEqual(claimDoc.deductible_payments, []);
    assert.doesNotMatch(JSON.stringify(claimDoc), /CL-FOREIGN|Internal PA|endorse-pa|endorse-other|9000|wallet|routing|bank_account/);

    const pre = JSON.parse(psql(`SELECT public.aws_public_homeowner_ledger_by_token('valid-preclaim-token-value')::text`));
    assert.equal(pre.mode, 'pre_claim');
    assert.deepEqual(pre.homeowner, { name: 'Ada Lovelace', email: 'ada@example.com' });
    assert.equal(pre.claim, null);
    assert.deepEqual(pre.events, []);
    assert.equal(Number(pre.totals.received), 0);
    assert.equal(pre.pending_upload_count, 2);
    assert.deepEqual(pre.pending_endorsements, []);
    assert.equal(pre.money, null);
    assert.equal(pre.allow_deductible_payment, false);

    assert.equal(psql(`SELECT public.aws_public_homeowner_ledger_by_token('missing-token-value') IS NULL`), 't');
    assert.equal(psql(`SELECT public.aws_public_homeowner_ledger_by_token('short') IS NULL`), 't');
    assert.equal(JSON.parse(psql(`SELECT public.aws_public_homeowner_ledger_by_token('expired-token-value')::text`)).error, 'expired');
    assert.equal(JSON.parse(psql(`SELECT public.aws_public_homeowner_ledger_by_token('revoked-token-value')::text`)).error, 'revoked');
    assert.equal(psql(`SELECT public.aws_public_homeowner_ledger_by_token('mismatch-token-value') IS NULL`), 't');
  } finally {
    run(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'immediate', 'stop']);
  }
});
