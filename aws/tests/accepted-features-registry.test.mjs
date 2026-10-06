/**
 * Evaluate-only accepted-feature registry adversarial tests.
 * Tests pass by asserting findings. They do not block merge/deploy.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CODES,
  detectUnauthorizedSupersession,
  evaluateAcceptedFeatures,
  evaluateForDeployGuard,
  evaluateRepo,
  loadRegistry,
  rejectSelfAttestation,
  validateRegistry,
} from '../../scripts/lib/accepted-features.mjs';
import { main as validateMain } from '../../scripts/validate-accepted-features.mjs';
import {
  computeOwnershipHashes,
  loadJson,
  matchProtectedPath,
} from '../../scripts/lib/release-locks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NEW_FILES = [
  'ops/accepted-features/schema/registry.schema.json',
  'ops/accepted-features/registry.json',
  'ops/accepted-features/README.md',
  'ops/accepted-features/OPERATOR.md',
  'scripts/lib/accepted-features.mjs',
  'scripts/validate-accepted-features.mjs',
  'aws/tests/accepted-features-registry.test.mjs',
];

function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function writeTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accepted-features-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return dir;
}

function enforcement() {
  return {
    enabled: false,
    block_merge: false,
    block_deploy: false,
    accept_self_attestation: false,
  };
}

function authority(overrides = {}) {
  return {
    kind: 'inventory_note',
    git_sha: null,
    merged_pr: null,
    evidence_path: null,
    restore_authority: false,
    notes: 'test fixture',
    ...overrides,
  };
}

function acceptedAuthority(overrides = {}) {
  return authority({
    kind: 'accepted_source',
    git_sha: SHA,
    restore_authority: true,
    ...overrides,
  });
}

function feature(overrides = {}) {
  return {
    feature_id: 'fixture-ui',
    title: 'Fixture UI',
    status: 'accepted',
    workstream_id: 'fixture-workstream',
    accepted_source_authority: acceptedAuthority(),
    source_paths: ['src/components/FixtureWidget.tsx'],
    semantic_invariants: [
      {
        id: 'fixture-widget-mounted',
        kind: 'source_marker',
        title: 'Fixture widget remains mounted',
        file: 'src/components/FixtureWidget.tsx',
        must_match: '<FixtureWidget',
      },
    ],
    required_tests: ['aws/tests/fixture-widget.test.mjs'],
    applicable_artifact_types: ['spa'],
    supersession_history: [],
    ...overrides,
  };
}

function registry(features, overrides = {}) {
  return {
    version: 1,
    evaluate_only: true,
    enforcement: enforcement(),
    features,
    ...overrides,
  };
}

function boundAttestation(testRel = 'aws/tests/fixture-widget.test.mjs') {
  return {
    ok: true,
    test_execution: {
      test: testRel,
      candidate_commit: SHA,
      exit_code: 0,
      output_sha256: sha256('real test output'),
    },
  };
}

const ACCEPTED_WIDGET = `export function Host() {\n  return <FixtureWidget showFlag={false} />;\n}\n`;
const LAMBDA_ROUTE = `export async function handleFixtureRoute(event) {\n  return { ok: true };\n}\n`;
const SQL_CONTRACT = `CREATE OR REPLACE FUNCTION fixture_contract() RETURNS void AS $$ BEGIN NULL; END; $$ LANGUAGE plpgsql;\n`;

test('live registry is evaluate-only, has no accepted features, and Branding intended invariants are satisfied', () => {
  const live = loadRegistry(ROOT);
  const schema = validateRegistry(live);
  assert.equal(schema.ok, true, schema.errors.join('; '));
  assert.equal(live.evaluate_only, true);
  assert.equal(live.enforcement.enabled, false);
  assert.equal(live.enforcement.block_merge, false);
  assert.equal(live.enforcement.block_deploy, false);
  assert.equal(live.enforcement.accept_self_attestation, false);
  assert.equal(live.features.some((row) => row.status === 'accepted'), false);
  assert.equal(live.features.every((row) => row.accepted_source_authority.restore_authority === false), true);

  const result = evaluateRepo(ROOT);
  assert.equal(result.evaluate_only, true);
  assert.equal(result.blocking, false);
  assert.equal(result.exit_code, 0);
  assert.deepEqual(result.expected_accepted, []);
  assert.ok(result.inventory_only.includes('branding'));
  assert.ok(result.missing_from_main.includes('invoice-recovery'));
  assert.ok(result.missing_from_main.includes('collection-v2'));

  const branding = result.features.find((row) => row.feature_id === 'branding');
  assert.ok(branding);
  assert.equal(branding.status, 'inventory_only');
  assert.deepEqual(branding.failing_invariants, []);
  for (const id of [
    'branding-company-mounted',
    'branding-tenant-email-mounted',
    'branding-tenant-show-sending-domain-false',
    'branding-tenant-sending-subdomain-hidden',
    'branding-admin-branding-email-present',
    'branding-admin-email-sender-mounted',
    'branding-public-url-resolver',
    'branding-email-preview-api-public-logo',
    'branding-email-preview-spa-apply-logo',
    'branding-email-preview-iframe-srcdoc',
    'branding-email-preview-public-logo',
    'branding-intended-invariants',
  ]) {
    assert.ok(branding.passed_invariants.includes(id), id);
  }
  const brandingFeature = live.features.find((row) => row.feature_id === 'branding');
  assert.ok(brandingFeature.required_tests.includes('aws/tests/email-preview-logo-url.test.mjs'));
  assert.ok(fs.existsSync(path.join(ROOT, 'aws/tests/email-preview-logo-url.test.mjs')));
  assert.equal(result.findings.some((row) => row.feature_id === 'branding'), false);
});

test('evaluate-only CLI reports no Branding findings and cannot block, including --enforce', () => {
  const proc = spawnSync(process.execPath, [
    'scripts/validate-accepted-features.mjs',
    '--json',
    '--enforce',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(proc.status, 0);
  const payload = JSON.parse(proc.stdout);
  assert.equal(payload.evaluate_only, true);
  assert.equal(payload.blocking, false);
  assert.equal(payload.exit_code, 0);
  assert.equal(payload.findings.some((row) => row.feature_id === 'branding'), false);
  const branding = payload.features.find((row) => row.feature_id === 'branding');
  assert.ok(branding);
  assert.equal(branding.status, 'inventory_only');
  assert.deepEqual(branding.failing_invariants, []);
  assert.match(proc.stderr, /--enforce is ignored/);
  assert.equal(validateMain(['--json'], ROOT), 0);
});

test('detects accepted UI component removed', () => {
  const root = writeTree({ 'src/components/FixtureWidget.tsx': ACCEPTED_WIDGET });
  const result = evaluateAcceptedFeatures({
    root,
    registry: registry([feature()]),
    overlay: { 'src/components/FixtureWidget.tsx': 'export function Host() { return <Other /> }\n' },
  });
  assert.ok(result.findings.some((row) => (
    row.code === CODES.INVARIANT_FAILED && row.invariant_id === 'fixture-widget-mounted'
  )));
  assert.equal(result.blocking, false);
});

test('detects semantic prop changed or removed', () => {
  const root = writeTree({
    'src/components/FixtureWidget.tsx': 'export function Host() { return <EmailSenderSettings showSendingDomain={false} /> }\n',
  });
  const result = evaluateAcceptedFeatures({
    root,
    registry: registry([feature({
      semantic_invariants: [{
        id: 'show-sending-domain-false',
        kind: 'source_marker',
        title: 'tenant mount uses showSendingDomain={false}',
        file: 'src/components/FixtureWidget.tsx',
        must_match: 'showSendingDomain=\\{false\\}',
      }],
    })]),
    overlay: {
      'src/components/FixtureWidget.tsx': 'export function Host() { return <EmailSenderSettings /> }\n',
    },
  });
  assert.ok(result.findings.some((row) => (
    row.code === CODES.INVARIANT_FAILED && row.invariant_id === 'show-sending-domain-false'
  )));
});

test('detects Lambda route/member removed', () => {
  const root = writeTree({ 'aws/functions/api/fixture-route.mjs': LAMBDA_ROUTE });
  const result = evaluateAcceptedFeatures({
    root,
    registry: registry([feature({
      feature_id: 'fixture-lambda',
      source_paths: ['aws/functions/api/fixture-route.mjs'],
      semantic_invariants: [{
        id: 'fixture-lambda-export',
        kind: 'lambda_member',
        title: 'fixture route export remains',
        file: 'aws/functions/api/fixture-route.mjs',
        must_export: 'handleFixtureRoute',
      }],
      applicable_artifact_types: ['lambda'],
    })]),
    overlay: { 'aws/functions/api/fixture-route.mjs': null },
  });
  assert.ok(result.findings.some((row) => (
    row.code === CODES.FEATURE_MISSING && row.invariant_id === 'fixture-lambda-export'
  )));
});

test('detects SQL contract removed', () => {
  const root = writeTree({ 'aws/rls/sql/99_fixture_contract.sql': SQL_CONTRACT });
  const result = evaluateAcceptedFeatures({
    root,
    registry: registry([feature({
      feature_id: 'fixture-sql',
      source_paths: ['aws/rls/sql/99_fixture_contract.sql'],
      semantic_invariants: [{
        id: 'fixture-sql-fn',
        kind: 'sql_contract',
        title: 'fixture SQL contract remains',
        file: 'aws/rls/sql/99_fixture_contract.sql',
        must_match: 'fixture_contract',
      }],
      applicable_artifact_types: ['sql'],
    })]),
    overlay: { 'aws/rls/sql/99_fixture_contract.sql': 'SELECT 1;\n' },
  });
  assert.ok(result.findings.some((row) => (
    row.code === CODES.INVARIANT_FAILED && row.invariant_id === 'fixture-sql-fn'
  )));
});

test('allows legitimate forward edits when accepted behavior remains intact', () => {
  const root = writeTree({ 'src/components/FixtureWidget.tsx': ACCEPTED_WIDGET });
  const result = evaluateAcceptedFeatures({
    root,
    registry: registry([feature()]),
    overlay: {
      'src/components/FixtureWidget.tsx': `${ACCEPTED_WIDGET}\nexport const unrelatedForwardImprovement = true;\n`,
    },
  });
  assert.equal(result.findings.some((row) => row.code === CODES.STALE_SOURCE), false);
  assert.equal(result.findings.some((row) => row.feature_id === 'fixture-ui'), false);
  assert.ok(result.present_accepted.includes('fixture-ui'));
});

test('detects required source path removed even when another invariant still passes', () => {
  const root = writeTree({
    'src/components/FixtureWidget.tsx': ACCEPTED_WIDGET,
    'src/components/RequiredHelper.ts': 'export const helper = true;\n',
  });
  const result = evaluateAcceptedFeatures({
    root,
    registry: registry([feature({
      source_paths: ['src/components/FixtureWidget.tsx', 'src/components/RequiredHelper.ts'],
    })]),
    overlay: { 'src/components/RequiredHelper.ts': null },
  });
  assert.ok(result.findings.some((row) => (
    row.code === CODES.FEATURE_MISSING
    && row.feature_id === 'fixture-ui'
    && row.details?.file === 'src/components/RequiredHelper.ts'
  )));
  assert.ok(result.missing_accepted.includes('fixture-ui'));
});

test('detects semantic contract changes even when invariant IDs are unchanged', () => {
  const previous = feature();
  const changedMarker = feature({
    semantic_invariants: [{
      ...previous.semantic_invariants[0],
      must_match: '<DifferentWidget',
    }],
  });
  const result = detectUnauthorizedSupersession(previous, changedMarker);
  assert.equal(result.ok, false);
  assert.equal(result.finding.code, CODES.UNAUTHORIZED_SUPERSESSION);
});

test('detects required-test changes without supersession', () => {
  const previous = feature();
  const changedTests = feature({
    required_tests: ['aws/tests/replacement.test.mjs'],
  });
  const result = detectUnauthorizedSupersession(previous, changedTests);
  assert.equal(result.ok, false);
  assert.equal(result.finding.code, CODES.UNAUTHORIZED_SUPERSESSION);
});

test('empty explicit composition cannot omit accepted features', () => {
  const root = writeTree({ 'src/components/FixtureWidget.tsx': ACCEPTED_WIDGET });
  const result = evaluateAcceptedFeatures({
    root,
    registry: registry([feature()]),
    composition: {
      candidate_commit: SHA,
      declared_feature_ids: [],
    },
  });
  assert.ok(result.findings.some((row) => row.code === CODES.COMPOSITION_GAP));
});

test('detects accepted workstream omitted from composition', () => {
  const root = writeTree({ 'src/components/FixtureWidget.tsx': ACCEPTED_WIDGET });
  const result = evaluateAcceptedFeatures({
    root,
    registry: registry([feature()]),
    composition: {
      accepted_source_composition: true,
      declared_feature_ids: ['unrelated-feature'],
    },
  });
  assert.ok(result.findings.some((row) => row.code === CODES.COMPOSITION_GAP));
  assert.ok(result.findings.some((row) => row.code === CODES.SELF_ATTESTATION_INSUFFICIENT));
  assert.equal(result.composition.boolean_flag_ignored, true);
  assert.deepEqual(result.expected_accepted, ['fixture-ui']);
  assert.deepEqual(result.present_accepted, ['fixture-ui']);
});

test('candidate own tests passing cannot hide another accepted feature failure', () => {
  const root = writeTree({
    'src/components/FixtureWidget.tsx': ACCEPTED_WIDGET,
    'src/components/OtherWidget.tsx': 'export function Other() { return <OtherWidget /> }\n',
  });
  const result = evaluateAcceptedFeatures({
    root,
    registry: registry([
      feature(),
      feature({
        feature_id: 'fixture-other',
        source_paths: ['src/components/OtherWidget.tsx'],
        semantic_invariants: [{
          id: 'other-mounted',
          kind: 'source_marker',
          title: 'other widget remains mounted',
          file: 'src/components/OtherWidget.tsx',
          must_match: '<OtherWidget',
        }],
      }),
    ]),
    attestation: boundAttestation(),
    overlay: { 'src/components/OtherWidget.tsx': 'export function Other() { return null }\n' },
  });
  assert.equal(result.attestation, 'not_used_or_bound');
  assert.ok(result.present_accepted.includes('fixture-ui'));
  assert.ok(result.missing_accepted.includes('fixture-other'));
  assert.ok(result.findings.some((row) => row.feature_id === 'fixture-other'));
});

test('detects Email Preview public-logo regression of the #709 contract', () => {
  const api = fs.readFileSync(path.join(ROOT, 'aws/functions/api/email-branding.mjs'), 'utf8');
  const broken = api
    .replaceAll('/storage/public?bucket=tenant-logos', '/prep/branding/logo')
    .replace(/logoUrl = publicTenantLogoUrl\(tenant\.logo_url\) \|\| platform\.logoUrl/, 'logoUrl = `/prep/branding/logo/${tenant.id}`');
  const result = evaluateRepo(ROOT, {
    overlay: { 'aws/functions/api/email-branding.mjs': broken },
  });
  const branding = result.features.find((row) => row.feature_id === 'branding');
  const failedIds = branding.failing_invariants.map((row) => row.invariant_id);
  assert.ok(failedIds.includes('branding-email-preview-api-public-logo'));
  assert.ok(failedIds.includes('branding-email-preview-public-logo'));
  assert.ok(failedIds.includes('branding-intended-invariants'));
  assert.ok(result.findings.some((row) => (
    row.code === CODES.INVARIANT_FAILED && row.invariant_id === 'branding-email-preview-public-logo'
  )));
  assert.ok(result.findings.some((row) => (
    row.code === CODES.INVARIANT_FAILED && row.invariant_id === 'branding-intended-invariants'
  )));
  assert.equal(result.evaluate_only, true);
  assert.equal(result.blocking, false);
  assert.equal(result.exit_code, 0);
});

test('Branding required-test binding includes email-preview-logo-url via existing evidence mechanism', () => {
  const live = loadRegistry(ROOT);
  const branding = live.features.find((row) => row.feature_id === 'branding');
  assert.ok(branding.required_tests.includes('aws/tests/email-preview-logo-url.test.mjs'));
  const acceptedClone = {
    ...branding,
    status: 'accepted',
    accepted_source_authority: acceptedAuthority({
      notes: 'test-only clone to exercise required_tests binding; not live authority',
    }),
  };
  const missing = evaluateAcceptedFeatures({
    root: ROOT,
    registry: registry([acceptedClone]),
    composition: { candidate_commit: SHA, declared_feature_ids: ['branding'] },
    attestation: { ok: true, test_executions: [] },
  });
  assert.ok(missing.findings.some((row) => (
    row.code === CODES.ATTESTATION_REJECTED
    && row.feature_id === 'branding'
    && String(row.message || '').includes('aws/tests/email-preview-logo-url.test.mjs')
  )));
  const bound = evaluateAcceptedFeatures({
    root: ROOT,
    registry: registry([acceptedClone]),
    composition: { candidate_commit: SHA, declared_feature_ids: ['branding'] },
    attestation: {
      ok: true,
      test_executions: branding.required_tests.map((testRel) => ({
        test: testRel,
        candidate_commit: SHA,
        exit_code: 0,
        output_sha256: sha256(`bound ${testRel}`),
      })),
    },
  });
  assert.equal(bound.findings.some((row) => (
    row.code === CODES.ATTESTATION_REJECTED
    && String(row.message || '').includes('aws/tests/email-preview-logo-url.test.mjs')
  )), false);
});

test('required test evidence must cover every accepted feature and candidate commit', () => {
  const root = writeTree({ 'src/components/FixtureWidget.tsx': ACCEPTED_WIDGET });
  const missing = evaluateAcceptedFeatures({
    root,
    registry: registry([feature()]),
    composition: { candidate_commit: SHA, declared_feature_ids: ['fixture-ui'] },
    attestation: { ok: true, test_executions: [] },
  });
  assert.ok(missing.findings.some((row) => (
    row.code === CODES.ATTESTATION_REJECTED && row.feature_id === 'fixture-ui'
  )));

  const wrongCommit = evaluateAcceptedFeatures({
    root,
    registry: registry([feature()]),
    composition: { candidate_commit: SHA_B, declared_feature_ids: ['fixture-ui'] },
    attestation: {
      ok: true,
      test_executions: [{
        test: 'aws/tests/fixture-widget.test.mjs',
        candidate_commit: SHA,
        exit_code: 0,
        output_sha256: sha256('real test output'),
      }],
    },
  });
  assert.ok(wrongCommit.findings.some((row) => (
    row.code === CODES.ATTESTATION_REJECTED && row.feature_id === 'fixture-ui'
  )));
});

test('rejects fake {ok:true} attestation', () => {
  const rejected = rejectSelfAttestation({ ok: true });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.finding.code, CODES.ATTESTATION_REJECTED);
  const result = evaluateAcceptedFeatures({
    root: ROOT,
    registry: loadRegistry(ROOT),
    attestation: { ok: true },
  });
  assert.equal(result.attestation, 'rejected');
  assert.ok(result.findings.some((row) => row.code === CODES.ATTESTATION_REJECTED));
  assert.equal(result.blocking, false);
});

test('detects unauthorized supersession and accepts an explicit record', () => {
  const previous = feature();
  const silentlyChanged = feature({
    semantic_invariants: [{
      id: 'changed-invariant',
      kind: 'source_marker',
      title: 'changed without history',
      file: 'src/components/FixtureWidget.tsx',
      must_match: '<Other',
    }],
  });
  const unauthorized = detectUnauthorizedSupersession(previous, silentlyChanged);
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.finding.code, CODES.UNAUTHORIZED_SUPERSESSION);

  const authorized = feature({
    semantic_invariants: silentlyChanged.semantic_invariants,
    supersession_history: [{
      from_feature_id: 'fixture-ui',
      from_authority: acceptedAuthority(),
      to_authority: acceptedAuthority({ git_sha: SHA_B }),
      reason: 'Intentional replacement of the fixture widget invariant after reviewed repair.',
      approving_workstream_id: 'fixture-supersession',
      review_pr: 9999,
      updated_invariant_ids: ['changed-invariant'],
      updated_tests: ['aws/tests/fixture-widget.test.mjs'],
      committed_at: '2026-10-05T00:00:00Z',
      commit: SHA_B,
    }],
  });
  const ok = detectUnauthorizedSupersession(previous, authorized);
  assert.equal(ok.ok, true);

  const evaluated = evaluateAcceptedFeatures({
    root: ROOT,
    registry: registry([silentlyChanged]),
    previous_registry: registry([previous]),
  });
  assert.ok(evaluated.findings.some((row) => row.code === CODES.UNAUTHORIZED_SUPERSESSION));
});

test('superseded features require an explicit history record', () => {
  const missingHistory = validateRegistry(registry([feature({
    status: 'superseded',
    accepted_source_authority: authority({ kind: 'supersession' }),
  })]));
  assert.equal(missingHistory.ok, false);
  assert.ok(missingHistory.errors.some((row) => /supersession_history/.test(row)));
});

test('inventory SHA cannot become restore authority', () => {
  const errors = validateRegistry(registry([feature({
    status: 'inventory_only',
    accepted_source_authority: authority({
      git_sha: SHA,
      restore_authority: true,
    }),
  })]));
  assert.equal(errors.ok, false);
  assert.ok(errors.errors.some((row) => /restore_authority may be true only when status is accepted/.test(row)));
});

test('evaluate-only deploy-guard hook never blocks and is not wired into writers', () => {
  const hook = evaluateForDeployGuard({
    accepted_source_composition: true,
    attestation: { ok: true },
    declared_feature_ids: [],
  }, { root: ROOT });
  assert.equal(hook.ok, true);
  assert.equal(hook.evaluate_only, true);
  assert.equal(hook.blocking, false);
  assert.equal(hook.code, null);

  const writers = [
    'scripts/deployment-guard/lib/guard.mjs',
    'scripts/deployment-guard/lib/contracts.mjs',
    'scripts/deployment-guard/lib/production.mjs',
    'scripts/deployment-guard/preflight.mjs',
    'scripts/deployment-guard/spa-promote.mjs',
    'scripts/deployment-guard/lambda-overlay.mjs',
    'scripts/production-deploy-guard.mjs',
  ];
  for (const rel of writers) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(src, /accepted-features\.mjs/);
    assert.doesNotMatch(src, /evaluateForDeployGuard/);
  }
});

test('foundation files stay outside Release Lock ownership groups and do not change lock hashes', () => {
  const protectedPaths = loadJson(path.join(ROOT, 'ops/release-locks/protected-paths.json'));
  const manifest = loadJson(path.join(ROOT, 'ops/release-locks/locked-components.json'));
  for (const rel of NEW_FILES) {
    assert.deepEqual(matchProtectedPath(rel, protectedPaths), [], rel);
  }
  const hashes = computeOwnershipHashes(ROOT, protectedPaths);
  for (const [id, component] of Object.entries(manifest.components || {})) {
    const current = hashes.groups[id];
    assert.ok(current, id);
    assert.equal(current.tree_hash, component.source.tree_hash, `${id} tree_hash must remain unchanged`);
  }
});

test('validator does not acquire leases, issue receipts, or mutate AWS/SQL artifacts', () => {
  const beforeReceipts = fs.existsSync(path.join(ROOT, '.deployment-guard'))
    ? fs.readdirSync(path.join(ROOT, '.deployment-guard'))
    : [];
  const proc = spawnSync(process.execPath, ['scripts/validate-accepted-features.mjs', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      AWS_ACCESS_KEY_ID: 'AKIA_SHOULD_NOT_BE_USED',
      AWS_SECRET_ACCESS_KEY: 'should-not-be-used',
      AWS_SESSION_TOKEN: 'should-not-be-used',
      CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: '',
    },
  });
  assert.equal(proc.status, 0);
  const afterReceipts = fs.existsSync(path.join(ROOT, '.deployment-guard'))
    ? fs.readdirSync(path.join(ROOT, '.deployment-guard'))
    : [];
  assert.deepEqual(afterReceipts, beforeReceipts);
  assert.doesNotMatch(proc.stdout + proc.stderr, /lease|UpdateFunctionCode|aws lambda|psql/i);
});

test('statuses distinguish accepted, inventory_only, missing_from_main, superseded, and withdrawn', () => {
  const live = loadRegistry(ROOT);
  const statuses = new Set(live.features.map((row) => row.status));
  assert.ok(statuses.has('inventory_only'));
  assert.ok(statuses.has('missing_from_main'));
  assert.equal(statuses.has('accepted'), false);

  const history = [{
    from_feature_id: 'fixture-old',
    from_authority: acceptedAuthority(),
    to_authority: acceptedAuthority({ git_sha: SHA_B }),
    reason: 'Explicit supersession of the fixture after reviewed replacement.',
    approving_workstream_id: 'fixture-supersession',
    review_pr: 1001,
    updated_invariant_ids: ['fixture-widget-mounted'],
    updated_tests: ['aws/tests/fixture-widget.test.mjs'],
    committed_at: '2026-10-05T00:00:00Z',
    commit: SHA_B,
  }];
  const schema = validateRegistry(registry([
    feature({ feature_id: 'fixture-accepted' }),
    feature({
      feature_id: 'fixture-inventory',
      status: 'inventory_only',
      accepted_source_authority: authority(),
    }),
    feature({
      feature_id: 'fixture-missing',
      status: 'missing_from_main',
      accepted_source_authority: authority({ kind: 'none' }),
    }),
    feature({
      feature_id: 'fixture-old',
      status: 'superseded',
      accepted_source_authority: authority({ kind: 'supersession' }),
      supersession_history: history,
    }),
    feature({
      feature_id: 'fixture-gone',
      status: 'withdrawn',
      accepted_source_authority: authority({ kind: 'none' }),
    }),
  ]));
  assert.equal(schema.ok, true, schema.errors.join('; '));
});
