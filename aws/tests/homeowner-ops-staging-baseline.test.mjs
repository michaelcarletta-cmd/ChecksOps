/**
 * Accepted Homeowner Ops staging baseline after SQL73.
 * Source and evidence only. Does not deploy, mutate staging, or rewrite SQL73.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  normalizeHomeownerLedgerView,
  pendingEndorsementsForHomeowner,
  runHomeownerLedgerView,
} from '../functions/api/homeowner.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha256 = (rel) => createHash('sha256').update(read(rel), 'utf8').digest('hex');

const EVIDENCE_REL = 'ops/deployment-guard/homeowner-ops-staging-accepted.json';
const SQL73_REL = 'aws/workflows/sql/73_homeowner_ledger_view_last_viewed_best_effort.sql';
const SQL72_REL = 'aws/workflows/sql/72_homeowner_ledger_view_claim_ok.sql';
const HOMEOWNER_REL = 'aws/functions/api/homeowner.mjs';
const PAGE_REL = 'src/pages/HomeownerLedger.tsx';
const APP_REL = 'src/App.tsx';
const REQUIRED_INVARIANTS = [
  'SQL73 source bytes remain exactly the accepted staging function',
  'claim_ok remains the SQL72 org_id or same-tenant check or same-tenant event rule',
  'pending_signatures remains [] until a claim-scoped signing mint exists',
  'handleHomeownerLedgerSignLink stays disabled as unrestricted remint',
  'valid Homeowner ledger token still loads mode=claim',
  'live /h/ledger/:token and legacy /ledger/:token both remain',
  'homeowner.mjs send URL continues to mint /h/ledger/:token',
  'unrelated Branding, Mortgage, ChecksOps, and production fingerprints stay untouched',
  'later Homeowner work is a forward change from this composition',
];

const CLAIM = '398df4b8-f23a-476f-b856-ff864a4148b8';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';

function loadEvidence() {
  return JSON.parse(read(EVIDENCE_REL));
}

function loadContract() {
  const registry = JSON.parse(read('ops/deployment-guard/accepted-contracts.json'));
  return (registry.contracts || []).find((row) => row.id === 'homeowner-ops-staging');
}

test('accepted Homeowner Ops staging evidence pins the SQL73 composition', () => {
  const evidence = loadEvidence();
  assert.equal(evidence.accepted, true);
  assert.equal(evidence.environment, 'staging');
  assert.equal(evidence.production_changed, false);
  assert.equal(evidence.behavior.sql73_rewritten, false);
  assert.equal(evidence.behavior.application_functionality_changed_by_lock, false);
  assert.equal(evidence.behavior.pending_signatures_forced_empty, true);
  assert.equal(evidence.behavior.handleHomeownerLedgerSignLink_disabled, true);
  assert.equal(evidence.manual_uat.claim_number, '695064-GQ');
  assert.equal(evidence.manual_uat.claim_id, CLAIM);
  assert.equal(evidence.manual_uat.tenant_id, TENANT);
  assert.equal(evidence.manual_uat.public_token_rpc_invoked_by_this_lock, false);
  assert.equal(evidence.staging_fingerprints.spa_entry, '/assets/index-BomgsBaq.js');
  assert.equal(
    evidence.staging_fingerprints.index_html_sha256,
    '2186175d03b33bf9faae9b142b9f8e386b467027407623a773bd0fb0d1b6785b',
  );
  assert.equal(
    evidence.staging_fingerprints.homeowner_chunk,
    '/assets/HomeownerLedger-cDMDKYsn.js',
  );
  assert.equal(
    evidence.staging_fingerprints.api_lambda_sha256,
    'wzp8UfI+GhlpIbChnOOFODUGCQtnsV//bRdh8ZSS2YA=',
  );
  assert.equal(
    evidence.staging_fingerprints.homeowner_mjs_sha256,
    'fa995062af8b98b2da298e2636606e9bb9726b3c25d6df3c800252dd59362dfd',
  );
  assert.equal(
    evidence.staging_fingerprints.sql_executor_sha256,
    'SYnnbN5P9+3lJJeTRdMU9F1K/Lb8NPAYsEcAH5JpM8s=',
  );
  assert.equal(
    evidence.staging_fingerprints.sql73_source_sha256,
    '02a19f8ef11cb3e60122b1ff1e07dd331f95a677d13028564d497ef06e523c9e',
  );
  assert.equal(
    evidence.staging_fingerprints.sql73_live_function_sha256,
    '42c83390575d90d39326aee61ccaf87851fd5320e278d6c7f687137245b62166',
  );
  assert.equal(
    evidence.unrelated_fingerprints.production_api_sha256,
    'CWB8lxnHoqANyVcaNpKL7h4MtDSPMlHZ6wliFuGE6yA=',
  );
  assert.equal(evidence.unrelated_fingerprints.production_spa_entry, '/assets/index-HXTuSrE0.js');
  for (const invariant of REQUIRED_INVARIANTS) {
    assert.ok(evidence.invariants.includes(invariant), invariant);
  }
});

test('homeowner-ops-staging registry entry is complete enough for future deploys', () => {
  const contract = loadContract();
  const evidence = loadEvidence();
  assert.ok(contract, 'homeowner-ops-staging contract missing');
  assert.equal(contract.accepted, true);
  assert.equal(contract.enabled, true);
  assert.equal(contract.test, 'aws/tests/homeowner-ops-staging-baseline.test.mjs');
  assert.equal(contract.evidence, EVIDENCE_REL);
  assert.deepEqual(contract.environments, ['staging']);
  for (const type of ['spa-promote', 'lambda-overlay', 'sql-apply', 'sql-executor-invoke']) {
    assert.ok(contract.deployment_types.includes(type), type);
  }
  for (const invariant of REQUIRED_INVARIANTS) {
    assert.ok(contract.invariants.includes(invariant), invariant);
  }
  assert.deepEqual(
    contract.invariants.filter((row) => evidence.invariants.includes(row)).sort(),
    [...REQUIRED_INVARIANTS].sort(),
  );
  for (const rel of contract.tests || []) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
  }
});

test('SQL73 source remains the accepted staging function and still forces pending_signatures empty', () => {
  const evidence = loadEvidence();
  assert.equal(sha256(SQL73_REL), evidence.source_pins.sql73_source_sha256);
  assert.equal(sha256(SQL73_REL), evidence.staging_fingerprints.sql73_source_sha256);
  const sql73 = read(SQL73_REL);
  const sql72 = read(SQL72_REL);
  assert.match(sql73, /CREATE OR REPLACE FUNCTION public\.aws_public_homeowner_ledger_by_token\(p_token text\)/);
  assert.match(sql73, /Does NOT rewrite historical aws\/workflows\/sql\/72_homeowner_ledger_view_claim_ok\.sql/);
  assert.match(sql73, /pending_signatures', '\[\]'::jsonb/);
  assert.match(sql73, /handleHomeownerLedgerSignLink is not/);
  assert.match(sql73, /i\.check_stage::text/);
  assert.match(sql73, /EXCEPTION\s+WHEN OTHERS/);
  const claimOk72 = sql72.slice(sql72.indexOf('claim_ok :='), sql72.indexOf('IF NOT claim_ok'));
  const claimOk73 = sql73.slice(sql73.indexOf('claim_ok :='), sql73.indexOf('IF NOT claim_ok'));
  assert.equal(claimOk73, claimOk72);
});

test('homeowner handler still mints /h/ledger and keeps remint disabled', () => {
  const evidence = loadEvidence();
  assert.equal(
    evidence.source_pins.homeowner_handler_sha256,
    'fa995062af8b98b2da298e2636606e9bb9726b3c25d6df3c800252dd59362dfd',
  );
  assert.notEqual(sha256(HOMEOWNER_REL), evidence.source_pins.homeowner_handler_sha256);
  const handler = read(HOMEOWNER_REL);
  assert.match(handler, /\$\{origin\}\/h\/ledger\/\$\{tokenRow\.token\}/);
  assert.match(handler, /pending_signatures: \[\]/);
  assert.match(handler, /handleHomeownerLedgerSignLink is not/);
  assert.match(handler, /aws_public_homeowner_ledger_remint_signer/);
  assert.match(handler, /handleHomeownerLedgerEndorseLink/);
  assert.match(handler, /homeowner-ledger-endorse-link|runHomeownerLedgerEndorseLink/);
  const page = read(PAGE_REL);
  assert.match(page, /PendingEndorsementsPanel/);
  assert.match(page, /Checks awaiting signature/);
  assert.match(page, /Review & Sign Check/);
  assert.match(page, /homeowner-ledger-view/);
  assert.match(page, /homeowner-ledger-endorse-link/);
  const app = read(APP_REL);
  assert.match(app, /path="\/ledger\/:token"/);
  assert.match(app, /path="\/h\/ledger\/:token"/);
});

test('an existing valid Homeowner token still loads the ledger successfully', async () => {
  const doc = {
    ok: true,
    mode: 'claim',
    token: {
      id: 'tok-695064',
      tenant_id: TENANT,
      claim_id: CLAIM,
      homeowner_email: 'homeowner@example.com',
      homeowner_name: 'Freedom Homeowner',
    },
    homeowner: { name: 'Freedom Homeowner', email: 'homeowner@example.com' },
    claim: {
      id: CLAIM,
      claim_number: '695064-GQ',
      property_address: '1 Oak St',
      loss_type: 'wind',
    },
    events: [{ id: 'evt-1', event_type: 'check_received', amount: 7040.8 }],
    totals: { received: 22395.58, deposited: 0, released: 0, remaining: 22395.58 },
    pending_signatures: [{ request_id: 'must-not-leak' }],
    pending_endorsements: [{
      check_id: '00062a57-13b5-493d-a996-cf6e72d5cc89',
      check_number: '1001',
      check_amount: 7040.8,
      parties: [
        {
          endorsement_id: 'e-insured',
          payee_name: 'Freedom Homeowner',
          payee_type: 'insured',
          status: 'sent',
          is_homeowner: true,
          sign_url: '/endorse?token=endorsement-token',
        },
        {
          endorsement_id: 'e-mortgage',
          payee_name: 'Mortgage Co',
          payee_type: 'mortgage_company',
          status: 'sent',
          is_homeowner: false,
          sign_url: null,
        },
      ],
    }],
    money: { wallet_balance: 99, routing_number: '021000021' },
    allow_deductible_payment: true,
  };

  const result = await runHomeownerLedgerView({
    token: 'existing-valid-homeowner-token',
    spoof: {},
    client: {
      query: async (sql) => {
        assert.match(sql, /aws_public_homeowner_ledger_by_token/);
        return { rows: [{ doc }] };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.mode, 'claim');
  assert.equal(result.claim.claim_number, '695064-GQ');
  assert.equal(result.claim.id, CLAIM);
  assert.deepEqual(result.pending_signatures, []);
  assert.equal(result.pending_endorsements.length, 1);
  assert.equal(result.pending_endorsements[0].parties[0].payee_type, 'insured');
  assert.equal(result.pending_endorsements[0].parties[0].sign_url, null);
  assert.equal(result.pending_endorsements[0].parties[0].can_sign, true);
  assert.equal(result.pending_endorsements[0].parties[1].payee_type, 'mortgage_company');
  assert.equal(result.pending_endorsements[0].parties[1].sign_url, null);
  assert.equal(result.money, null);
  assert.equal(result.allow_deductible_payment, false);
  const encoded = JSON.stringify(result);
  assert.doesNotMatch(encoded, /wallet|routing_number|must-not-leak/i);

  const normalized = normalizeHomeownerLedgerView(doc);
  assert.deepEqual(normalized.pending_signatures, []);
  assert.equal(normalized.mode, 'claim');
});

test('homeowner endorsement helper still withholds mortgage/other payee sign URLs', () => {
  const pending = pendingEndorsementsForHomeowner({
    checks: [{ id: 'chk-1', check_number: '9', amount: 10 }],
    homeowner: { name: 'Ada Lovelace', email: 'ada@example.com' },
    endorsements: [
      {
        id: 'ins',
        check_id: 'chk-1',
        payee_type: 'insured',
        payee_name: 'Ada Lovelace',
        contact_email: 'ada@example.com',
        status: 'sent',
        request_sent_at: '2026-10-01T00:00:00Z',
        token: 'ins-token',
      },
      {
        id: 'mtg',
        check_id: 'chk-1',
        payee_type: 'mortgage_company',
        payee_name: 'Bank',
        status: 'sent',
        request_sent_at: '2026-10-01T00:00:00Z',
        token: 'mtg-token',
      },
      {
        id: 'pa',
        check_id: 'chk-1',
        payee_type: 'public_adjuster',
        payee_name: 'PA',
        status: 'sent',
        token: 'pa-token',
      },
    ],
  });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].parties.length, 2);
  assert.equal(pending[0].parties[0].sign_url, null);
  assert.equal(pending[0].parties[0].can_sign, true);
  assert.equal(pending[0].parties[1].sign_url, null);
  assert.doesNotMatch(JSON.stringify(pending), /ins-token|mtg-token|pa-token/);
});
