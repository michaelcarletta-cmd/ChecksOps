#!/usr/bin/env node
/**
 * Additive stamp of the existing 1,421-row functional-audit inventory.
 * Does not create a new inventory. Prior `result` values stay frozen
 * unless an ID is explicitly reclassified to N/A — LEGACY_UNUSED.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSON_PATH = path.join(ROOT, 'docs/audits/inventory-2026-09-11.json');
const CSV_PATH = path.join(ROOT, 'docs/audits/inventory-2026-09-11.csv');
const STAMP = '2026-09-14T18:30:00.000Z';

const LEGACY_UNUSED_IDS = [
  'A4-225', 'A4-226', 'A4-227',
  'CC-228', 'CC-229', 'CC-230', 'CC-231', 'CC-232',
];

const LEGACY_NOTE = {
  'A4-225': 'N/A — LEGACY_UNUSED. Zapier UI removed. hooks.zapier.com / automation-webhook display was unmounted and is not shared with Moov, CheckAlt, Resend, Cognito, OCR, endorsements, payees, or disbursements. Historical zapier_webhook_url column retained.',
  'A4-226': 'N/A — LEGACY_UNUSED. Zapier Test button removed with ZapierIntegrationSettings.tsx.',
  'A4-227': 'N/A — LEGACY_UNUSED. Browse Zapier Apps removed with ZapierIntegrationSettings.tsx.',
  'CC-228': 'N/A — LEGACY_UNUSED. TenantCreditManager Stripe top-up chrome removed. Not imported into the live route tree. tenant_credit_balances rows retained.',
  'CC-229': 'N/A — LEGACY_UNUSED. Stripe top-up amount input removed with TenantCreditManager.tsx.',
  'CC-230': 'N/A — LEGACY_UNUSED. Stripe Checkout Pay button removed with TenantCreditManager.tsx.',
  'CC-231': 'N/A — LEGACY_UNUSED. Stripe maintenance-subscription Manage button removed.',
  'CC-232': 'N/A — LEGACY_UNUSED. Stripe customer-portal copy removed with TenantCreditManager.tsx.',
};

const REPAIR_NOTES = {
  'X-020': 'Source repaired to GET/POST ${awsApiBaseUrl()}/functions/v1/handle-email-unsubscribe (no VITE_SUPABASE_URL, no session invoke). Live /prep GET ?token=test returns 404 JSON invalid_token (handler live; dummy token; no row writes). Live locked Unsubscribe-BdTAOTIR.js still fetch(`${blank}/functions/v1/handle-email-unsubscribe`)+apikey and origin GET returns SPA HTML. Controlled production SPA release required.',
  'A5-305': 'Source repaired: uploadVerificationFile XHR posts to ${awsApiBaseUrl()}/functions/v1/moov-account-file-upload with Cognito bearer only. Live /prep OPTIONS 204. Live locked index-CiOVNYWh.js still POSTs /functions/v1/moov-account-file-upload (CloudFront 403). Controlled production SPA release required. No KYC file uploaded.',
  'A5-306': 'Document-type control for the repaired Moov KYC upload path. Live locked SPA still uses the leftover origin URL until a controlled SPA release.',
  'A5-307': 'Representative selector for the repaired Moov KYC upload path. Live locked SPA still uses the leftover origin URL until a controlled SPA release.',
  'A5-308': 'File input for the repaired Moov KYC upload path. Live locked SPA still uses the leftover origin URL until a controlled SPA release.',
  'A5-309': 'VerificationDocumentsPanel chrome for the repaired Moov KYC upload path. Live locked SPA still broken until controlled SPA release.',
  'A5-310': 'VerificationDocumentsPanel chrome for the repaired Moov KYC upload path. Live locked SPA still broken until controlled SPA release.',
};

const csvEscape = (value) => {
  const text = value == null ? '' : String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
};

const inventory = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
if (!Array.isArray(inventory.controls) || inventory.controls.length !== 1421) {
  throw new Error(`Expected 1421 controls, found ${inventory.controls?.length}`);
}

const byId = new Map(inventory.controls.map((row) => [row.id, row]));
for (const id of [...LEGACY_UNUSED_IDS, ...Object.keys(REPAIR_NOTES)]) {
  if (!byId.has(id)) throw new Error(`Missing inventory id ${id}`);
}

for (const id of LEGACY_UNUSED_IDS) {
  const row = byId.get(id);
  row.result = 'N/A';
  row.post_cutover_status = 'N/A';
  row.legacy_unused = true;
  row.integration_status = 'LEGACY_UNUSED';
  row.post_cutover_note = LEGACY_NOTE[id];
  row.post_cutover_classified_at = STAMP;
}

for (const [id, note] of Object.entries(REPAIR_NOTES)) {
  const row = byId.get(id);
  row.post_cutover_status = 'SUPABASE_DEPENDENCY';
  row.repair_candidate = 'PREPARED_SPA_RELEASE_REQUIRED';
  row.post_cutover_note = note;
  row.post_cutover_classified_at = STAMP;
}

const counts = {
  AWS_PASS: 0,
  AWS_FAIL: 0,
  SUPABASE_DEPENDENCY: 0,
  INTERNAL_BLOCKED: 0,
  EXTERNAL_BLOCKED: 0,
  NOT_RETESTED_POST_CUTOVER: 0,
  N_A: 0,
  LEGACY_UNUSED: 0,
  other: 0,
};
const prior = { PASS: 0, FAIL: 0, BLOCKED: 0, 'N/A': 0, other: 0 };
const awsPassIds = [];
const awsFailIds = [];
const supabaseIds = [];
const legacyIds = [];
const byModuleLive = {};

for (const row of inventory.controls) {
  const result = row.result === 'N/A' ? 'N/A' : row.result;
  prior[result] = (prior[result] || 0) + 1;
  const status = row.post_cutover_status || 'NOT_RETESTED_POST_CUTOVER';
  if (row.legacy_unused || row.integration_status === 'LEGACY_UNUSED') {
    counts.LEGACY_UNUSED += 1;
    legacyIds.push(row.id);
  }
  if (result === 'N/A' || status === 'N/A') {
    counts.N_A += 1;
    continue;
  }
  if (status === 'AWS_PASS') {
    counts.AWS_PASS += 1;
    awsPassIds.push(row.id);
  } else if (status === 'AWS_FAIL') {
    counts.AWS_FAIL += 1;
    awsFailIds.push(row.id);
  } else if (status === 'SUPABASE_DEPENDENCY') {
    counts.SUPABASE_DEPENDENCY += 1;
    supabaseIds.push(row.id);
  } else if (status === 'INTERNAL_BLOCKED') {
    counts.INTERNAL_BLOCKED += 1;
  } else if (status === 'EXTERNAL_BLOCKED') {
    counts.EXTERNAL_BLOCKED += 1;
  } else if (status === 'NOT_RETESTED_POST_CUTOVER') {
    counts.NOT_RETESTED_POST_CUTOVER += 1;
  } else {
    counts.other += 1;
  }
  const moduleName = row.module || 'other';
  byModuleLive[moduleName] ||= {};
  byModuleLive[moduleName][status] = (byModuleLive[moduleName][status] || 0) + 1;
}

const liveNonNa = counts.AWS_PASS + counts.AWS_FAIL + counts.SUPABASE_DEPENDENCY
  + counts.INTERNAL_BLOCKED + counts.EXTERNAL_BLOCKED + counts.NOT_RETESTED_POST_CUTOVER + counts.other;

inventory.summary.active_parity_phase = {
  applied_at: STAMP,
  existing_inventory: inventory.controls.length,
  prior_result_frozen: {
    PASS: prior.PASS,
    FAIL: prior.FAIL,
    BLOCKED: prior.BLOCKED,
    N_A: prior['N/A'],
  },
  post_cutover_counts: {
    AWS_PASS: counts.AWS_PASS,
    AWS_FAIL: counts.AWS_FAIL,
    SUPABASE_DEPENDENCY: counts.SUPABASE_DEPENDENCY,
    INTERNAL_BLOCKED: counts.INTERNAL_BLOCKED,
    EXTERNAL_BLOCKED: counts.EXTERNAL_BLOCKED,
    NOT_RETESTED_POST_CUTOVER: counts.NOT_RETESTED_POST_CUTOVER,
    N_A: counts.N_A,
    LEGACY_UNUSED: counts.LEGACY_UNUSED,
    live_non_na: liveNonNa,
    active_required: liveNonNa,
  },
  legacy_unused_ids: legacyIds,
  repair_candidate_ids: Object.keys(REPAIR_NOTES),
};

fs.writeFileSync(JSON_PATH, `${JSON.stringify(inventory, null, 2)}\n`);

const csvHeader = [
  'id', 'module', 'screen', 'label', 'type', 'file', 'line', 'safety', 'prior_bucket',
  'newly_discovered', 'result', 'blocker', 'blocker_category', 'blocker_root_cause',
  'blocker_secondary', 'evidence', 'pass', 'role', 'route', 'physical_action',
  'defect_id', 'integration_status', 'integration_branch', 'post_cutover_status',
  'post_cutover_note',
];
const csvLines = [csvHeader.join(',')];
for (const row of inventory.controls) {
  csvLines.push(csvHeader.map((key) => {
    if (key === 'newly_discovered') return row.newly_discovered ? 'True' : 'False';
    return csvEscape(row[key]);
  }).join(','));
}
fs.writeFileSync(CSV_PATH, `${csvLines.join('\n')}\n`);

const report = {
  generated_at: STAMP,
  inventory_source: {
    path: 'docs/audits/inventory-2026-09-11.json',
    existing_inventory: 1421,
    note: 'Same 1,421 IDs. Prior result frozen except explicit N/A — LEGACY_UNUSED reclass of unused Zapier/Stripe UI.',
  },
  totals: {
    existing_inventory: 1421,
    live_non_na: liveNonNa,
    n_a: counts.N_A,
    legacy_unused: counts.LEGACY_UNUSED,
    active_required: liveNonNa,
    AWS_PASS: counts.AWS_PASS,
    AWS_FAIL: counts.AWS_FAIL,
    SUPABASE_DEPENDENCY: counts.SUPABASE_DEPENDENCY,
    INTERNAL_BLOCKED: counts.INTERNAL_BLOCKED,
    EXTERNAL_BLOCKED: counts.EXTERNAL_BLOCKED,
    NOT_RETESTED_POST_CUTOVER: counts.NOT_RETESTED_POST_CUTOVER,
  },
  prior_result_unchanged: {
    PASS: prior.PASS,
    FAIL: prior.FAIL,
    BLOCKED: prior.BLOCKED,
    N_A: prior['N/A'],
  },
  aws_pass_ids: awsPassIds,
  aws_fail_ids: awsFailIds,
  supabase_dependency_ids: supabaseIds,
  legacy_unused_ids: legacyIds,
  by_module_live: byModuleLive,
  controlled_spa_release_required: true,
  production_spa_still_locked: true,
};

fs.writeFileSync(
  path.join(ROOT, 'docs/audits/ACTIVE_PRODUCT_PARITY_2026-09-14.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);

console.log(JSON.stringify({
  controls: inventory.controls.length,
  ...counts,
  liveNonNa,
  awsPassIds,
  supabaseIds,
  legacyIds,
}, null, 2));
