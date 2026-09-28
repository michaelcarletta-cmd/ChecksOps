import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveTenantLogoUrl } from '../../src/lib/tenantLogoUrl.ts';
import {
  ACCEPTED_LIVE_ESIGN,
  ACCEPTED_PRODUCTION_SPA,
  EMAIL_PREVIEW_MOUNT_FILE,
  EMAIL_PREVIEW_SOURCE_PINS,
  FORBIDDEN_FROM,
  FUTURE_OVERLAY_RULES,
  HISTORICAL_R4A_SPA,
  HISTORICAL_STAGING_PREVIEW_SPA,
  REJECTED_HISTORICAL_ESIGN_SHA256,
  assertCompleteGraph,
  assertCurrentSpaProvenance,
  assertEmailPreviewSourcePins,
  assertFromContract,
  assertHistoricalSpaCannotSatisfy,
  assertOverlayAllowlist,
  assertPreviewComponent,
  assertPreviewMount,
  assertPreviewSource,
  assertRejectedHistoricalEsign,
  formatSignatureRequestFrom,
  sha256Bytes,
} from '../../scripts/lib/tenant-email-preview-freeze.mjs';
import { assertProductionBuilderSource, assertProductionSpaBuild, parseEnvText } from '../../scripts/lib/spa-production-build-guard.mjs';
import { evaluateLiveGraph } from '../../scripts/lib/spa-promote-guard.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const freeze = JSON.parse(read('aws/audit/tenant-email-preview-production-freeze.json'));
const postImage = JSON.parse(read('aws/audit/post-image-production-freeze.json'));
const r4aProd = JSON.parse(read('aws/audit/r4a-tenant-branding-production.json'));

test('Email Preview remains mounted in Branding & Appearance', () => {
  const branding = read(EMAIL_PREVIEW_MOUNT_FILE);
  const settings = read('src/components/white-label/WhiteLabelSettings.tsx');
  const preview = read('src/components/settings/SignatureRequestEmailPreview.tsx');
  assert.match(settings, /<TenantBrandingSettings tenant=\{tenant\} \/>/);
  assert.match(branding, /Branding & Appearance/);
  assert.equal(assertPreviewMount(branding).ok, true);
  assert.match(preview, /Email Preview/);
  assert.match(preview, /data-testid="signature-request-email-preview"/);
});

test('Freedom preview resolves to Freedom Adjustment <support@checksops.com>', () => {
  const result = assertFromContract('Freedom Adjustment', 'Freedom Adjustment <support@checksops.com>');
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(formatSignatureRequestFrom('Freedom Adjustment'), freeze.contract.freedom);
});

test('generic tenant preview uses {Tenant Name} <support@checksops.com>', () => {
  const result = assertFromContract('Condition One Commercial', 'Condition One Commercial <support@checksops.com>');
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.notEqual(
    formatSignatureRequestFrom('Condition One Commercial'),
    formatSignatureRequestFrom('Freedom Adjustment'),
  );
});

test('via ChecksOps and noreply are absent from the signature preview', () => {
  const from = formatSignatureRequestFrom('Freedom Adjustment via ChecksOps');
  assert.equal(from, 'Freedom Adjustment <support@checksops.com>');
  assert.doesNotMatch(from, /via ChecksOps/);
  assert.doesNotMatch(from, /noreply@checksops\.com/);
  for (const forbidden of FORBIDDEN_FROM) {
    assert.notEqual(from, forbidden);
  }
  const preview = read('src/components/settings/SignatureRequestEmailPreview.tsx');
  const sender = read('src/lib/signatureRequestSender.ts');
  assert.doesNotMatch(preview, /via ChecksOps/);
  assert.doesNotMatch(preview, /noreply@checksops\.com/);
  assert.doesNotMatch(sender, /noreply@checksops\.com/);
});

