/**
 * Thin OCR/Azure release-lock contract.
 * Existing aws/tests/ocr-*.test.mjs remain the behavioral proof.
 * This file only pins capability markers so a future PR cannot silently
 * drop a staging-validated invariant after updating tree_hash.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  computeOwnershipHashes,
  loadJson,
  matchProtectedPath,
  validateReleaseLocks,
} from '../../../scripts/lib/release-locks.mjs';
import { loadReleaseLockInputs } from '../../../scripts/validate-release-locks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const OCR_RUNTIME = Object.freeze([
  'aws/functions/api/ocr.mjs',
  'aws/functions/api/ocr-parse.mjs',
  'aws/functions/api/ocr-azure-image.mjs',
  'aws/functions/api/check-ocr-provider.mjs',
  'aws/functions/api/azure-check-ocr.mjs',
  'aws/functions/api/azure-di-secret.mjs',
  'aws/functions/api/ocr-normalize-azure.mjs',
  'aws/functions/api/textract-check-ocr.mjs',
]);

const SHARED_CHECKALT_IMAGE = 'aws/functions/api/providers/parity/checkalt-image.mjs';

const OCR_CHECKALT_EXPORTS = Object.freeze([
  'applyExifOrientation',
  'decodeRaster',
  'encodeJpeg',
  'isJpegMagic',
  'readJpegExifOrientation',
  'resizeBilinear',
  'rotate90Cw',
]);

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('ocr-azure ownership group covers the eight runtime files only', () => {
  const protectedPaths = loadJson(path.join(ROOT, 'ops/release-locks/protected-paths.json'));
  const group = protectedPaths.ownership_groups['ocr-azure'];
  assert.ok(group, 'ocr-azure ownership group is required');
  assert.deepEqual([...group.paths].sort(), [...OCR_RUNTIME].sort());
  assert.ok(!group.paths.includes(SHARED_CHECKALT_IMAGE));

  const hashes = computeOwnershipHashes(ROOT, protectedPaths);
  assert.deepEqual(hashes.groups['ocr-azure'].files, [...OCR_RUNTIME].sort());
  assert.equal(hashes.groups['ocr-azure'].missing.length, 0);

  for (const rel of OCR_RUNTIME) {
    const matches = matchProtectedPath(rel, protectedPaths);
    assert.ok(matches.some((row) => row.groupId === 'ocr-azure'), `${rel} must belong to ocr-azure`);
  }

  const sharedMatches = matchProtectedPath(SHARED_CHECKALT_IMAGE, protectedPaths);
  assert.ok(
    !sharedMatches.some((row) => row.groupId === 'ocr-azure'),
    'ocr-azure must not claim shared checkalt-image.mjs',
  );
  assert.ok(
    !sharedMatches.some((row) => row.groupId === 'checkalt-submission'),
    'checkalt-submission must not newly own checkalt-image.mjs via this lock',
  );
});

test('ocr-azure reconciled lineage fails closed as UNVERIFIED and not production-active', () => {
  const manifest = loadJson(path.join(ROOT, 'ops/release-locks/locked-components.json'));
  const component = manifest.components['ocr-azure'];
  assert.ok(component, 'ocr-azure manifest component is required');
  assert.equal(component.id, 'ocr-azure');
  assert.equal(component.ownership_group, 'ocr-azure');
  assert.equal(component.classification, 'UNVERIFIED');
  assert.equal(component.production_active, false);
  assert.equal(component.environment, 'unknown');
  assert.equal(component.source.git_sha, '4c52e1835a4e5b677b763e6095acc67c951b74ee');
  assert.equal(component.source.merged, false);
  assert.equal(component.source.merged_pr, 561);
  assert.ok((component.required_sql || []).length === 0);
  assert.equal(component.production_validation?.completed, false);
  assert.ok((component.missing_evidence || []).some((row) => /staging revalidation/i.test(row)));
  assert.match(component.notes || '', /Fail-closed reconciliation only/i);
});

test('OCR runtime capability markers remain intact', () => {
  const ocr = read('aws/functions/api/ocr.mjs');
  const parse = read('aws/functions/api/ocr-parse.mjs');
  const prepare = read('aws/functions/api/ocr-azure-image.mjs');
  const provider = read('aws/functions/api/check-ocr-provider.mjs');
  const azure = read('aws/functions/api/azure-check-ocr.mjs');
  const secret = read('aws/functions/api/azure-di-secret.mjs');
  const normalize = read('aws/functions/api/ocr-normalize-azure.mjs');
  const textract = read('aws/functions/api/textract-check-ocr.mjs');

  // 1. Textract remains the descriptive OCR engine.
  assert.match(textract, /export const runTextract/);
  assert.match(textract, /TextractClient/);
  assert.match(textract, /AnalyzeDocumentCommand/);
  assert.match(textract, /engine: 'aws_textract_analyze'/);
  assert.match(provider, /descriptiveEngine = 'aws_textract'/);
  assert.match(provider, /await runTextract\(imageBytes/);
  assert.doesNotMatch(textract, /prebuilt-check\.us/);

  // 2. Azure prebuilt-check.us remains authoritative for structured MICR.
  assert.match(azure, /export const AZURE_CHECK_MODEL = 'prebuilt-check\.us'/);
  assert.match(azure, /AZURE_CHECK_API_VERSION = '2024-11-30'/);
  assert.match(provider, /micr_engine: azureOk \? 'azure_prebuilt_check_us' : 'none'/);
  assert.match(provider, /canonical\.routing_number = azureMicr\.routing_number/);
  assert.match(provider, /normalizeAzureMicr\(azure\.document/);

  // 3. Routing requires 9 digits + valid ABA checksum before VERIFIED.
  assert.match(parse, /export const abaRoutingChecksumOk/);
  assert.match(normalize, /routingDigits\.length === 9 && abaRoutingChecksumOk\(routingDigits\)/);
  assert.match(normalize, /micr_routing_state = STATES\.VERIFIED/);

  // 4. Account validation rules remain intact.
  assert.match(normalize, /const ACCOUNT_MIN = 6/);
  assert.match(normalize, /const ACCOUNT_MAX = 17/);
  assert.match(normalize, /accountDigits\.length >= ACCOUNT_MIN && accountDigits\.length <= ACCOUNT_MAX/);

  // 5. Azure MICR check validation remains intact.
  assert.match(normalize, /micr_check_state = micrCheckDigits \? STATES\.VERIFIED : STATES\.REVIEW_REQUIRED/);

  // 6. Textract printed-check disagreement is diagnostic and does not by itself
  //    invalidate verified Azure MICR.
  assert.match(normalize, /Printed-check disagreement is[\s\S]{0,80}diagnostic only and must not force REVIEW_REQUIRED by itself/);
  assert.match(provider, /canonical\.diagnostic\.printed_vs_micr_check = printedVsMicr/);
  assert.doesNotMatch(provider, /printedVsMicr\.differs[\s\S]{0,120}REVIEW_REQUIRED/);
  assert.doesNotMatch(normalize, /printed_vs_micr_check\.differs[\s\S]{0,120}REVIEW_REQUIRED/);

  // 7–11. Oversized Azure images are prepared in memory; original S3 is never
  // modified; Textract gets the original; Azure gets the derivative; no persist.
  assert.match(prepare, /export const AZURE_OCR_TARGET_MAX_BYTES = Math\.floor\(3\.5 \* 1024 \* 1024\)/);
  assert.match(prepare, /export const prepareAzureOcrImage/);
  assert.match(prepare, /Never writes S3 or temp files/);
  assert.doesNotMatch(prepare, /PutObjectCommand|writeFile|S3Client/);
  assert.match(ocr, /GetObjectCommand/);
  assert.doesNotMatch(ocr, /PutObjectCommand/);
  assert.match(provider, /await runTextract\(imageBytes/);
  assert.match(provider, /imageBytes: prepared\.bytes/);
  assert.match(provider, /prepared\.bytes\.fill\(0\)/);

  // 12–14. Azure result cleanup is mandatory; DELETE retries 429/5xx; 204 confirms.
  assert.match(azure, /export const deleteAzureAnalyzeResult/);
  assert.match(azure, /retryOn: \[429, 500\]/);
  assert.match(azure, /code: 'delete_confirmed', status: 204, deleteConfirmed: true/);
  assert.match(azure, /const del = await deleteAzureAnalyzeResult/);

  // 15–16. HTTP responses remain redacted; CloudWatch OCR logs remain whitelist/redacted.
  assert.match(ocr, /export const redactOcrIntakeResponse/);
  assert.match(ocr, /return redactOcrIntakeResponse\(/);
  assert.match(azure, /export const redactOcrLog/);
  assert.match(azure, /export const safeOcrLog/);
  assert.match(azure, /event: entry\?\.event \|\| 'ocr_azure'/);
  assert.match(azure, /deleteConfirmed: entry\?\.deleteConfirmed \?\? null/);
  const safeLog = azure.match(/export const safeOcrLog[\s\S]+?attempts: entry\?\.attempts \?\? null,\n  \}\)\);/);
  assert.ok(safeLog, 'safeOcrLog whitelist body must remain');
  assert.doesNotMatch(safeLog[0], /routing_number|account_number|api_key|payee|amount|micr_check/);

  // 17. Only VERIFIED Azure MICR may fill blank routing/account fields.
  //     Existing nonblank values remain authoritative; amount/status remain untouched.
  assert.match(ocr, /fallback_descriptive_only/);
  assert.match(ocr, /Do not touch ocr_status\/amount\/detected_claim_number/);
  const descriptiveUpdate = ocr.match(
    /UPDATE public\.check_intake_items SET\s+carrier_name = COALESCE\(\$2, carrier_name\),\s+check_number = COALESCE\(\$3, check_number\),\s+payee_line = COALESCE\(\$4, payee_line\),[\s\S]{0,80}WHERE id = \$1::uuid/,
  );
  assert.ok(descriptiveUpdate, 'descriptive-only UPDATE must remain');
  assert.doesNotMatch(descriptiveUpdate[0], /routing_number|account_number|micr_check_number|amount =/);
  assert.match(ocr, /parsed\.micr_routing_state === 'VERIFIED' \? parsed\.routing_number : null/);
  assert.match(ocr, /parsed\.micr_account_state === 'VERIFIED' \? parsed\.account_number : null/);
  const micrUpdate = ocr.match(
    /UPDATE public\.check_intake_items[\s\S]{0,900}routing_number = CASE[\s\S]{0,900}account_number = CASE[\s\S]{0,900}WHERE id = \$1::uuid/,
  );
  assert.ok(micrUpdate, 'verified MICR persistence UPDATE must remain');
  assert.match(micrUpdate[0], /routing_number IS NULL OR btrim\(routing_number\) = ''/);
  assert.match(micrUpdate[0], /account_number IS NULL OR btrim\(account_number\) = ''/);
  assert.doesNotMatch(micrUpdate[0], /amount\s*=|status\s*=|check_stage\s*=/);

  // 18. OCR does not trigger CheckAlt or Moov.
  for (const [rel, src] of [
    ['ocr.mjs', ocr],
    ['check-ocr-provider.mjs', provider],
    ['azure-check-ocr.mjs', azure],
    ['azure-di-secret.mjs', secret],
    ['textract-check-ocr.mjs', textract],
    ['ocr-normalize-azure.mjs', normalize],
    ['ocr-parse.mjs', parse],
  ]) {
    assert.doesNotMatch(src, /checkalt-submit|checkalt-dispatch|moov-webhook|MoovClient/, `${rel} must not trigger CheckAlt/Moov`);
  }

  // 19. Tenant AI Key / OpenAI UI remains unrelated and is not restored.
  assert.doesNotMatch(ocr, /TenantAIKeySettings|openai|OPENAI_API_KEY/);
  assert.doesNotMatch(provider, /TenantAIKeySettings|openai|OPENAI_API_KEY/);
  assert.doesNotMatch(textract, /TenantAIKeySettings|openai|OPENAI_API_KEY/);
});

test('OCR reuses CheckAlt image export contract without owning the module', () => {
  const prepare = read(SHARED_CHECKALT_IMAGE.replace('providers/parity/checkalt-image.mjs', 'ocr-azure-image.mjs'));
  const shared = read(SHARED_CHECKALT_IMAGE);

  assert.match(
    prepare,
    /from '\.\/providers\/parity\/checkalt-image\.mjs'/,
  );
  for (const name of OCR_CHECKALT_EXPORTS) {
    assert.match(prepare, new RegExp(`\\b${name}\\b`), `ocr-azure-image.mjs must import ${name}`);
    assert.match(shared, new RegExp(`export (?:const ${name}|function ${name}\\b)`), `checkalt-image.mjs must export ${name}`);
  }
  assert.doesNotMatch(prepare, /prepareCheckAlt|1920|450\s*\*\s*1024|CHECKALT_TARGET/);
});

test('ocr-azure lock introduces no new validator errors for this component', () => {
  const inputs = loadReleaseLockInputs(ROOT);
  const { errors } = validateReleaseLocks(inputs);
  const ocrErrors = errors.filter((row) => /ocr-azure|checkalt-image\.mjs/.test(row));
  assert.deepEqual(ocrErrors, []);
  assert.equal(
    errors.some((row) => /components\.production-release: protected source tree changed/.test(row)),
    false,
    'production-release tree_hash must be updated with this control-plane change',
  );
});
