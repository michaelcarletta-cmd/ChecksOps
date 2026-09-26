import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ACCEPTED_FREEDOM_FROM,
  FORBIDDEN_SIGNATURE_FROM,
  HISTORICAL_PRE_FIX_ESIGN_SHA256,
  HISTORICAL_PRE_FIX_FIXTURE,
  SIGNATURE_SENDER_ENTRY_CONTRACTS,
  SIGNATURE_SENDER_LIVE_LAMBDA_PIN,
  SIGNATURE_SENDER_SOURCE_PIN,
  assertForbiddenFromHeaders,
  assertNotHistoricalEsignHash,
  assertSignatureSenderLambdaPin,
  assertSignatureSenderSource,
  assertSignatureSenderSourcePin,
  expectedSignatureFrom,
} from '../../scripts/lib/signature-sender-freeze.mjs';
import {
  PROTECTED_FILE_LABELS,
  assertAllowlistOnly,
  assertToctou,
  buildOverlayCandidate,
  evaluateOverlayCandidate,
} from '../../scripts/lib/lambda-overlay-guard.mjs';
import { resolveEmailBranding } from '../functions/api/email-branding.mjs';
import { runSendSignatureRequest } from '../functions/api/esign.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '../..');

const sha256File = (filePath) => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const write = (dir, name, body) => {
  const dest = path.join(dir, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body);
  return dest;
};

