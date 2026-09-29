import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertImageCompatSourcePins } from '../../scripts/lib/image-compat-freeze.mjs';
import { assertProductionBuilderSource } from '../../scripts/lib/spa-production-build-guard.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const freeze = JSON.parse(readFileSync(path.join(ROOT, 'aws/audit/post-image-production-freeze.json'), 'utf8'));
const doc = readFileSync(path.join(ROOT, 'aws/audit/POST_IMAGE_PRODUCTION_FREEZE.md'), 'utf8');
const builder = readFileSync(path.join(ROOT, 'scripts/build-production-aws-spa.mjs'), 'utf8');

test('freeze pins the accepted live Lambda, not R3 or pre-compat hashes', () => {
  assert.equal(freeze.lambda.CodeSha256, 'HzqcBPqWAtyIM61iEKHOdpfiO2lEPi8vWilo9xIcb9w=');
  assert.equal(freeze.lambda.package_sha256, '1f3a9c04fa9602dc8833ad6210a1ce7697e23b69443e2f2f5a2968f7121c6fdc');
  assert.equal(freeze.lambda.RevisionId, '31295ac7-f358-49bd-b29f-0e984d20b37f');
  assert.equal(freeze.lambda.LastModified, '2026-09-26T14:12:05.000+0000');
  assert.notEqual(freeze.lambda.CodeSha256, 'o/U/pbZ2FR38T3HI6A6kUxp9wik4pci92KmEVfmhF6I=');
  assert.notEqual(freeze.lambda.CodeSha256, 'Z5PR5OcmZSyiSPQxn6yYbuCd3jZK5F/NDrQnyF9A3U8=');
  assert.match(JSON.stringify(freeze.provenance_not_deployment_baselines), /o\/U\/pbZ2FR38T3HI6A6kUxp9wik4pci92KmEVfmhF6I=/);
  assert.match(doc, /HzqcBPqWAtyIM61iEKHOdpfiO2lEPi8vWilo9xIcb9w=/);
});

test('freeze pins the accepted live SPA graph', () => {
  assert.equal(freeze.spa.current_live.index_sha256, '6b211037ae70b510a9b5cfe316f006dbbc308ee3c94687ccea943b24cfd09f2e');
  assert.equal(freeze.spa.current_live.index_version_id, 'advEv5N0JfqM41odUraOM7kCH6Z2snP3');
  assert.equal(freeze.spa.current_live.main, 'assets/index-CS_JpvZg.js');
  assert.equal(freeze.spa.current_live.claim_check, 'assets/CheckCommandCenter-DHNFge6N.js');
  assert.equal(freeze.spa.current_live.missing_count, 0);
  assert.equal(freeze.spa.current_live.html_fallback_count, 0);
  assert.equal(freeze.spa.objects.length, 103);
  assert.equal(freeze.spa.current_live.required_surfaces.claim_check.present, true);
  assert.equal(freeze.spa.current_live.required_surfaces.mortgage_desk.present, true);
  assert.equal(freeze.spa.current_live.required_surfaces.admin_tenant_moov_billing.present, true);
  assert.equal(freeze.spa.current_live.overlay, 'r4a-tenant-branding');
  assert.equal(
    freeze.provenance_not_deployment_baselines.pre_r4a_spa.index_sha256,
    '342c2e1588f712ebf73f563a881c982941b955619c51c6a79a7834aace21538a',
  );
});

test('accepted image compatibility files are frozen at current hashes', () => {
  const pins = freeze.accepted_image_compatibility.source_files;
  assert.equal(pins['src/lib/checkImageInvariants.ts'], '41a42c8df6f61b52b2683a300310c3f0498531ee991c5492347e216dc418d802');
  assert.equal(pins['src/pages/CheckCommandCenter.tsx'], '32436906507f3e8f183a0f393dd43ea66bd7eeb4dd2fca33087e737a6b7984d4');
  assert.equal(pins['aws/functions/api/storage.mjs'], 'b6923ff66786f5604bda229c21e9309a3d7e49ba0ee2edaf07106690228eed56');
  assert.equal(pins['aws/functions/api/storage-paths.mjs'], '278329e5230b2ddd6675e4cad9839d2193da8655ca4676573702dca3f90e9d09');
  const source = assertImageCompatSourcePins(ROOT);
  assert.equal(source.ok, true, source.errors.join('\n'));
});

test('production data-plane contract is Cognito + same-origin /prep', () => {
  assert.equal(freeze.production_data_plane.VITE_APP_URL, 'https://checksops.com');
  assert.equal(freeze.production_data_plane.VITE_CHECKSOPS_API_URL, '/prep');
  assert.equal(freeze.production_data_plane.VITE_COGNITO_USER_POOL_ID, 'us-east-1_h00WorYMT');
  assert.equal(freeze.production_data_plane.rejected.staging_pool, 'us-east-1_vPmQ7cL1F');
  assert.equal(freeze.production_data_plane.rejected.vite_mode_aws, true);
  assert.equal(freeze.safeguards.never_vite_mode_aws, true);
  assert.equal(freeze.safeguards.start_from_current_live, true);
  const built = assertProductionBuilderSource(builder);
  assert.equal(built.ok, true, built.errors.join('\n'));
});

test('R4A branding is the accepted SPA overlay; R4B remains out of scope', () => {
  assert.equal(freeze.accepted_r4a_branding.status, 'PRODUCTION_ACCEPTED');
  assert.equal(freeze.accepted_r4a_branding.r4b_implemented, false);
  assert.match(JSON.stringify(freeze.out_of_scope), /R4B/);
  assert.equal(freeze.lambda.CodeSha256, 'HzqcBPqWAtyIM61iEKHOdpfiO2lEPi8vWilo9xIcb9w=');
  assert.equal(freeze.current_observed_lambda.CodeSha256, 'Hhij5GWW/GDBcRE+4wYomml96R+6IWwFJPczbz5YLZM=');
  assert.notEqual(freeze.current_observed_lambda.CodeSha256, freeze.lambda.CodeSha256);
});
