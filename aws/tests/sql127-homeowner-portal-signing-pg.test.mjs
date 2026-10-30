/**
 * SQL 127 (aws/workflows/sql/127_homeowner_portal_signing.sql) on PostgreSQL 16, on top of the real
 * SQL 82 and SQL 83 files: what a homeowner can sign from the claim portal (the ledger token).
 *
 *   - before (SQL 83 only): a 'pending' insured endorsement is invalid_state, and a homeowner signer
 *     whose emailed link expired is not listed;
 *   - after: the 'pending' insured endorsement opens through the endorse capability (its empty
 *     token minted once, then reused); 'manual_required', a mortgage_company payee, another
 *     tenant's ledger token and an unknown token are refused; pending_signatures lists the open
 *     homeowner signer whose expires_at is past; document_portal_signer returns ok with the
 *     signer's existing token_hash (64 hex), renews an expired expires_at to now() + 72 hours with
 *     the hash unchanged, leaves a fresh expiry alone, and refuses a contractor signer, a signer
 *     whose request is completed, a never-sent signer (no token_hash), another claim's token and
 *     another tenant's token; EXECUTE is checksops-only (PUBLIC and authenticated have none) and
 *     SQL 82's view and SQL 83's document capability are unchanged.
 * The executor path and the fingerprint are aws/tests/release-sql127-executor.test.mjs.
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
const SQL127 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/127_homeowner_portal_signing.sql'), 'utf8');
const sha = (text) => createHash('sha256').update(text).digest('hex');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CLAIM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const CLAIM_A2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const CLAIM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const CHECK_A = '33333333-3333-4333-8333-333333333331';
const CHECK_B = '33333333-3333-4333-8333-333333333332';
const ENDORSE_PENDING = 'd1111111-1111-4111-8111-111111111111';
const ENDORSE_MANUAL = 'd2222222-2222-4222-8222-222222222222';
const ENDORSE_MORTGAGE = 'd3333333-3333-4333-8333-333333333333';
const ENDORSE_FOREIGN = 'd4444444-4444-4444-8444-444444444444';
const REQUEST_OPEN = '77777777-7777-4777-8777-777777777771';
const REQUEST_CONTRACTOR = '77777777-7777-4777-8777-777777777772';
const REQUEST_DONE = '77777777-7777-4777-8777-777777777773';
const REQUEST_NEVER_SENT = '77777777-7777-4777-8777-777777777774';
const REQUEST_FRESH = '77777777-7777-4777-8777-777777777775';
const SIGNER_HOME = '88888888-8888-4888-8888-888888888881';
const SIGNER_CONTRACTOR = '88888888-8888-4888-8888-888888888882';
const SIGNER_DONE = '88888888-8888-4888-8888-888888888883';
const SIGNER_NEVER_SENT = '88888888-8888-4888-8888-888888888884';
const SIGNER_FRESH = '88888888-8888-4888-8888-888888888885';
const HASH_HOME = sha('raw-link-home');
const HASH_CONTRACTOR = sha('raw-link-contractor');
const HASH_DONE = sha('raw-link-done');
const HASH_FRESH = sha('raw-link-fresh');
const PORTAL_TOKEN = 'portal-token-claim-a';
const OTHER_CLAIM_TOKEN = 'portal-token-claim-a2';
const FOREIGN_TOKEN = 'portal-token-tenant-b';
const FNS = [
  'public.aws_public_homeowner_ledger_endorse_capability(text, uuid)',
  'public.aws_public_homeowner_pending_signatures(text)',
  'public.aws_public_homeowner_document_portal_signer(text, uuid)',
];

const run = (bin, args, opts = {}) => spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...opts });

// The tables SQL 82, SQL 83 and SQL 127 read or write (as aws/tests/homeowner-signing-capabilities-sql.test.mjs builds them).
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
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, claim_id uuid, token text NOT NULL, homeowner_email text, homeowner_name text,
  revoked_at timestamptz, expires_at timestamptz, last_viewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.claims (
  id uuid PRIMARY KEY, org_id uuid, claim_number text, policyholder_address text, loss_type text, status text, created_at timestamptz);
CREATE TABLE public.check_intake_items (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, claim_id uuid, amount numeric, check_stage text, check_number text);
CREATE TABLE public.homeowner_ledger_events (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, claim_id uuid NOT NULL, check_id uuid, event_type text,
  occurred_at timestamptz NOT NULL, amount numeric, actor_label text, payload_json jsonb);
CREATE TABLE public.homeowner_ledger_check_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_id uuid, tenant_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.check_endorsements (
  id uuid PRIMARY KEY, check_id uuid NOT NULL, tenant_id uuid, payee_name text, payee_type text, status text, token text,
  contact_email text, signed_at timestamptz, request_sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.disbursement_batches (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, check_intake_item_id uuid);
CREATE TABLE public.disbursement_splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid NOT NULL, tenant_id uuid NOT NULL, amount numeric, status text);
CREATE TABLE public.claim_disbursements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid NOT NULL, check_id uuid, amount numeric, status text);
CREATE TABLE public.signature_requests (
  id uuid PRIMARY KEY, claim_id uuid, check_intake_item_id uuid, document_name text NOT NULL, document_path text NOT NULL DEFAULT 'doc.pdf',
  status text NOT NULL DEFAULT 'pending', sent_at timestamptz, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.signature_signers (
  id uuid PRIMARY KEY, signature_request_id uuid NOT NULL, signer_name text NOT NULL, signer_email text NOT NULL, signer_type text NOT NULL,
  signing_order integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'pending', signed_at timestamptz, access_token text,
  token_hash text, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
`;

const SEED = `
INSERT INTO public.claims (id, org_id, claim_number, policyholder_address, loss_type, status, created_at) VALUES
  ('${CLAIM_A}', '${TENANT_A}', 'CL-100', '1 Main St', 'wind', 'open', '2026-01-01T00:00:00Z'),
  ('${CLAIM_A2}', '${TENANT_A}', 'CL-101', '2 Main St', 'hail', 'open', '2026-01-01T00:00:00Z'),
  ('${CLAIM_B}', '${TENANT_B}', 'CL-FOREIGN', '9 Other Rd', 'hail', 'open', '2026-01-01T00:00:00Z');
INSERT INTO public.check_intake_items (id, tenant_id, claim_id, amount, check_stage, check_number) VALUES
  ('${CHECK_A}', '${TENANT_A}', '${CLAIM_A}', 1000, 'review', '271682'),
  ('${CHECK_B}', '${TENANT_B}', '${CLAIM_B}', 9000, 'review', '9999');
INSERT INTO public.homeowner_ledger_tokens (id, tenant_id, claim_id, token, homeowner_email, homeowner_name) VALUES
  ('44444444-4444-4444-8444-444444444441', '${TENANT_A}', '${CLAIM_A}', '${PORTAL_TOKEN}', 'anissa@example.com', 'Anissa Nassry'),
  ('44444444-4444-4444-8444-444444444442', '${TENANT_A}', '${CLAIM_A2}', '${OTHER_CLAIM_TOKEN}', 'anissa@example.com', 'Anissa Nassry'),
  ('44444444-4444-4444-8444-444444444443', '${TENANT_B}', '${CLAIM_B}', '${FOREIGN_TOKEN}', 'eve@example.com', 'Eve Other');
INSERT INTO public.check_endorsements (id, check_id, tenant_id, payee_name, payee_type, status, token, contact_email) VALUES
  ('${ENDORSE_PENDING}', '${CHECK_A}', '${TENANT_A}', 'Anissa Nassry', 'insured', 'pending', NULL, 'anissa@example.com'),
  ('${ENDORSE_MANUAL}', '${CHECK_A}', '${TENANT_A}', 'Anissa Nassry', 'insured', 'manual_required', NULL, 'anissa@example.com'),
  ('${ENDORSE_MORTGAGE}', '${CHECK_A}', '${TENANT_A}', 'First National', 'mortgage_company', 'pending', NULL, 'bank@example.com'),
  ('${ENDORSE_FOREIGN}', '${CHECK_B}', '${TENANT_B}', 'Eve Other', 'insured', 'pending', NULL, 'eve@example.com');
INSERT INTO public.signature_requests (id, claim_id, check_intake_item_id, document_name, status, sent_at, completed_at) VALUES
  ('${REQUEST_OPEN}', '${CLAIM_A}', '${CHECK_A}', 'Proof of Loss', 'pending', now() - interval '5 days', NULL),
  ('${REQUEST_CONTRACTOR}', '${CLAIM_A}', '${CHECK_A}', 'Contractor packet', 'pending', now() - interval '5 days', NULL),
  ('${REQUEST_DONE}', '${CLAIM_A}', '${CHECK_A}', 'Completed packet', 'completed', now() - interval '9 days', now() - interval '8 days'),
  ('${REQUEST_NEVER_SENT}', '${CLAIM_A}', '${CHECK_A}', 'Never sent packet', 'pending', NULL, NULL),
  ('${REQUEST_FRESH}', '${CLAIM_A}', '${CHECK_A}', 'Fresh packet', 'pending', now(), NULL);
INSERT INTO public.signature_signers
  (id, signature_request_id, signer_name, signer_email, signer_type, signing_order, status, access_token, token_hash, expires_at)
VALUES
  ('${SIGNER_HOME}', '${REQUEST_OPEN}', 'Anissa Nassry', 'anissa@example.com', 'homeowner', 1, 'pending', NULL, '${HASH_HOME}', now() - interval '2 days'),
  ('${SIGNER_CONTRACTOR}', '${REQUEST_CONTRACTOR}', 'Anissa Nassry', 'anissa@example.com', 'contractor', 1, 'pending', NULL, '${HASH_CONTRACTOR}', now() + interval '1 day'),
  ('${SIGNER_DONE}', '${REQUEST_DONE}', 'Anissa Nassry', 'anissa@example.com', 'homeowner', 1, 'pending', NULL, '${HASH_DONE}', now() + interval '1 day'),
  ('${SIGNER_NEVER_SENT}', '${REQUEST_NEVER_SENT}', 'Anissa Nassry', 'anissa@example.com', 'homeowner', 1, 'pending', NULL, NULL, NULL),
  ('${SIGNER_FRESH}', '${REQUEST_FRESH}', 'Anissa Nassry', 'anissa@example.com', 'homeowner', 1, 'pending', NULL, '${HASH_FRESH}', now() + interval '10 days');
`;

test('SQL 127 on PostgreSQL 16 over the real SQL 82 and SQL 83: the claim portal opens pending endorsements and expired document links for the matched homeowner only; EXECUTE checksops-only', { timeout: 180000 }, async (t) => {
  const skip = pgSkipReason();
  if (skip) { t.skip(skip); return; }
  const pg = startPg('pg-sql127-', 59970);
  const psql = (sql) => {
    const result = run(path.join(PG_BIN, 'psql'), [
      '-h', pg.host, '-p', String(pg.port), '-U', 'ubuntu', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql,
    ]);
    if (result.status !== 0) throw new Error(`psql failed (${result.status}): ${result.stderr || result.stdout}`);
    return result.stdout.trim();
  };
  const json = (sql) => JSON.parse(psql(`SELECT (${sql})::text`));
  const endorse = (token, id) => json(`public.aws_public_homeowner_ledger_endorse_capability('${token}', '${id}'::uuid)`);
  const pending = (token) => json(`public.aws_public_homeowner_pending_signatures('${token}')`);
  const portal = (token, id) => json(`public.aws_public_homeowner_document_portal_signer('${token}', '${id}'::uuid)`);
  const prosrc = (identity) => sha(psql(`SELECT prosrc FROM pg_catalog.pg_proc WHERE oid = '${identity}'::regprocedure`));
  try {
    psql(SCHEMA);
    psql(SQL82);
    psql(SEED);
    psql(SQL83);
    const kept = ['public.aws_public_homeowner_ledger_by_token(text)', 'public.aws_public_homeowner_document_sign_capability(text, uuid)'].map(prosrc);

    // Before (SQL 83): a pending endorsement is closed to the portal, an expired link is hidden.
    assert.equal(endorse(PORTAL_TOKEN, ENDORSE_PENDING).error, 'invalid_state');
    assert.deepEqual(pending(PORTAL_TOKEN).requests.map((r) => r.document_name).sort(), ['Fresh packet', 'Never sent packet']);
    assert.equal(psql(`SELECT count(*) FROM pg_catalog.pg_proc WHERE proname = 'aws_public_homeowner_document_portal_signer'`), '0');

    psql(SQL127);
    assert.deepEqual(['public.aws_public_homeowner_ledger_by_token(text)', 'public.aws_public_homeowner_document_sign_capability(text, uuid)'].map(prosrc), kept);

    // Grants: EXECUTE for checksops only (and the owner); none for PUBLIC or authenticated.
    for (const identity of FNS) {
      assert.equal(psql(`SELECT has_function_privilege('checksops', '${identity}', 'EXECUTE')`), 't', identity);
      assert.equal(psql(`SELECT has_function_privilege('authenticated', '${identity}', 'EXECUTE')`), 'f', identity);
      assert.equal(psql(`SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = '${identity}'::regprocedure`), 't', identity);
    }
    const grantees = psql(`SELECT string_agg(DISTINCT grantee || ':' || privilege_type, ',' ORDER BY grantee || ':' || privilege_type)
      FROM information_schema.routine_privileges WHERE routine_schema = 'public' AND routine_name IN (
        'aws_public_homeowner_ledger_endorse_capability', 'aws_public_homeowner_pending_signatures', 'aws_public_homeowner_document_portal_signer')`);
    assert.equal(grantees, 'checksops:EXECUTE,ubuntu:EXECUTE');

    // Endorse capability: the 'pending' insured endorsement opens; its empty token is minted once.
    const opened = endorse(PORTAL_TOKEN, ENDORSE_PENDING);
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.equal(opened.endorsement_id, ENDORSE_PENDING);
    assert.equal(opened.check_id, CHECK_A);
    assert.match(opened.endorse_token, /^[0-9a-f-]{36}$/);
    assert.equal(psql(`SELECT token FROM public.check_endorsements WHERE id = '${ENDORSE_PENDING}'`), opened.endorse_token);
    assert.equal(endorse(PORTAL_TOKEN, ENDORSE_PENDING).endorse_token, opened.endorse_token);
    // 'sent' still opens.
    psql(`UPDATE public.check_endorsements SET status = 'sent' WHERE id = '${ENDORSE_PENDING}'`);
    assert.equal(endorse(PORTAL_TOKEN, ENDORSE_PENDING).ok, true);
    // Refused: manual_required, a mortgage company payee, another tenant's endorsement or token, an unknown token.
    assert.deepEqual(endorse(PORTAL_TOKEN, ENDORSE_MANUAL), { ok: false, error: 'invalid_state' });
    assert.deepEqual(endorse(PORTAL_TOKEN, ENDORSE_MORTGAGE), { ok: false, error: 'not_your_signature' });
    assert.deepEqual(endorse(PORTAL_TOKEN, ENDORSE_FOREIGN), { ok: false, error: 'not_found' });
    assert.deepEqual(endorse(FOREIGN_TOKEN, ENDORSE_PENDING), { ok: false, error: 'not_found' });
    assert.deepEqual(endorse(OTHER_CLAIM_TOKEN, ENDORSE_PENDING), { ok: false, error: 'not_found' });
    assert.deepEqual(endorse('no-such-ledger-token', ENDORSE_PENDING), { ok: false, error: 'not_found' });
    assert.equal(psql(`SELECT count(*) FROM public.check_endorsements WHERE token IS NOT NULL`), '1');

    // pending_signatures: the open homeowner signer whose emailed link expired is listed and can sign.
    const listed = pending(PORTAL_TOKEN);
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.requests.map((r) => r.document_name).sort(), ['Fresh packet', 'Never sent packet', 'Proof of Loss']);
    const proof = listed.requests.find((r) => r.request_id === REQUEST_OPEN);
    assert.deepEqual(proof.signers.map((s) => [s.signer_id, s.is_homeowner, s.can_sign]), [[SIGNER_HOME, true, true]]);
    assert.doesNotMatch(JSON.stringify(listed), /token_hash|access_token|expires_at|[0-9a-f]{64}/);
    assert.deepEqual(pending(FOREIGN_TOKEN).requests, []);

    // document_portal_signer: the existing hash, never rotated; the expired link renewed to now() + 72 hours.
    const signer = portal(PORTAL_TOKEN, SIGNER_HOME);
    assert.deepEqual(signer, { ok: true, request_id: REQUEST_OPEN, signer_id: SIGNER_HOME, token_hash: HASH_HOME });
    assert.match(signer.token_hash, /^[0-9a-f]{64}$/);
    assert.equal(psql(`SELECT token_hash FROM public.signature_signers WHERE id = '${SIGNER_HOME}'`), HASH_HOME);
    assert.equal(psql(`SELECT expires_at > now() + interval '71 hours 59 minutes' AND expires_at <= now() + interval '72 hours'
      FROM public.signature_signers WHERE id = '${SIGNER_HOME}'`), 't');
    // A link that is still fresh keeps its expiry.
    const freshBefore = psql(`SELECT expires_at FROM public.signature_signers WHERE id = '${SIGNER_FRESH}'`);
    assert.deepEqual(portal(PORTAL_TOKEN, SIGNER_FRESH), { ok: true, request_id: REQUEST_FRESH, signer_id: SIGNER_FRESH, token_hash: HASH_FRESH });
    assert.equal(psql(`SELECT expires_at FROM public.signature_signers WHERE id = '${SIGNER_FRESH}'`), freshBefore);
    // Refused: a contractor signer, a completed request, a never-sent signer, another claim's and another tenant's token.
    const before = psql('SELECT string_agg(id::text || coalesce(token_hash, \'-\') || coalesce(expires_at::text, \'-\'), \',\' ORDER BY id) FROM public.signature_signers');
    assert.deepEqual(portal(PORTAL_TOKEN, SIGNER_CONTRACTOR), { ok: false, error: 'not_your_signature' });
    assert.deepEqual(portal(PORTAL_TOKEN, SIGNER_DONE), { ok: false, error: 'invalid_state' });
    assert.deepEqual(portal(PORTAL_TOKEN, SIGNER_NEVER_SENT), { ok: false, error: 'invalid_state' });
    assert.deepEqual(portal(OTHER_CLAIM_TOKEN, SIGNER_HOME), { ok: false, error: 'not_found' });
    assert.deepEqual(portal(FOREIGN_TOKEN, SIGNER_HOME), { ok: false, error: 'not_found' });
    assert.deepEqual(portal('no-such-ledger-token', SIGNER_HOME), { ok: false, error: 'not_found' });
    assert.equal(psql('SELECT string_agg(id::text || coalesce(token_hash, \'-\') || coalesce(expires_at::text, \'-\'), \',\' ORDER BY id) FROM public.signature_signers'), before);
    // A signed signer is already signed.
    psql(`UPDATE public.signature_signers SET status = 'signed', signed_at = now() WHERE id = '${SIGNER_HOME}'`);
    assert.deepEqual(portal(PORTAL_TOKEN, SIGNER_HOME), { ok: false, error: 'already_signed' });
  } finally {
    pg.stop();
  }
});