const makeZip = (dir, files, dest) => {
  const src = path.join(dir, 'src');
  fs.mkdirSync(src, { recursive: true });
  for (const [name, body] of Object.entries(files)) write(src, name, body);
  execFileSync('python3', ['-c', `
import zipfile
z=zipfile.ZipFile(${JSON.stringify(dest)},'w')
${Object.keys(files).map((name) => `z.write(${JSON.stringify(path.join(src, name))}, ${JSON.stringify(name)})`).join('\n')}
z.close()
`]);
  return dest;
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sig-sender-freeze-'));

const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C = '4f172140-f57a-4744-8050-95f4f07b13b4';
const USER = '55555555-5555-4555-8555-555555555555';
const CLAIM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQUEST_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SIGNER_A = '11111111-1111-4111-8111-111111111111';

const tenants = {
  [FREEDOM]: {
    name: 'Freedom Adjustment',
    logo_url: null,
    primary_color: '#1a4993',
    is_system_tenant: false,
    email_from_name: null,
    email_from_address: null,
    email_reply_to: 'claims@freedomadj.com',
  },
  [C1C]: {
    name: 'Condition One Commercial',
    logo_url: null,
    primary_color: '#3B82F6',
    is_system_tenant: false,
    email_from_name: null,
    email_from_address: null,
    email_reply_to: 'ops@c1c.example',
  },
};

const sqlClient = (handlers) => ({
  query: async (sql, params = []) => {
    const compact = String(sql).replace(/\s+/g, ' ');
    for (const handler of handlers) {
      if (handler.match(compact, params)) return handler.result(params, compact);
    }
    return { rows: [], rowCount: 0 };
  },
});

const capturingMailer = (sent) => async (payload) => {
  sent.push(payload);
  return { deliveredCount: 0, sunkCount: 1, mode: 'sink', results: [{ delivery: 'sink', messageId: 'sink-1' }] };
};

test('freeze records accepted live provenance and does not pin whole-Lambda rollback', () => {
  const freeze = JSON.parse(fs.readFileSync(path.join(REPO, 'aws/audit/signature-sender-production-freeze.json'), 'utf8'));
  assert.equal(freeze.status, 'PRODUCTION_ACCEPTED');
  assert.equal(freeze.production_application_state_changed_by_this_workstream, false);
  assert.equal(freeze.lambda.function_name, 'checksops-production-prep-api');
  assert.equal(freeze.lambda.CodeSha256, '9OLR9DMhuDrAUp5/TmT6+8bfQC2I6USFk+zwFkluJLQ=');
  assert.equal(freeze.lambda.RevisionId, 'a6a23fc9-a7cb-4e7c-b1c8-db9cb80ea150');
  assert.equal(freeze.lambda.package_sha256, 'f4e2d1f43321b83ac0529e7f4e64fafbc6df402d88e9448593ecf016496e24b4');
  assert.equal(freeze.lambda.provenance_only, true);
  assert.equal(freeze.lambda.not_a_whole_lambda_rollback_pin, true);
  assert.equal(freeze.lambda.future_legitimate_overlays_may_change_codesha256, true);
  assert.equal(freeze.protected_files['esign.mjs'], SIGNATURE_SENDER_LIVE_LAMBDA_PIN.sha256);
  assert.equal(freeze.source_files['aws/functions/api/esign.mjs'], SIGNATURE_SENDER_SOURCE_PIN.sha256);
  assert.equal(freeze.historical_restoration_forbidden['esign.mjs'], HISTORICAL_PRE_FIX_ESIGN_SHA256);
  assert.equal(freeze.accepted_signature_sender.behavior_still_live, true);
  assert.equal(freeze.accepted_signature_sender.contract.freedom_example, ACCEPTED_FREEDOM_FROM);
  assert.equal(freeze.overlay_rule.do_not_require_historical_lambda_codesha256, true);
  assert.match(freeze.overlay_rule.unauthorized_change, /allowlist esign\.mjs/);
  assert.equal(freeze.spa.untouched_by_this_workstream, true);
  assert.equal(freeze.spa.accepted_r4a.index_sha256, '6b211037ae70b510a9b5cfe316f006dbbc308ee3c94687ccea943b24cfd09f2e');
  assert.equal(freeze.spa.accepted_r4a.index_version_id, 'advEv5N0JfqM41odUraOM7kCH6Z2snP3');
  assert.equal(freeze.spa.fresh_read.index_sha256, freeze.spa.accepted_r4a.index_sha256);
  assert.equal(freeze.spa.fresh_read.index_version_id, freeze.spa.accepted_r4a.index_version_id);
});

test('workspace esign.mjs still matches the accepted sender pin', () => {
  const pinned = assertSignatureSenderSourcePin(REPO);
  assert.equal(pinned.ok, true, pinned.errors.join('\n'));
  assert.equal(sha256File(path.join(REPO, SIGNATURE_SENDER_SOURCE_PIN.path)), SIGNATURE_SENDER_SOURCE_PIN.sha256);
});

test('forbidden signature From headers fail the contract', () => {
  assert.equal(assertForbiddenFromHeaders(ACCEPTED_FREEDOM_FROM).ok, true);
  assert.equal(assertForbiddenFromHeaders(expectedSignatureFrom('Condition One Commercial')).ok, true);
  for (const forbidden of FORBIDDEN_SIGNATURE_FROM) {
    const result = assertForbiddenFromHeaders(forbidden);
    assert.equal(result.ok, false, forbidden);
  }
  assert.equal(assertForbiddenFromHeaders('Acme <billing@example.com>').ok, false);
});

test('overlay guard labels esign.mjs as a protected file that must be allowlisted', () => {
  assert.equal(PROTECTED_FILE_LABELS['esign.mjs'], 'signature-request sender contract');
  const blocked = assertAllowlistOnly(['esign.mjs'], ['storage.mjs']);
  assert.equal(blocked.ok, false);
  assert.match(blocked.errors.join(' '), /esign\.mjs/);
  const allowed = assertAllowlistOnly(['esign.mjs'], ['esign.mjs']);
  assert.equal(allowed.ok, true);
});

test('unauthorized overlay that mutates esign.mjs is rejected', () => {
  const dir = tmp();
  const accepted = fs.readFileSync(path.join(REPO, SIGNATURE_SENDER_SOURCE_PIN.path));
  const live = makeZip(dir, {
    'esign.mjs': accepted,
    'other.mjs': 'keep-me',
  }, path.join(dir, 'live.zip'));
  const cand = makeZip(dir, {
    'esign.mjs': 'tampered sender',
    'other.mjs': 'keep-me',
  }, path.join(dir, 'cand.zip'));
  const result = evaluateOverlayCandidate({
    liveZip: live,
    candidateZip: cand,
    allowlist: [],
    protectedHashes: { 'esign.mjs': SIGNATURE_SENDER_LIVE_LAMBDA_PIN.sha256 },
    entryContracts: SIGNATURE_SENDER_ENTRY_CONTRACTS,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /unauthorized file differs: esign\.mjs|protected invariant broken: esign\.mjs/);
});

test('authorized overlay of a different file keeps esign.mjs byte-identical', () => {
  const dir = tmp();
  const accepted = fs.readFileSync(path.join(REPO, SIGNATURE_SENDER_SOURCE_PIN.path));
  const live = makeZip(dir, {
    'esign.mjs': accepted,
    'other.mjs': 'keep-me',
  }, path.join(dir, 'live.zip'));
  const replacement = write(dir, 'other.mjs', 'other v2');
  const dest = path.join(dir, 'cand.zip');
  const built = buildOverlayCandidate({
    liveZip: live,
    destZip: dest,
    replacements: { 'other.mjs': replacement },
    allowlist: ['other.mjs'],
    protectedHashes: { 'esign.mjs': SIGNATURE_SENDER_LIVE_LAMBDA_PIN.sha256 },
    livePin: {},
    entryContracts: SIGNATURE_SENDER_ENTRY_CONTRACTS,
  });
  assert.equal(built.ok, true, built.errors.join('\n'));
  assert.deepEqual(built.changed, ['other.mjs']);
  const hashes = JSON.parse(execFileSync('python3', [
    path.join(REPO, 'scripts/lib/zip-package.py'), 'hashes', dest,
  ], { encoding: 'utf8' }));
  assert.equal(assertSignatureSenderLambdaPin(hashes).ok, true);
});

test('historical pre-fix esign.mjs is rejected even when explicitly allowlisted', () => {
  const dir = tmp();
  const accepted = fs.readFileSync(path.join(REPO, SIGNATURE_SENDER_SOURCE_PIN.path));
  const historical = fs.readFileSync(path.join(REPO, HISTORICAL_PRE_FIX_FIXTURE));
  assert.equal(sha256File(path.join(REPO, HISTORICAL_PRE_FIX_FIXTURE)), HISTORICAL_PRE_FIX_ESIGN_SHA256);
  const live = makeZip(dir, {
    'esign.mjs': accepted,
    'other.mjs': 'keep-me',
  }, path.join(dir, 'live.zip'));
  const dest = path.join(dir, 'cand.zip');
  const built = buildOverlayCandidate({
    liveZip: live,
    destZip: dest,
    replacements: { 'esign.mjs': path.join(REPO, HISTORICAL_PRE_FIX_FIXTURE) },
    allowlist: ['esign.mjs'],
    protectedHashes: { 'esign.mjs': SIGNATURE_SENDER_LIVE_LAMBDA_PIN.sha256 },
    livePin: {},
    entryContracts: SIGNATURE_SENDER_ENTRY_CONTRACTS,
  });
  assert.equal(built.ok, false);
  const text = built.errors.join('\n');
  assert.match(text, /historical pre-fix hash|pre-fix sender assignment|missing signature-sender marker/);
  const hashCheck = assertNotHistoricalEsignHash(sha256File(path.join(REPO, HISTORICAL_PRE_FIX_FIXTURE)));
  assert.equal(hashCheck.ok, false);
  const sourceCheck = assertSignatureSenderSource(historical.toString('utf8'), {
    hash: HISTORICAL_PRE_FIX_ESIGN_SHA256,
  });
  assert.equal(sourceCheck.ok, false);
  assert.match(sourceCheck.errors.join(' '), /37c5c742|mailFrom = resolved\.from|signatureRequestFromHeader/);
});

test('TOCTOU still fails when CodeSha256 or RevisionId moves', () => {
  const shaMoved = assertToctou(
    { CodeSha256: 'AAA=', RevisionId: 'rev-1' },
    { CodeSha256: 'BBB=', RevisionId: 'rev-1' },
  );
  assert.equal(shaMoved.ok, false);
  const revMoved = assertToctou(
    { CodeSha256: 'AAA=', RevisionId: 'rev-1' },
    { CodeSha256: 'AAA=', RevisionId: 'rev-2' },
  );
  assert.equal(revMoved.ok, false);
});

test('Reply-To stays independent of the From-header contract', async () => {
  const sent = [];
  const result = await runSendSignatureRequest({
    mapping: { application_user_id: USER },
    spoof: { ignored: true },
    body: { requestId: REQUEST_A, tenantId: C1C },
    send: capturingMailer(sent),
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.signature_requests'),
        result: () => ({ rows: [{ id: REQUEST_A, document_name: 'Release', claim_id: CLAIM_A, field_data: [] }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.signature_signers'),
        result: () => ({ rows: [{ id: SIGNER_A, signer_name: 'Ada', signer_email: 'ada@freedomadj.com' }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.claims'),
        result: () => ({ rows: [{ id: CLAIM_A, claim_number: 'CL-1', policyholder_name: 'Ada', tenant_id: FREEDOM }] }),
      },
      {
        match: (sql) => sql.includes('aws_can_write_tenant'),
        result: (params) => ({ rows: [{ ok: params[0] === FREEDOM }] }),
      },
      {
        match: (sql) => sql.includes('company_branding'),
        result: () => ({ rows: [{ esign_email_subject: 'Sign {document.name}', esign_email_body: 'Please sign.' }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.tenants'),
        result: (params) => ({ rows: tenants[params[0]] ? [tenants[params[0]]] : [] }),
      },
      {
        match: (sql) => sql.includes('tenant_email_settings'),
        result: () => ({ rows: [] }),
      },
    ]),
  });
  assert.equal(result.ok, true);
  assert.equal(sent[0].from, ACCEPTED_FREEDOM_FROM);
  assert.equal(sent[0].replyTo, 'claims@freedomadj.com');
  assert.notEqual(sent[0].from, sent[0].replyTo);
  assert.doesNotMatch(sent[0].from, /claims@freedomadj\.com/);
});

test('shared resolveEmailBranding is not required to drop via ChecksOps globally', async () => {
  const branding = await resolveEmailBranding(sqlClient([
    {
      match: (sql) => sql.includes('FROM public.tenants'),
      result: () => ({ rows: [tenants[FREEDOM]] }),
    },
    {
      match: (sql) => sql.includes('tenant_email_settings'),
      result: () => ({ rows: [] }),
    },
  ]), { tenantId: FREEDOM });
  assert.match(branding.from, /Freedom Adjustment via ChecksOps/);
  assert.notEqual(branding.from, ACCEPTED_FREEDOM_FROM);
});
