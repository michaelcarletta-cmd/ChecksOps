/**
 * SQL 82 (aws/workflows/sql/82_homeowner_ledger_view.sql): Homeowner Ledger
 * public view contract. Static checks plus an isolated PostgreSQL 16 run of
 * tenant + claim isolation, totals, last_viewed_at telemetry and the
 * no-raw-endorsement-token rule.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PG_BIN, pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SQL82_REL = 'aws/workflows/sql/82_homeowner_ledger_view.sql';
const SQL82 = fs.readFileSync(path.join(ROOT, SQL82_REL), 'utf8');
const SQL83 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/83_homeowner_signing_capabilities.sql'), 'utf8');
const SQL_DIR = path.join(ROOT, 'aws/workflows/sql');
const sql82Body = SQL82.replace(/^\s*--.*$/gm, '');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CLAIM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const CLAIM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const CLAIM_ORG_B_CHECK = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const CLAIM_ORG_B_EVENT = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
const CLAIM_ORG_B_NONE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
const CLAIM_ORG_B_OTHER_TENANT = 'ffffffff-ffff-4fff-8fff-fffffffffff1';
const CHECK_A = '33333333-3333-4333-8333-333333333331';
const CHECK_B = '33333333-3333-4333-8333-333333333332';
const CHECK_OTHER_CLAIM = '33333333-3333-4333-8333-333333333333';
const CHECK_ORG_B_CLAIM = '33333333-3333-4333-8333-333333333334';
const CHECK_OTHER_TENANT_ON_CLAIM = '33333333-3333-4333-8333-333333333335';
const TOKEN_CLAIM = '44444444-4444-4444-8444-444444444441';
const TOKEN_PRE = '55555555-5555-4555-8555-555555555551';
const TOKEN_EXPIRED = '66666666-6666-4666-8666-666666666661';
const TOKEN_REVOKED = '77777777-7777-4777-8777-777777777771';
const TOKEN_MISMATCH = '88888888-8888-4888-8888-888888888881';
const TOKEN_ORG_B_CHECK = '44444444-4444-4444-8444-444444444442';
const TOKEN_ORG_B_EVENT = '44444444-4444-4444-8444-444444444443';
const TOKEN_ORG_B_NONE = '44444444-4444-4444-8444-444444444444';
const TOKEN_ORG_B_OTHER_TENANT = '44444444-4444-4444-8444-444444444445';
const BATCH_A = '99999999-9999-4999-8999-999999999991';

test('SQL 82 and 83 take unused migration numbers after main\'s SQL 81', () => {
  const files = fs.readdirSync(SQL_DIR).filter((name) => name.endsWith('.sql'));
  const prefixOf = (name) => Number(name.match(/^(\d+)_/)?.[1]);
  assert.deepEqual(files.filter((name) => prefixOf(name) === 82), ['82_homeowner_ledger_view.sql']);
  assert.deepEqual(files.filter((name) => prefixOf(name) === 83), ['83_homeowner_signing_capabilities.sql']);
  assert.equal(Math.max(...files.map(prefixOf).filter((n) => n < 82)), 81);
  for (const stale of [
    '71_homeowner_ledger_view_contract.sql',
    '72_homeowner_ledger_view_claim_ok.sql',
    '73_homeowner_ledger_view_last_viewed_best_effort.sql',
    '74_homeowner_signing_rls_boundary.sql',
  ]) {
    assert.equal(files.includes(stale), false, stale);
  }
});

test('SQL 82 replaces only the ledger view RPC and keeps grants constrained', () => {
  assert.match(SQL82, /^-- AWS: Homeowner Ledger public view contract \(SQL 82\)\./);
  assert.match(SQL82, /Does NOT rewrite historical aws\/workflows\/sql\/68_staging_class_a_grants\.sql/);
  assert.doesNotMatch(SQL82, /\b7[1-4]_homeowner/);
  assert.match(SQL82, /CREATE OR REPLACE FUNCTION public\.aws_public_homeowner_ledger_by_token\(p_token text\)/);
  assert.equal((SQL82.match(/CREATE OR REPLACE FUNCTION/g) || []).length, 1);
  assert.match(SQL82, /SECURITY DEFINER/);
  assert.match(SQL82, /SET search_path = public/);
  assert.match(SQL82, /REVOKE ALL ON FUNCTION public\.aws_public_homeowner_ledger_by_token\(text\) FROM PUBLIC/);
  assert.match(SQL82, /REVOKE ALL ON FUNCTION public\.aws_public_homeowner_ledger_by_token\(text\) FROM authenticated/);
  assert.match(SQL82, /GRANT EXECUTE ON FUNCTION public\.aws_public_homeowner_ledger_by_token\(text\) TO checksops/);
  assert.doesNotMatch(sql82Body, /CREATE TABLE|ALTER TABLE|ENABLE ROW LEVEL SECURITY|CREATE POLICY/);
  assert.doesNotMatch(sql82Body, /cognito|moov_|plaid_|wallet_|GRANT SELECT ON TABLE/i);
  assert.match(sql82Body, /i\.check_stage::text/);
  assert.match(sql82Body, /EXCEPTION\s+WHEN OTHERS THEN/);
  assert.match(sql82Body, /'pending_signatures', '\[\]'::jsonb/);
  assert.match(sql82Body, /'money', NULL/);
  assert.match(sql82Body, /'allow_deductible_payment', false/);
  // last_viewed_at only after authorization.
  const firstViewed = sql82Body.indexOf('SET last_viewed_at = now()');
  const claimOk = sql82Body.indexOf('INTO claim_ok');
  const claimJson = sql82Body.indexOf('INTO claim_json');
  const secondViewed = sql82Body.indexOf('SET last_viewed_at = now()', claimJson);
  assert.ok(firstViewed > 0 && firstViewed < claimOk, 'pre_claim branch records the view');
  assert.ok(secondViewed > claimJson, 'claim branch records the view after claim_ok + claim JSON');
});

test('SQL 82 never builds an /endorse link from check_endorsements.token', () => {
  assert.doesNotMatch(sql82Body, /\/endorse\?token=/);
  assert.doesNotMatch(sql82Body, /e\.token/);
  assert.match(sql82Body, /'sign_url', NULL::text/);
});

test('SQL 83 copies the SQL 82 claim_ok block exactly', () => {
  const marker = '-- Fail closed: claim must exist';
  const claimOk82 = SQL82.slice(SQL82.indexOf(marker), SQL82.indexOf('IF NOT claim_ok THEN'));
  let from = 0;
  let copies = 0;
  while (SQL83.indexOf(marker, from) >= 0) {
    const start = SQL83.indexOf(marker, from);
    assert.equal(SQL83.slice(start, SQL83.indexOf('IF NOT claim_ok THEN', start)), claimOk82);
    from = start + marker.length;
    copies += 1;
  }
  assert.equal(copies, 3);
});

const run = (bin, args, opts = {}) => spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...opts });

const psqlFor = (pg) => (sql, { stop = true } = {}) => {
  const args = ['-h', pg.host, '-p', String(pg.port), '-U', 'ubuntu', '-d', 'postgres', '-At'];
  if (stop) args.push('-v', 'ON_ERROR_STOP=1');
  args.push('-c', sql);
  const result = run(path.join(PG_BIN, 'psql'), args);
  if (stop && result.status !== 0) {
    throw new Error(`psql failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return stop ? result.stdout.trim() : result;
};

const SCHEMA = `
DO $$ BEGIN
  CREATE ROLE authenticated NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE ROLE checksops NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
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
  ('${CLAIM_B}', '${TENANT_B}', 'CL-FOREIGN', '9 Other Rd', 'hail', 'open', '2026-01-01T00:00:00Z'),
  ('${CLAIM_ORG_B_CHECK}', '${TENANT_B}', 'CL-ORG-B-CHECK', '2 Bind St', 'wind', 'open', '2026-01-01T00:00:00Z'),
  ('${CLAIM_ORG_B_EVENT}', '${TENANT_B}', 'CL-ORG-B-EVENT', '3 Bind St', 'wind', 'open', '2026-01-01T00:00:00Z'),
  ('${CLAIM_ORG_B_NONE}', '${TENANT_B}', 'CL-ORG-B-NONE', '4 None St', 'wind', 'open', '2026-01-01T00:00:00Z'),
  ('${CLAIM_ORG_B_OTHER_TENANT}', '${TENANT_B}', 'CL-ORG-B-FOREIGN-BIND', '5 Other St', 'wind', 'open', '2026-01-01T00:00:00Z');

INSERT INTO public.check_intake_items (id, tenant_id, claim_id, amount, check_stage, check_number) VALUES
  ('${CHECK_A}', '${TENANT_A}', '${CLAIM_A}', 1000, 'deposited', '1001'),
  ('${CHECK_B}', '${TENANT_A}', '${CLAIM_A}', 250, 'review', '1002'),
  ('${CHECK_OTHER_CLAIM}', '${TENANT_B}', '${CLAIM_B}', 9000, 'deposited', '9999'),
  ('${CHECK_ORG_B_CLAIM}', '${TENANT_A}', '${CLAIM_ORG_B_CHECK}', 333, 'deposited', '2001'),
  ('${CHECK_OTHER_TENANT_ON_CLAIM}', '${TENANT_B}', '${CLAIM_ORG_B_OTHER_TENANT}', 7777, 'deposited', '3001');

INSERT INTO public.homeowner_ledger_events
  (id, tenant_id, claim_id, check_id, event_type, occurred_at, amount, actor_label, payload_json)
VALUES
  ('e1111111-1111-4111-8111-111111111111', '${TENANT_A}', '${CLAIM_A}', '${CHECK_A}', 'check_received', '2026-01-02T00:00:00Z', 1000, 'Intake', '{}'::jsonb),
  ('e2222222-2222-4222-8222-222222222222', '${TENANT_B}', '${CLAIM_B}', '${CHECK_OTHER_CLAIM}', 'check_received', '2026-01-02T00:00:00Z', 9000, 'Foreign', '{}'::jsonb),
  ('e3333333-3333-4333-8333-333333333333', '${TENANT_A}', '${CLAIM_ORG_B_EVENT}', NULL, 'check_received', '2026-01-02T00:00:00Z', 50, 'Same-tenant event', '{}'::jsonb),
  ('e4444444-4444-4444-8444-444444444444', '${TENANT_B}', '${CLAIM_ORG_B_OTHER_TENANT}', '${CHECK_OTHER_TENANT_ON_CLAIM}', 'check_received', '2026-01-02T00:00:00Z', 7777, 'Other-tenant event', '{}'::jsonb);

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
       ('${CLAIM_B}', '${CHECK_OTHER_CLAIM}', 8000, 'paid'),
       ('${CLAIM_ORG_B_CHECK}', '${CHECK_ORG_B_CLAIM}', 8000, 'paid');

INSERT INTO public.homeowner_ledger_tokens
  (id, tenant_id, claim_id, token, homeowner_email, homeowner_name, revoked_at, expires_at)
VALUES
  ('${TOKEN_CLAIM}', '${TENANT_A}', '${CLAIM_A}', 'valid-claim-token-value', 'ada@example.com', 'Ada Lovelace', NULL, NULL),
  ('${TOKEN_PRE}', '${TENANT_A}', NULL, 'valid-preclaim-token-value', 'ada@example.com', 'Ada Lovelace', NULL, NULL),
  ('${TOKEN_EXPIRED}', '${TENANT_A}', '${CLAIM_A}', 'expired-token-value', 'ada@example.com', 'Ada Lovelace', NULL, now() - interval '1 day'),
  ('${TOKEN_REVOKED}', '${TENANT_A}', '${CLAIM_A}', 'revoked-token-value', 'ada@example.com', 'Ada Lovelace', now(), NULL),
  ('${TOKEN_MISMATCH}', '${TENANT_B}', '${CLAIM_A}', 'mismatch-token-value', 'eve@example.com', 'Eve', NULL, NULL),
  ('${TOKEN_ORG_B_CHECK}', '${TENANT_A}', '${CLAIM_ORG_B_CHECK}', 'org-b-check-token-value', 'ada@example.com', 'Ada Lovelace', NULL, NULL),
  ('${TOKEN_ORG_B_EVENT}', '${TENANT_A}', '${CLAIM_ORG_B_EVENT}', 'org-b-event-token-value', 'ada@example.com', 'Ada Lovelace', NULL, NULL),
  ('${TOKEN_ORG_B_NONE}', '${TENANT_A}', '${CLAIM_ORG_B_NONE}', 'org-b-none-token-value', 'ada@example.com', 'Ada Lovelace', NULL, NULL),
  ('${TOKEN_ORG_B_OTHER_TENANT}', '${TENANT_A}', '${CLAIM_ORG_B_OTHER_TENANT}', 'org-b-other-tenant-token-value', 'ada@example.com', 'Ada Lovelace', NULL, NULL);

INSERT INTO public.homeowner_ledger_check_uploads (token_id, tenant_id)
VALUES ('${TOKEN_PRE}', '${TENANT_A}'), ('${TOKEN_PRE}', '${TENANT_A}');
`;

test('isolated PostgreSQL SQL 82 enforces tenant + claim isolation and never returns endorsement tokens', { timeout: 180000 }, (t) => {
  const skip = pgSkipReason();
  if (skip) { t.skip(skip); return; }
  const pg = startPg('pg-homeowner-sql82-', 55900);
  const psql = psqlFor(pg);
  try {
    psql(SCHEMA);
    psql(SQL82);
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
    assert.equal(claimDoc.pending_endorsements.length, 1);
    assert.deepEqual(claimDoc.pending_endorsements[0].parties.map((row) => row.payee_type).sort(), [
      'insured',
      'mortgage_company',
    ]);
    for (const party of claimDoc.pending_endorsements[0].parties) {
      assert.equal(party.sign_url, null, party.payee_type);
    }
    const insured = claimDoc.pending_endorsements[0].parties.find((row) => row.payee_type === 'insured');
    assert.equal(insured.is_homeowner, true);
    assert.deepEqual(claimDoc.pending_signatures, []);
    assert.equal(claimDoc.money, null);
    assert.equal(claimDoc.allow_deductible_payment, false);
    assert.doesNotMatch(
      JSON.stringify(claimDoc),
      /endorse-ada|endorse-mtg|endorse-pa|endorse-other|CL-FOREIGN|Internal PA|9000|wallet|routing|bank_account|contact_email|bank@example/,
    );
    assert.equal(psql(`SELECT last_viewed_at IS NOT NULL FROM public.homeowner_ledger_tokens WHERE token = 'valid-claim-token-value'`), 't');

    // Empty homeowner email: SQL still lists insured rows (display only), never a token.
    psql(`UPDATE public.homeowner_ledger_tokens SET homeowner_email = NULL WHERE token = 'valid-claim-token-value'`);
    const emptyEmail = JSON.parse(psql(`SELECT public.aws_public_homeowner_ledger_by_token('valid-claim-token-value')::text`));
    assert.doesNotMatch(JSON.stringify(emptyEmail), /endorse-ada|endorse-mtg|\/endorse\?token=/);
    psql(`UPDATE public.homeowner_ledger_tokens SET homeowner_email = 'ada@example.com' WHERE token = 'valid-claim-token-value'`);

    const checkBound = JSON.parse(psql(`SELECT public.aws_public_homeowner_ledger_by_token('org-b-check-token-value')::text`));
    assert.equal(checkBound.ok, true);
    assert.equal(checkBound.claim.id, CLAIM_ORG_B_CHECK);
    assert.equal(Number(checkBound.totals.received), 333);
    assert.equal(Number(checkBound.totals.released), 0);
    assert.doesNotMatch(JSON.stringify(checkBound), /CL-FOREIGN|CL-100|9000|7777|8000/);

    const eventBound = JSON.parse(psql(`SELECT public.aws_public_homeowner_ledger_by_token('org-b-event-token-value')::text`));
    assert.equal(eventBound.ok, true);
    assert.equal(eventBound.claim.id, CLAIM_ORG_B_EVENT);
    assert.doesNotMatch(JSON.stringify(eventBound), /Other-tenant/);

    psql(`UPDATE public.homeowner_ledger_tokens SET last_viewed_at = NULL`);
    for (const token of ['org-b-none-token-value', 'org-b-other-tenant-token-value', 'mismatch-token-value', 'missing-token-value', 'short']) {
      assert.equal(psql(`SELECT public.aws_public_homeowner_ledger_by_token('${token}') IS NULL`), 't', token);
    }
    assert.equal(JSON.parse(psql(`SELECT public.aws_public_homeowner_ledger_by_token('expired-token-value')::text`)).error, 'expired');
    assert.equal(JSON.parse(psql(`SELECT public.aws_public_homeowner_ledger_by_token('revoked-token-value')::text`)).error, 'revoked');
    assert.equal(
      psql(`SELECT count(*) FROM public.homeowner_ledger_tokens WHERE last_viewed_at IS NOT NULL`),
      '0',
      'unauthorized tokens never record a view',
    );

    const pre = JSON.parse(psql(`SELECT public.aws_public_homeowner_ledger_by_token('valid-preclaim-token-value')::text`));
    assert.equal(pre.mode, 'pre_claim');
    assert.equal(pre.claim, null);
    assert.equal(pre.pending_upload_count, 2);
    assert.deepEqual(pre.pending_endorsements, []);

    const grants = psql(`
      SELECT string_agg(grantee || ':' || privilege_type, ',' ORDER BY grantee)
      FROM information_schema.routine_privileges
      WHERE routine_schema = 'public' AND routine_name = 'aws_public_homeowner_ledger_by_token'
        AND grantee <> 'ubuntu'
    `);
    assert.equal(grants, 'checksops:EXECUTE');
  } finally {
    pg.stop();
  }
});

const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const CLAIM_695064 = '398df4b8-f23a-476f-b856-ff864a4148b8';
const CHECK_ENDORSING_A = '00062a57-13b5-493d-a996-cf6e72d5cc89';
const CHECK_ENDORSING_B = '3ebc2f0f-1cf7-47b5-9b0b-ac9ce6bdace9';
const CHECK_REVIEW_A = '6238a632-84f1-4eea-a352-2cf639ebe4b4';
const CHECK_REVIEW_B = '66174175-ccd3-4d15-a0e2-49aeeb074fc5';
const TOKEN_695064 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';

const ENUM_SCHEMA = `
DO $$ BEGIN
  CREATE ROLE authenticated NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE ROLE checksops NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE TYPE public.check_stage AS ENUM (
  'review', 'loss_draft', 'endorsing', 'ready_for_deposit',
  'deposited', 'funds_released', 'disbursed_externally', 'returned'
);
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
  check_stage public.check_stage,
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

const SEED_695064 = `
INSERT INTO public.claims (id, org_id, claim_number, policyholder_address, loss_type, status, created_at)
VALUES ('${CLAIM_695064}', '${FREEDOM}', '695064-GQ', '1 Freedom Way', 'wind', 'open', '2026-01-01T00:00:00Z');
INSERT INTO public.check_intake_items (id, tenant_id, claim_id, amount, check_stage, check_number) VALUES
  ('${CHECK_ENDORSING_A}', '${FREEDOM}', '${CLAIM_695064}', 1500, 'endorsing', '1001'),
  ('${CHECK_ENDORSING_B}', '${FREEDOM}', '${CLAIM_695064}', 2200, 'endorsing', '1002'),
  ('${CHECK_REVIEW_A}', '${FREEDOM}', '${CLAIM_695064}', 800, 'review', '1003'),
  ('${CHECK_REVIEW_B}', '${FREEDOM}', '${CLAIM_695064}', 400, 'review', '1004');
INSERT INTO public.homeowner_ledger_events
  (id, tenant_id, claim_id, check_id, event_type, occurred_at, amount, actor_label, payload_json)
VALUES
  ('e1111111-1111-4111-8111-111111111111', '${FREEDOM}', '${CLAIM_695064}', '${CHECK_ENDORSING_A}', 'check_received', '2026-01-02T00:00:00Z', 1500, 'Intake', '{}'::jsonb);
INSERT INTO public.check_endorsements
  (id, check_id, tenant_id, payee_name, payee_type, status, token, contact_email, signed_at, request_sent_at, created_at)
VALUES
  ('d1111111-1111-4111-8111-111111111111', '${CHECK_ENDORSING_A}', '${FREEDOM}', 'Ada Lovelace', 'insured', 'pending', 'endorse-ada-a', 'ada@example.com', NULL, NULL, now()),
  ('d2222222-2222-4222-8222-222222222222', '${CHECK_ENDORSING_A}', '${FREEDOM}', 'First National', 'mortgage_company', 'sent', 'endorse-mtg-a', 'bank@example.com', NULL, '2026-01-03T00:00:00Z', now()),
  ('d3333333-3333-4333-8333-333333333333', '${CHECK_ENDORSING_B}', '${FREEDOM}', 'Ada Lovelace', 'insured', 'pending', 'endorse-ada-b', 'ada@example.com', NULL, NULL, now()),
  ('d4444444-4444-4444-8444-444444444444', '${CHECK_ENDORSING_B}', '${FREEDOM}', 'First National', 'mortgage_company', 'sent', 'endorse-mtg-b', 'bank@example.com', NULL, '2026-01-03T00:00:00Z', now()),
  ('d5555555-5555-4555-8555-555555555555', '${CHECK_ENDORSING_A}', '${FREEDOM}', 'Internal PA', 'public_adjuster', 'sent', 'endorse-pa', 'pa@example.com', NULL, '2026-01-03T00:00:00Z', now());
INSERT INTO public.homeowner_ledger_tokens
  (id, tenant_id, claim_id, token, homeowner_email, homeowner_name, revoked_at, expires_at)
VALUES
  ('${TOKEN_695064}', '${FREEDOM}', '${CLAIM_695064}', 'freedom-695064-token-value', 'ada@example.com', 'Ada Lovelace', NULL, NULL);
`;

test('SQL 82 returns the 695064-GQ ledger on a live-like check_stage enum and survives telemetry failure', { timeout: 180000 }, (t) => {
  const skip = pgSkipReason();
  if (skip) { t.skip(skip); return; }
  const pg = startPg('pg-homeowner-sql82-enum-', 56900);
  const psql = psqlFor(pg);
  try {
    psql(ENUM_SCHEMA);
    psql(SQL82);
    psql(SEED_695064);
    const doc = JSON.parse(psql(`SELECT public.aws_public_homeowner_ledger_by_token('freedom-695064-token-value')::text`));
    assert.equal(doc.ok, true);
    assert.equal(doc.claim.claim_number, '695064-GQ');
    assert.equal(Number(doc.totals.received), 4900);
    assert.equal(Number(doc.totals.deposited), 0);
    assert.equal(Number(doc.totals.remaining), 4900);
    assert.equal(doc.pending_endorsements.length, 2);
    for (const row of doc.pending_endorsements) {
      assert.deepEqual(row.parties.map((party) => party.payee_type).sort(), ['insured', 'mortgage_company']);
      for (const party of row.parties) assert.equal(party.sign_url, null);
    }
    assert.doesNotMatch(JSON.stringify(doc), /endorse-ada|endorse-mtg|Internal PA|endorse-pa/);

    psql(`UPDATE public.homeowner_ledger_tokens SET last_viewed_at = NULL`);
    psql(`
      CREATE OR REPLACE FUNCTION public.trg_fail_last_viewed()
      RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.last_viewed_at IS NOT NULL THEN
          RAISE EXCEPTION 'last_viewed_at telemetry failed';
        END IF;
        RETURN NEW;
      END;
      $fn$;
      CREATE TRIGGER trg_fail_last_viewed
      BEFORE UPDATE OF last_viewed_at ON public.homeowner_ledger_tokens
      FOR EACH ROW EXECUTE FUNCTION public.trg_fail_last_viewed();
    `);
    const afterFail = JSON.parse(psql(`SELECT public.aws_public_homeowner_ledger_by_token('freedom-695064-token-value')::text`));
    assert.equal(afterFail.ok, true);
    assert.equal(afterFail.pending_endorsements.length, 2);
    assert.equal(psql(`SELECT last_viewed_at IS NULL FROM public.homeowner_ledger_tokens WHERE token = 'freedom-695064-token-value'`), 't');
  } finally {
    pg.stop();
  }
});
