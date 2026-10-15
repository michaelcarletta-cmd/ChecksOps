/**
 * SQL 83 (aws/workflows/sql/83_homeowner_signing_capabilities.sql): Homeowner
 * signing doorways. Static checks plus an isolated PostgreSQL 16 run of the
 * three SECURITY DEFINER functions on top of SQL 82.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PG_BIN, pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SQL82 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/82_homeowner_ledger_view.sql'), 'utf8');
const SQL83 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/83_homeowner_signing_capabilities.sql'), 'utf8');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CLAIM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const CLAIM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const CHECK_A = '33333333-3333-4333-8333-333333333331';
const CHECK_B = '33333333-3333-4333-8333-333333333332';
const ENDORSE_INSURED = 'd1111111-1111-4111-8111-111111111111';
const ENDORSE_MORTGAGE = 'd2222222-2222-4222-8222-222222222222';
const ENDORSE_OTHER = 'd4444444-4444-4444-8444-444444444444';
const ENDORSE_JOINT = 'd5555555-5555-4555-8555-555555555551';
const ENDORSE_JOINT_B = 'd5555555-5555-4555-8555-555555555552';
const REQUEST_A = '77777777-7777-4777-8777-777777777771';
const REQUEST_CLAIM_ONLY = '77777777-7777-4777-8777-777777777772';
const REQUEST_FOREIGN = '77777777-7777-4777-8777-777777777773';
const REQUEST_MORTGAGE = '77777777-7777-4777-8777-777777777774';
const REQUEST_DONE = '77777777-7777-4777-8777-777777777775';
const SIGNER_HOME = '88888888-8888-4888-8888-888888888881';
const SIGNER_CLAIM_ONLY = '88888888-8888-4888-8888-888888888882';
const SIGNER_FOREIGN = '88888888-8888-4888-8888-888888888883';
const SIGNER_MORTGAGE = '88888888-8888-4888-8888-888888888884';
const SIGNER_DONE = '88888888-8888-4888-8888-888888888885';
const SIGNER_CLEARED = '88888888-8888-4888-8888-888888888886';
const SIGNER_JOINT_A = '88888888-8888-4888-8888-888888888887';
const SIGNER_JOINT_B = '88888888-8888-4888-8888-888888888888';
const REQUEST_JOINT = '77777777-7777-4777-8777-777777777776';
const REQUEST_CLEARED = '77777777-7777-4777-8777-777777777777';
const RAW_TOKEN = 'aa'.repeat(32);
const TENANT_C = '99999999-9999-4999-8999-999999999990';
const CLAIM_SHARED = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc9';
const CHECK_SHARED = '33333333-3333-4333-8333-333333333339';
const REQUEST_SHARED_CLAIM_ONLY = '77777777-7777-4777-8777-777777777779';
const REQUEST_SHARED_CHECK = '77777777-7777-4777-8777-77777777777a';
const SIGNER_SHARED_CLAIM_ONLY = '88888888-8888-4888-8888-888888888889';
const SIGNER_SHARED_CHECK = '88888888-8888-4888-8888-88888888888a';

test('SQL 83 is a sibling forward migration and does not rewrite SQL 82', () => {
  assert.match(SQL83, /^-- AWS: Homeowner signing capabilities \(SQL 83\)\./);
  assert.match(SQL83, /Does NOT rewrite historical aws\/workflows\/sql\/82_homeowner_ledger_view\.sql/);
  assert.doesNotMatch(SQL83, /\b7[1-4]_homeowner/);
  const body = SQL83.replace(/^\s*--.*$/gm, '');
  assert.equal((body.match(/CREATE OR REPLACE FUNCTION/g) || []).length, 3);
  assert.doesNotMatch(body, /aws_public_homeowner_ledger_by_token/);
  assert.equal((body.match(/SECURITY DEFINER/g) || []).length, 3);
  assert.equal((body.match(/SET search_path = public/g) || []).length, 3);
  assert.equal((body.match(/SET row_security = off/g) || []).length, 3);
  for (const fn of [
    'aws_public_homeowner_ledger_endorse_capability\\(text, uuid\\)',
    'aws_public_homeowner_pending_signatures\\(text\\)',
    'aws_public_homeowner_document_sign_capability\\(text, uuid\\)',
  ]) {
    assert.match(SQL83, new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn} FROM PUBLIC`));
    assert.match(SQL83, new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn} FROM authenticated`));
    assert.match(SQL83, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn} TO checksops`));
  }
  assert.doesNotMatch(body, /CREATE TABLE|ALTER TABLE|ENABLE ROW LEVEL SECURITY|CREATE POLICY/);
  assert.doesNotMatch(body, /UPDATE public\.signature_signers/);
  assert.doesNotMatch(body, /SET token_hash/);
  assert.doesNotMatch(body, /e\.revoked_at/);
  assert.doesNotMatch(body, /cognito|moov_|plaid_|wallet_|GRANT SELECT ON TABLE/i);
  // The only write is minting an empty check_endorsements.token.
  assert.equal((body.match(/\bUPDATE\b/g) || []).length, 1);
  assert.match(body, /UPDATE public\.check_endorsements\s+SET token = endorse_token\s+WHERE id = rec\.id\s+AND \(token IS NULL OR token = ''\)/);
  // Claim-only Signature Requests are bound to the token tenant.
  assert.equal((body.match(/rc\.org_id IS NULL OR rc\.org_id = tok\.tenant_id/g) || []).length, 2);
});

const run = (bin, args, opts = {}) => spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...opts });

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
CREATE TABLE public.signature_requests (
  id uuid PRIMARY KEY,
  claim_id uuid,
  check_intake_item_id uuid,
  document_name text NOT NULL,
  document_path text NOT NULL DEFAULT 'doc.pdf',
  status text NOT NULL DEFAULT 'pending',
  sent_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.signature_signers (
  id uuid PRIMARY KEY,
  signature_request_id uuid NOT NULL,
  signer_name text NOT NULL,
  signer_email text NOT NULL,
  signer_type text NOT NULL,
  signing_order integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending',
  signed_at timestamptz,
  access_token text,
  token_hash text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

const SEED = `
INSERT INTO public.claims (id, org_id, claim_number, policyholder_address, loss_type, status, created_at) VALUES
  ('${CLAIM_A}', '${TENANT_A}', 'CL-100', '1 Main St', 'wind', 'open', '2026-01-01T00:00:00Z'),
  ('${CLAIM_B}', '${TENANT_B}', 'CL-FOREIGN', '9 Other Rd', 'hail', 'open', '2026-01-01T00:00:00Z');

INSERT INTO public.check_intake_items (id, tenant_id, claim_id, amount, check_stage, check_number) VALUES
  ('${CHECK_A}', '${TENANT_A}', '${CLAIM_A}', 1000, 'deposited', '271682'),
  ('${CHECK_B}', '${TENANT_B}', '${CLAIM_B}', 9000, 'deposited', '9999');

INSERT INTO public.homeowner_ledger_events
  (id, tenant_id, claim_id, check_id, event_type, occurred_at, amount, actor_label, payload_json)
VALUES
  ('e1111111-1111-4111-8111-111111111111', '${TENANT_A}', '${CLAIM_A}', '${CHECK_A}', 'check_received', '2026-01-02T00:00:00Z', 1000, 'Intake', '{}'::jsonb);

INSERT INTO public.check_endorsements
  (id, check_id, tenant_id, payee_name, payee_type, status, token, contact_email, signed_at, request_sent_at, created_at)
VALUES
  ('${ENDORSE_INSURED}', '${CHECK_A}', '${TENANT_A}', 'Homeowner Anissa Nassry', 'insured', 'sent', 'endorse-anissa', 'other@example.com', NULL, '2026-01-03T00:00:00Z', now()),
  ('${ENDORSE_MORTGAGE}', '${CHECK_A}', '${TENANT_A}', 'First National', 'mortgage_company', 'sent', 'endorse-mtg', 'bank@example.com', NULL, '2026-01-03T00:00:00Z', now()),
  ('${ENDORSE_OTHER}', '${CHECK_B}', '${TENANT_B}', 'Other Insured', 'insured', 'sent', 'endorse-other', 'other@example.com', NULL, '2026-01-03T00:00:00Z', now()),
  ('${ENDORSE_JOINT}', '${CHECK_A}', '${TENANT_A}', 'JOHN SMITH', 'insured', 'sent', 'endorse-john', 'john@example.com', NULL, '2026-01-03T00:00:00Z', now()),
  ('${ENDORSE_JOINT_B}', '${CHECK_A}', '${TENANT_A}', 'JANE SMITH', 'insured', 'sent', 'endorse-jane', 'jane@example.com', NULL, '2026-01-03T00:00:00Z', now());

INSERT INTO public.homeowner_ledger_tokens
  (id, tenant_id, claim_id, token, homeowner_email, homeowner_name, revoked_at, expires_at)
VALUES
  ('44444444-4444-4444-8444-444444444441', '${TENANT_A}', '${CLAIM_A}', 'valid-claim-token-value', 'invite@example.com', 'Freedom Invite', NULL, NULL),
  ('44444444-4444-4444-8444-444444444442', '${TENANT_B}', '${CLAIM_B}', 'foreign-token-value', 'eve@example.com', 'Eve', NULL, NULL),
  ('44444444-4444-4444-8444-444444444443', '${TENANT_A}', '${CLAIM_A}', 'revoked-token-value', 'invite@example.com', 'Freedom Invite', now(), NULL);

INSERT INTO public.signature_requests
  (id, claim_id, check_intake_item_id, document_name, status, sent_at, completed_at)
VALUES
  ('${REQUEST_A}', '${CLAIM_A}', '${CHECK_A}', 'Proof of Loss', 'pending', '2026-09-27T00:00:00Z', NULL),
  ('${REQUEST_CLAIM_ONLY}', '${CLAIM_A}', NULL, 'Claim-only packet', 'sent', '2026-09-27T00:00:00Z', NULL),
  ('${REQUEST_FOREIGN}', '${CLAIM_B}', '${CHECK_B}', 'Foreign packet', 'pending', '2026-09-27T00:00:00Z', NULL),
  ('${REQUEST_MORTGAGE}', '${CLAIM_A}', '${CHECK_A}', 'Mortgage packet', 'pending', '2026-09-27T00:00:00Z', NULL),
  ('${REQUEST_DONE}', '${CLAIM_A}', '${CHECK_A}', 'Completed packet', 'completed', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z'),
  ('${REQUEST_JOINT}', '${CLAIM_A}', NULL, 'Joint packet', 'pending', '2026-09-27T00:00:00Z', NULL),
  ('${REQUEST_CLEARED}', '${CLAIM_A}', NULL, 'Cleared token packet', 'pending', '2026-09-27T00:00:00Z', NULL);

INSERT INTO public.signature_signers
  (id, signature_request_id, signer_name, signer_email, signer_type, signing_order, status, signed_at, access_token, token_hash)
VALUES
  ('${SIGNER_HOME}', '${REQUEST_A}', 'Anissa Nassry', 'anissa@example.com', 'policyholder', 1, 'pending', NULL, '${RAW_TOKEN}', 'hash-must-not-leak'),
  ('${SIGNER_CLAIM_ONLY}', '${REQUEST_CLAIM_ONLY}', 'Anissa Nassry', 'anissa@example.com', 'insured', 1, 'pending', NULL, '${RAW_TOKEN}', 'hash-claim-only'),
  ('${SIGNER_FOREIGN}', '${REQUEST_FOREIGN}', 'Eve', 'eve@example.com', 'policyholder', 1, 'pending', NULL, '${RAW_TOKEN}', 'hash-foreign'),
  ('${SIGNER_MORTGAGE}', '${REQUEST_MORTGAGE}', 'First National', 'bank@example.com', 'mortgage_company', 1, 'pending', NULL, '${RAW_TOKEN}', 'hash-mortgage'),
  ('${SIGNER_DONE}', '${REQUEST_DONE}', 'Anissa Nassry', 'anissa@example.com', 'policyholder', 1, 'signed', '2026-09-02T00:00:00Z', '${RAW_TOKEN}', 'hash-done'),
  ('${SIGNER_JOINT_A}', '${REQUEST_JOINT}', 'JOHN SMITH', 'john@example.com', 'policyholder', 1, 'pending', NULL, '${RAW_TOKEN}', 'hash-john'),
  ('${SIGNER_JOINT_B}', '${REQUEST_JOINT}', 'JANE SMITH', 'jane@example.com', 'insured', 2, 'pending', NULL, '${RAW_TOKEN}', 'hash-jane'),
  ('${SIGNER_CLEARED}', '${REQUEST_CLEARED}', 'Anissa Nassry', 'anissa@example.com', 'homeowner', 1, 'pending', NULL, NULL, 'hash-already-emailed');
`;

const SHARED_CLAIM_SEED = `
-- CLAIM_SHARED belongs to TENANT_C. TENANT_A only has a check on it, which
-- satisfies claim_ok for a TENANT_A token on that claim.
INSERT INTO public.claims (id, org_id, claim_number, policyholder_address, loss_type, status, created_at)
VALUES ('${CLAIM_SHARED}', '${TENANT_C}', 'CL-SHARED', '7 Shared Ln', 'wind', 'open', '2026-01-01T00:00:00Z');
INSERT INTO public.check_intake_items (id, tenant_id, claim_id, amount, check_stage, check_number)
VALUES ('${CHECK_SHARED}', '${TENANT_A}', '${CLAIM_SHARED}', 500, 'review', '5005');
INSERT INTO public.homeowner_ledger_tokens
  (id, tenant_id, claim_id, token, homeowner_email, homeowner_name, revoked_at, expires_at)
VALUES ('44444444-4444-4444-8444-444444444449', '${TENANT_A}', '${CLAIM_SHARED}', 'shared-claim-token-value', 'anissa@example.com', 'Anissa Nassry', NULL, NULL);
INSERT INTO public.signature_requests (id, claim_id, check_intake_item_id, document_name, status, sent_at)
VALUES
  ('${REQUEST_SHARED_CLAIM_ONLY}', '${CLAIM_SHARED}', NULL, 'Tenant C claim-only packet', 'pending', '2026-09-27T00:00:00Z'),
  ('${REQUEST_SHARED_CHECK}', '${CLAIM_SHARED}', '${CHECK_SHARED}', 'Tenant A check packet', 'pending', '2026-09-27T00:00:00Z');
INSERT INTO public.signature_signers
  (id, signature_request_id, signer_name, signer_email, signer_type, signing_order, status, signed_at, access_token, token_hash)
VALUES
  ('${SIGNER_SHARED_CLAIM_ONLY}', '${REQUEST_SHARED_CLAIM_ONLY}', 'Anissa Nassry', 'anissa@example.com', 'policyholder', 1, 'pending', NULL, '${'bb'.repeat(32)}', 'hash-tenant-c'),
  ('${SIGNER_SHARED_CHECK}', '${REQUEST_SHARED_CHECK}', 'Anissa Nassry', 'anissa@example.com', 'policyholder', 1, 'pending', NULL, '${'cc'.repeat(32)}', 'hash-tenant-a-check');
`;

test('isolated PostgreSQL SQL 83 sibling definers fail closed without rewriting SQL 82', { timeout: 180000 }, (t) => {
  const skip = pgSkipReason();
  if (skip) { t.skip(skip); return; }
  const pg = startPg('pg-homeowner-sql83-', 56100);
  const psql = (sql) => {
    const result = run(path.join(PG_BIN, 'psql'), [
      '-h', pg.host, '-p', String(pg.port), '-U', 'ubuntu', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql,
    ]);
    if (result.status !== 0) throw new Error(`psql failed (${result.status}): ${result.stderr || result.stdout}`);
    return result.stdout.trim();
  };
  try {
    psql(SCHEMA);
    psql(SQL82);
    const hashBefore = createHash('sha256').update(psql(
      `SELECT pg_get_functiondef('public.aws_public_homeowner_ledger_by_token(text)'::regprocedure)`,
    )).digest('hex');
    psql(SEED);
    psql(SQL83);
    const hashAfter = createHash('sha256').update(psql(
      `SELECT pg_get_functiondef('public.aws_public_homeowner_ledger_by_token(text)'::regprocedure)`,
    )).digest('hex');
    assert.equal(hashAfter, hashBefore);

    const grants = psql(`
      SELECT grantee || ':' || privilege_type
      FROM information_schema.routine_privileges
      WHERE routine_schema = 'public'
        AND routine_name IN (
          'aws_public_homeowner_ledger_endorse_capability',
          'aws_public_homeowner_pending_signatures',
          'aws_public_homeowner_document_sign_capability'
        )
        AND privilege_type = 'EXECUTE'
      ORDER BY 1
    `);
    assert.match(grants, /checksops:EXECUTE/);
    assert.doesNotMatch(grants, /PUBLIC:EXECUTE|authenticated:EXECUTE/);

    psql(`
      DELETE FROM public.check_endorsements
      WHERE id IN ('${ENDORSE_JOINT}', '${ENDORSE_JOINT_B}')
    `);
    const sole = JSON.parse(psql(`
      SELECT public.aws_public_homeowner_ledger_endorse_capability(
        'valid-claim-token-value', '${ENDORSE_INSURED}'::uuid
      )::text
    `));
    assert.equal(sole.ok, true);
    assert.equal(sole.endorse_token, 'endorse-anissa');
    assert.doesNotMatch(JSON.stringify(sole), /endorse-mtg|endorse-other|endorse-john/);

    const mortgage = JSON.parse(psql(`
      SELECT public.aws_public_homeowner_ledger_endorse_capability(
        'valid-claim-token-value', '${ENDORSE_MORTGAGE}'::uuid
      )::text
    `));
    assert.equal(mortgage.ok, false);
    assert.equal(mortgage.error, 'not_your_signature');

    const swap = JSON.parse(psql(`
      SELECT public.aws_public_homeowner_ledger_endorse_capability(
        'valid-claim-token-value', '${ENDORSE_OTHER}'::uuid
      )::text
    `));
    assert.equal(swap.ok, false);
    assert.equal(swap.error, 'not_found');

    const foreignToken = JSON.parse(psql(`
      SELECT public.aws_public_homeowner_ledger_endorse_capability(
        'foreign-token-value', '${ENDORSE_INSURED}'::uuid
      )::text
    `));
    assert.equal(foreignToken.ok, false);
    assert.equal(foreignToken.error, 'not_found');

    psql(`
      INSERT INTO public.check_endorsements
        (id, check_id, tenant_id, payee_name, payee_type, status, token, contact_email, signed_at, request_sent_at)
      VALUES
        ('${ENDORSE_JOINT}', '${CHECK_A}', '${TENANT_A}', 'JOHN SMITH', 'insured', 'sent', 'endorse-john', 'john@example.com', NULL, now()),
        ('${ENDORSE_JOINT_B}', '${CHECK_A}', '${TENANT_A}', 'JANE SMITH', 'insured', 'sent', 'endorse-jane', 'jane@example.com', NULL, now())
    `);
    const ambiguous = JSON.parse(psql(`
      SELECT public.aws_public_homeowner_ledger_endorse_capability(
        'valid-claim-token-value', '${ENDORSE_JOINT}'::uuid
      )::text
    `));
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.error, 'not_your_signature');

    const pending = JSON.parse(psql(`
      SELECT public.aws_public_homeowner_pending_signatures('valid-claim-token-value')::text
    `));
    assert.equal(pending.ok, true);
    const names = (pending.requests || []).map((row) => row.document_name).sort();
    assert.deepEqual(names, ['Claim-only packet', 'Cleared token packet', 'Proof of Loss']);
    const encodedPending = JSON.stringify(pending);
    assert.doesNotMatch(encodedPending, /hash-must-not-leak|hash-claim-only|hash-foreign|hash-mortgage|${RAW_TOKEN}|access_token|token_hash|Foreign packet|Mortgage packet/);
    const claimOnly = pending.requests.find((row) => row.document_name === 'Claim-only packet');
    assert.equal(claimOnly.signers[0].can_sign, true);
    assert.equal(claimOnly.signers[0].is_homeowner, true);

    const jointPending = pending.requests.find((row) => row.document_name === 'Joint packet');
    assert.equal(jointPending, undefined);

    const foreignDoc = JSON.parse(psql(`
      SELECT public.aws_public_homeowner_document_sign_capability(
        'valid-claim-token-value', '${SIGNER_FOREIGN}'::uuid
      )::text
    `));
    assert.equal(foreignDoc.ok, false);
    assert.equal(foreignDoc.error, 'not_found');

    const mortgageDoc = JSON.parse(psql(`
      SELECT public.aws_public_homeowner_document_sign_capability(
        'valid-claim-token-value', '${SIGNER_MORTGAGE}'::uuid
      )::text
    `));
    assert.equal(mortgageDoc.ok, false);
    assert.equal(mortgageDoc.error, 'not_your_signature');

    const doneDoc = JSON.parse(psql(`
      SELECT public.aws_public_homeowner_document_sign_capability(
        'valid-claim-token-value', '${SIGNER_DONE}'::uuid
      )::text
    `));
    assert.equal(doneDoc.ok, false);
    assert.equal(doneDoc.error, 'invalid_state');

    const jointDoc = JSON.parse(psql(`
      SELECT public.aws_public_homeowner_document_sign_capability(
        'valid-claim-token-value', '${SIGNER_JOINT_A}'::uuid
      )::text
    `));
    assert.equal(jointDoc.ok, false);
    assert.equal(jointDoc.error, 'not_your_signature');

    const cleared = JSON.parse(psql(`
      SELECT public.aws_public_homeowner_document_sign_capability(
        'valid-claim-token-value', '${SIGNER_CLEARED}'::uuid
      )::text
    `));
    assert.equal(cleared.ok, false);
    assert.equal(cleared.error, 'existing_email_link_required');
    assert.doesNotMatch(JSON.stringify(cleared), /hash-already-emailed|${RAW_TOKEN}/);

    const reusable = JSON.parse(psql(`
      SELECT public.aws_public_homeowner_document_sign_capability(
        'valid-claim-token-value', '${SIGNER_CLAIM_ONLY}'::uuid
      )::text
    `));
    assert.equal(reusable.ok, true);
    assert.equal(reusable.access_token, RAW_TOKEN);
    assert.equal(reusable.reused_existing_access_token, true);
    const hashStill = psql(`SELECT token_hash FROM public.signature_signers WHERE id = '${SIGNER_CLAIM_ONLY}'`);
    assert.equal(hashStill, 'hash-claim-only');

    const revoked = JSON.parse(psql(`
      SELECT public.aws_public_homeowner_ledger_endorse_capability(
        'revoked-token-value', '${ENDORSE_INSURED}'::uuid
      )::text
    `));
    assert.equal(revoked.ok, false);
    assert.equal(revoked.error, 'revoked');

    // Claim-only requests on a claim another tenant owns stay invisible, even
    // though a same-tenant check makes the claim_ok binding hold.
    psql(SHARED_CLAIM_SEED);
    const shared = JSON.parse(psql(`SELECT public.aws_public_homeowner_pending_signatures('shared-claim-token-value')::text`));
    assert.equal(shared.ok, true);
    assert.deepEqual((shared.requests || []).map((row) => row.document_name), ['Tenant A check packet']);
    assert.doesNotMatch(JSON.stringify(shared), /Tenant C claim-only packet|hash-tenant-c|b{64}/);
    const sharedClaimOnly = JSON.parse(psql(`
      SELECT public.aws_public_homeowner_document_sign_capability(
        'shared-claim-token-value', '${SIGNER_SHARED_CLAIM_ONLY}'::uuid
      )::text
    `));
    assert.equal(sharedClaimOnly.ok, false);
    assert.equal(sharedClaimOnly.error, 'not_found');
    assert.doesNotMatch(JSON.stringify(sharedClaimOnly), /b{64}/);
    const sharedCheck = JSON.parse(psql(`
      SELECT public.aws_public_homeowner_document_sign_capability(
        'shared-claim-token-value', '${SIGNER_SHARED_CHECK}'::uuid
      )::text
    `));
    assert.equal(sharedCheck.ok, true);
    assert.equal(sharedCheck.access_token, 'cc'.repeat(32));

    // Name match: every >=3-letter part must be a whole word. A shared
    // surname or a substring never lets one co-insured act for another.
    psql(`
      INSERT INTO public.homeowner_ledger_tokens
        (id, tenant_id, claim_id, token, homeowner_email, homeowner_name, revoked_at, expires_at)
      VALUES
        ('44444444-4444-4444-8444-44444444444a', '${TENANT_A}', '${CLAIM_A}', 'john-smith-token-value', 'nomatch@example.com', 'John Smith', NULL, NULL),
        ('44444444-4444-4444-8444-44444444444b', '${TENANT_A}', '${CLAIM_A}', 'smith-only-token-value', 'nomatch@example.com', 'Bo Smith', NULL, NULL),
        ('44444444-4444-4444-8444-44444444444c', '${TENANT_A}', '${CLAIM_A}', 'jo-substring-token-value', 'nomatch@example.com', 'Joh Smit', NULL, NULL)
    `);
    const endorseAs = (tok, id) => JSON.parse(psql(`
      SELECT public.aws_public_homeowner_ledger_endorse_capability('${tok}', '${id}'::uuid)::text
    `));
    assert.equal(endorseAs('john-smith-token-value', ENDORSE_JOINT).ok, true);
    assert.equal(endorseAs('john-smith-token-value', ENDORSE_JOINT_B).error, 'not_your_signature');
    assert.equal(endorseAs('smith-only-token-value', ENDORSE_JOINT).error, 'not_your_signature');
    assert.equal(endorseAs('smith-only-token-value', ENDORSE_JOINT_B).error, 'not_your_signature');
    assert.equal(endorseAs('jo-substring-token-value', ENDORSE_JOINT).error, 'not_your_signature');
    const signAs = (tok, id) => JSON.parse(psql(`
      SELECT public.aws_public_homeowner_document_sign_capability('${tok}', '${id}'::uuid)::text
    `));
    assert.equal(signAs('john-smith-token-value', SIGNER_JOINT_A).ok, true);
    assert.equal(signAs('john-smith-token-value', SIGNER_JOINT_B).error, 'not_your_signature');
    assert.equal(signAs('smith-only-token-value', SIGNER_JOINT_A).error, 'not_your_signature');
    const johnPending = JSON.parse(psql(`SELECT public.aws_public_homeowner_pending_signatures('john-smith-token-value')::text`));
    const joint = johnPending.requests.find((row) => row.document_name === 'Joint packet');
    assert.deepEqual(joint.signers.map((row) => [row.signer_name, row.is_homeowner]), [['JOHN SMITH', true], ['JANE SMITH', false]]);
    const ledgerAsJohn = JSON.parse(psql(`SELECT public.aws_public_homeowner_ledger_by_token('john-smith-token-value')::text`));
    const flags = Object.fromEntries(ledgerAsJohn.pending_endorsements[0].parties
      .filter((row) => row.payee_type === 'insured')
      .map((row) => [row.payee_name, row.is_homeowner]));
    assert.equal(flags['JOHN SMITH'], true);
    assert.equal(flags['JANE SMITH'], false);

    // Empty endorsement token is minted once and then reused.
    psql(`UPDATE public.check_endorsements SET token = NULL WHERE id = '${ENDORSE_INSURED}'`);
    psql(`DELETE FROM public.check_endorsements WHERE id IN ('${ENDORSE_JOINT}', '${ENDORSE_JOINT_B}')`);
    const minted = JSON.parse(psql(`
      SELECT public.aws_public_homeowner_ledger_endorse_capability('valid-claim-token-value', '${ENDORSE_INSURED}'::uuid)::text
    `));
    assert.equal(minted.ok, true);
    assert.match(minted.endorse_token, /^[0-9a-f-]{36}$/);
    const again = JSON.parse(psql(`
      SELECT public.aws_public_homeowner_ledger_endorse_capability('valid-claim-token-value', '${ENDORSE_INSURED}'::uuid)::text
    `));
    assert.equal(again.endorse_token, minted.endorse_token);

    const fnHashAfter = createHash('sha256').update(psql(
      `SELECT pg_get_functiondef('public.aws_public_homeowner_ledger_by_token(text)'::regprocedure)`,
    )).digest('hex');
    assert.equal(fnHashAfter, hashAfter);
  } finally {
    pg.stop();
  }
});