test('tenant isolation is preserved', () => {
  assert.notEqual(
    formatSignatureRequestFrom('Freedom Adjustment'),
    formatSignatureRequestFrom('Another Tenant LLC'),
  );
  const branding = read(EMAIL_PREVIEW_MOUNT_FILE);
  assert.match(branding, /tenantName=\{tenant\.name/);
});

test('R4A logo resolver and missing-logo fallback remain accepted', () => {
  assert.equal(resolveTenantLogoUrl('', '/prep'), null);
  assert.equal(resolveTenantLogoUrl(null, '/prep'), null);
  const pins = assertEmailPreviewSourcePins(ROOT);
  assert.equal(pins.ok, true, pins.errors.join('\n'));
  assert.match(read(EMAIL_PREVIEW_MOUNT_FILE), /resolveTenantLogoUrl\(logoUrl\)/);
});

test('Sending Domain, Subdomain, DNS, SES, DKIM, and SPF stay absent', () => {
  const files = [
    EMAIL_PREVIEW_MOUNT_FILE,
    'src/components/settings/SignatureRequestEmailPreview.tsx',
    'src/lib/signatureRequestSender.ts',
    'src/components/white-label/WhiteLabelSettings.tsx',
    'src/pages/admin/AdminTenants.tsx',
  ];
  for (const rel of files) {
    const src = read(rel);
    assert.doesNotMatch(src, /Sending Domain|Sending subdomain|Sending Subdomain/);
    assert.doesNotMatch(src, /EmailSenderSettings/);
    assert.doesNotMatch(src, /DKIM|SPF/);
    assert.doesNotMatch(src, /mailFromRecords|dnsRecords|SES identity|Start domain verification/i);
  }
});

test('preview source introduces no Supabase runtime dependency', () => {
  for (const rel of Object.keys(EMAIL_PREVIEW_SOURCE_PINS)) {
    const src = read(rel);
    assert.doesNotMatch(src, /createClient|@supabase\/supabase-js|VITE_SUPABASE_URL|functions\.invoke\("tenant-email-preview"/);
  }
});

test('production build guard rejects staging API/Cognito configuration', () => {
  const builder = read('scripts/build-production-aws-spa.mjs');
  assert.equal(assertProductionBuilderSource(builder).ok, true);
  assert.equal(assertProductionSpaBuild({
    mode: 'production',
    env: {
      VITE_AUTH_PROVIDER: 'cognito',
      VITE_APP_URL: 'https://checksops.com',
      VITE_CHECKSOPS_API_URL: '/prep',
      VITE_COGNITO_USER_POOL_ID: 'us-east-1_h00WorYMT',
      VITE_COGNITO_USER_POOL_CLIENT_ID: '3ja9fqaq2fjkv3i6up2varcqpe',
    },
  }).ok, true);
  const stagingEnvPath = ['.env.aws', '.env.aws.example']
    .map((rel) => path.join(ROOT, rel))
    .find((abs) => fs.existsSync(abs));
  assert.ok(stagingEnvPath, 'expected .env.aws or .env.aws.example for the staging reject proof');
  const staging = parseEnvText(fs.readFileSync(stagingEnvPath, 'utf8'));
  assert.equal(assertProductionSpaBuild({
    mode: 'aws',
    env: staging,
    argv: ['npx', 'vite', 'build', '--mode', 'aws'],
  }).ok, false);
});

test('complete SPA graph remains required', () => {
  assert.equal(assertCompleteGraph(ACCEPTED_PRODUCTION_SPA.graph).ok, true);
  assert.equal(assertCompleteGraph({ present: 102, total: 103, missing: 1, html_fallbacks: 0 }).ok, false);
  const incomplete = evaluateLiveGraph({
    objects: [
      { key: 'index.html', missing: false, htmlFallback: false },
      { key: 'assets/index-AAA.js', missing: true, htmlFallback: false },
    ],
    missing: ['assets/index-AAA.js'],
  });
  assert.equal(incomplete.ok, false);
});

test('historical pre-preview SPA cannot silently satisfy the accepted contract', () => {
  const r4a = assertHistoricalSpaCannotSatisfy({
    sha256: HISTORICAL_R4A_SPA.sha256,
    source: 'export function TenantBrandingSettings(){ return "Branding & Appearance"; }',
  });
  assert.equal(r4a.ok, false);
  assert.match(r4a.errors.join(' '), /historical R4A SPA|without Email Preview/);

  const staging = assertHistoricalSpaCannotSatisfy({
    sha256: HISTORICAL_STAGING_PREVIEW_SPA.sha256,
  });
  assert.equal(staging.ok, false);
  assert.match(staging.errors.join(' '), /never production authority|staging preview/);

  const oldSource = assertPreviewMount('export function TenantBrandingSettings(){ return null; }');
  assert.equal(oldSource.ok, false);
  assert.match(oldSource.errors.join(' '), /SignatureRequestEmailPreview/);

  const oldSender = assertPreviewSource('export function formatFrom(name){ return `${name} via ChecksOps <noreply@checksops.com>`; }');
  assert.equal(oldSender.ok, false);

  const oldPreview = assertPreviewComponent('<div>From: Freedom Adjustment via ChecksOps <support@checksops.com></div>');
  assert.equal(oldPreview.ok, false);
});

test('historical pre-fix esign.mjs remains rejected as production authority', () => {
  const worktree = read('aws/functions/api/esign.mjs');
  const hash = sha256Bytes(worktree);
  assert.equal(hash, REJECTED_HISTORICAL_ESIGN_SHA256);
  const rejected = assertRejectedHistoricalEsign(hash, worktree);
  assert.equal(rejected.ok, false);
  assert.match(rejected.errors.join(' '), /never become production authority|pre-fix/);
  assert.notEqual(hash, ACCEPTED_LIVE_ESIGN.sha256);
  assert.doesNotMatch(worktree, /signatureRequestFromHeader/);
});

test('accepted Email Preview SPA provenance is recorded and R4A is historical only', () => {
  assert.equal(assertCurrentSpaProvenance(ACCEPTED_PRODUCTION_SPA).ok, true);
  assert.equal(freeze.accepted_production_spa.index_sha256, ACCEPTED_PRODUCTION_SPA.sha256);
  assert.equal(freeze.accepted_production_spa.index_version_id, ACCEPTED_PRODUCTION_SPA.versionId);
  assert.equal(freeze.accepted_production_spa.entry, ACCEPTED_PRODUCTION_SPA.entry);
  assert.equal(freeze.accepted_production_spa.graph.label, '103/103');
  assert.equal(freeze.historical_provenance_only.r4a_production_spa.must_not_automatically_replace_current, true);
  assert.equal(freeze.historical_provenance_only.staging_preview_spa.never_production_authority, true);
  assert.equal(postImage.spa.current_live.index_sha256, ACCEPTED_PRODUCTION_SPA.sha256);
  assert.equal(postImage.provenance_not_deployment_baselines.r4a_spa.index_sha256, HISTORICAL_R4A_SPA.sha256);
  assert.equal(postImage.provenance_not_deployment_baselines.r4a_spa.must_not_automatically_replace_current, true);
  assert.equal(r4aProd.production_spa.historical_provenance_only, true);
  assert.equal(r4aProd.production_spa.must_not_automatically_replace_current, true);
});

test('future overlay must allowlist protected preview files and cannot use this SHA as a permanent pin', () => {
  const unauthorized = assertOverlayAllowlist({
    changedFiles: ['src/lib/signatureRequestSender.ts'],
    allowlisted: [],
  });
  assert.equal(unauthorized.ok, false);
  const authorized = assertOverlayAllowlist({
    changedFiles: ['src/lib/signatureRequestSender.ts'],
    allowlisted: ['src/lib/signatureRequestSender.ts'],
    supersede: false,
  });
  assert.equal(authorized.ok, true);
  assert.equal(authorized.preserve_required, true);
  assert.equal(FUTURE_OVERLAY_RULES.sha_version_are_provenance_not_rollback_pins, true);
  assert.equal(FUTURE_OVERLAY_RULES.start_from_then_current_live_spa, true);
  assert.equal(freeze.future_spa_overlay_rules.must_not_require_this_sha_for_all_future_deploys, true);
  assert.equal(freeze.production_application_state_changed_by_this_workstream, false);
  assert.equal(freeze.aws_writes, 0);
});
