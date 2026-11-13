import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { run as preflight, validateApplyInputs, approvalPhrase } from '../../scripts/deployment-guard/github-lambda-rebuild.mjs';
import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { DEPLOYMENT_TYPES } from '../../scripts/deployment-guard/lib/identity.mjs';
import { applyLambdaRebuild, resolveCandidateZip } from '../../scripts/deployment-guard/lib/lambda-rebuild-apply.mjs';
import {
  REBUILD_DEPLOYMENT_TYPE,
  REBUILD_PLAN_REL,
  buildCandidatePackage,
  diffDependencies,
  diffMembers,
  evaluateRebuild,
  fullPackageComponent,
  loadRebuildPlan,
  packageInventory,
  parseFullPackageComponent,
  readPackage,
} from '../../scripts/deployment-guard/lib/lambda-rebuild.mjs';
import { acquireLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import { issueReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';
import { writeZipMembers } from '../../scripts/deployment-guard/lib/zip-members.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA = 'a'.repeat(40);
const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// The first 2026-10-21 rebuilds are applied: the history[0] of each section records them, and their
// accepted hashes are the bytes those rebuilds put live (sha256 at the inspect's main_commit) and stay
// as recorded evidence. Files main changed after those rebuilds are listed here, one reviewed entry
// each; every other accepted hash must still be the bytes on main. A listed path that no longer exists
// must be marked deleted. The staging section accepts every one of them from inspect 39630308266 and
// the production section from inspect 39633975144 (members or removed); see
// ops/production-lambda-rebuild.md.
const CHANGED_SINCE_APPLIED_REBUILD = {
  // Plaid/Actum/QuickBooks removal.
  'allowed-tables.json': 'changed',
  'data.mjs': 'changed',
  'financial-flags.mjs': 'changed',
  'index.mjs': 'changed',
  'provider-authz.mjs': 'changed',
  'provider-flags.mjs': 'changed',
  'provider-secrets.mjs': 'changed',
  'providers/actum.mjs': 'deleted',
  'providers/hmac.mjs': 'changed',
  'providers/moov.mjs': 'changed',
  'providers/plaid-sandbox.mjs': 'deleted',
  'providers/plaid.mjs': 'deleted',
  'providers/quickbooks.mjs': 'deleted',
  'sandbox-credentials.mjs': 'changed',
  'sandbox.mjs': 'changed',
};
// Files main changed after the second rebuilds were applied (staging run 39633656412 of main fd1e059b5,
// production run 39636816351 of main e4daedefe, both live at CodeSha256 Bh/f7zaI...), one reviewed
// entry each. The applied sections keep their recorded hashes as evidence: a listed file is either
// absent from a section, or a member whose accepted hash (the bytes those rebuilds put live) is no
// longer main's bytes. Each environment takes the new bytes through the overlay plan (where they are
// members) or a new inspect and plan section. checkalt-eligibility.mjs reached staging and production
// through the #1124 overlay runs (staging 39662525342, production 39663019340); the third staging
// section (inspect 39663300105) and the third production section (inspect 39666717878) accept
// providers/webhooks.mjs and add providers/moov-transfer-webhook.mjs.
const CHANGED_SINCE_SECOND_REBUILD = {
  // Check Alt eligibility SELECT without front_image_deposit_path (an overlay plan REPLACE member).
  'providers/production/checkalt-eligibility.mjs': 'changed',
  // Moov transfer returns (#1116): production transfer.* events go to providers/moov-transfer-webhook.mjs.
  'providers/webhooks.mjs': 'changed',
  // Check Alt approve reconcile history fix (2026-10-22): changed after the third rebuild
  // (production run 39669873076 of main 008af40e2), taken through the production overlay plan
  // (REPLACE members), not a rebuild section.
  'providers/production/checkalt-poll.mjs': 'changed',
  'providers/production/checkalt-status-read.mjs': 'changed',
  // Check Alt scheduled status check (2026-10-22): the reconcile job runs as the platform-owner
  // actor with per-row savepoints, and scheduled.mjs accepts the EventBridge Scheduler direct
  // invocation; both REPLACE members of the production overlay plan, not a rebuild section.
  'providers/production/checkalt-status-reconcile.mjs': 'changed',
  'scheduled.mjs': 'changed',
  // Referral billing credit (2026-10-23, SQL 111): a REPLACE member of the production overlay plan,
  // not a rebuild section.
  'tenant-billing-engine.mjs': 'changed',
  // Refer & Earn routes (2026-10-23, SQL 111): REPLACE members of the production overlay plan,
  // not a rebuild section.
  'data.mjs': 'changed',
  'workflow-rpc.mjs': 'changed',
  // Production Invoices (2026-10-22): providers.mjs routes moov-invoice to the added
  // providers/production/moov-invoice.mjs before the production hard block; a REPLACE member of
  // the production overlay plan, not a rebuild section.
  'providers.mjs': 'changed',
  // Platform Finance P&L accuracy (2026-10-23): calendar-month buckets, production money only;
  // a REPLACE member of the production overlay plan, not a rebuild section.
  'providers/parity/platform-finance.mjs': 'changed',
  // Moov payees (2026-10-23, SQL 113): the catalog adds moov-recipient-link-resend and opens
  // homeowner-bank-link-send for the added providers/payees handlers; a REPLACE member of the
  // production overlay plan when it is deployed, not a rebuild section.
  'providers/catalog.mjs': 'changed',
  // Write echo secret columns (2026-10-24): handleWrite strips the written table's secret columns
  // (the added secret-columns.mjs) from the rows it returns; a REPLACE member of the production
  // overlay plan when it is deployed, not a rebuild section.
  'write.mjs': 'changed',
  // Production email to every recipient (2026-10-25): SES mode on production delivers every
  // recipient instead of the staging allowlist; a REPLACE member of the production overlay plan,
  // not a rebuild section.
  'email-policy.mjs': 'changed',
  // Stakeholder settings edit (2026-10-25): WRITE_ALLOWLIST.stakeholder_accounts for Settings >
  // Stakeholder Accounts (remove a non-payee, change type); a REPLACE member of the production
  // overlay plan, not a rebuild section.
  'write-allowlist.mjs': 'changed',
  // DB validator SQL 120 triggers (2026-10-27): the two usage-event triggers SQL 120 added join the
  // justified public trigger set (182); deployed to staging by the guarded overlay, not a rebuild
  // section. SQL 121 and SQL 123 (#1338) raised it to 184; a REPLACE member of the production
  // overlay plan (2026-10-28). SQL 143's trigger raised it to 185 (planned REPLACE, 2026-11-05); SQL 152's two triggers to 187 (planned REPLACE, 2026-11-11); SQL 154's two to 189 and SQL 155's to 190 (planned REPLACE, 2026-11-11).
  'db-readonly-validate.mjs': 'changed',
  // Check reconciliation tenant scope (2026-10-29, security audit finding 4): a non-owner keeps only
  // the stuck checks of its own tenants (get_stuck_checks returns no tenant_id); a REPLACE member of
  // the production overlay plan, not a rebuild section.
  'check-reconciliation.mjs': 'changed',
  // Endorsement email to every recipient (2026-10-29): on production the Resend endorsement mailer
  // sends to every recipient and keeps every CC; a REPLACE member of the production overlay plan,
  // not a rebuild section.
  'endorsement-parity.mjs': 'changed',
  // Homeowner portal signing (2026-10-29, SQL 127): the portal pair {ledger_token, signer_id} signs
  // documents (signature-submit.mjs, now importing storage.mjs) and an expired homeowner signer stays
  // listed (homeowner-signing-integration.mjs); REPLACE members of the production overlay plan, not a
  // rebuild section.
  'signature-submit.mjs': 'changed',
  'homeowner-signing-integration.mjs': 'changed',
  // Moov webhook body confirmation (2026-10-31, security audit finding): Collection V2 settlement
  // matches the ` · moov:<id>` notes token exactly instead of LIKE '%id%'; a REPLACE row of the
  // production overlay plan, not a rebuild section.
  'tenant-collection-v2-settlement.mjs': 'changed',
  // Money-write flag (2026-10-31, security audit finding 14, step 1 of 2): the money-table writers
  // set the server-only request.money_write flag (the added money-write-flag.mjs) before they
  // write; REPLACE rows of the production overlay plan where they are members, otherwise a later
  // rebuild, not a rebuild section. (tenant-billing-engine.mjs and
  // tenant-collection-v2-settlement.mjs are listed above.)
  'invoice-provider.mjs': 'changed',
  'mortgage-ops-usage.mjs': 'changed',
  'providers/parity/moov-functions.mjs': 'changed',
  'providers/production/moov-wallet-sync.mjs': 'changed',
  'tenant-billing-handlers.mjs': 'changed',
  'tenant-collection-v2.mjs': 'changed',
  'tenant-collection-v2-uat.mjs': 'changed',
  'tenant-settings-handlers.mjs': 'changed',
  // Money step-up window (2026-10-31, security audit finding 7): every money step-up must be
  // verified within 15 minutes; a REPLACE row of the production overlay plan, not a rebuild section.
  'providers/production/moov-fund-authz.mjs': 'changed',
  // OCR payee address split (2026-11-06, production check 2f676a72): the payee names stay on
  // payee_line and the scanned mailing address goes to payee_address; REPLACE rows of the production
  // overlay plan, not a rebuild section.
  'ocr-parse.mjs': 'changed',
  'check-ocr-provider.mjs': 'changed',
  'ocr-descriptive-persist.mjs': 'changed',
  // Settlement bank (2026-11-12, owner: Condition One's settlement bank showed nothing): a failing
  // Moov read no longer fails the whole sweep snapshot; the bank from the database still shows. A
  // rebuild-only change (see OVERLAY_PLAN_CHANGES), not a member of the current rebuild section.
  'providers/parity/sweep-read.mjs': 'changed',
};
// Members of the current (third) rebuild sections that main changed after those rebuilds were
// applied (staging run 39666390516, production run 39669873076 of main 008af40e2). The sections keep
// the accepted hash they recorded as evidence; the new bytes go through the production overlay plan.
const CHANGED_SINCE_THIRD_REBUILD = new Set([
  // Moov webhook body confirmation (2026-10-31): a REPLACE row of the production overlay plan.
  'providers/webhooks.mjs',
]);
const assertThirdSectionAccepted = (apiRoot, name, accepted) => {
  const onMain = sha256(fs.readFileSync(path.join(apiRoot, name)));
  if (CHANGED_SINCE_THIRD_REBUILD.has(name)) assert.notEqual(onMain, accepted, `${name} is listed as changed since the third rebuild but main still has the accepted bytes`);
  else assert.equal(onMain, accepted, name);
};
// Members of the fourth production rebuild section (apply run 41469896446, 2026-11-02) that main changed after
// it was applied. The section keeps the accepted hash it recorded as evidence; the new bytes go through the
// production overlay plan, whose row expects the bytes the rebuild put live.
const CHANGED_SINCE_FOURTH_PRODUCTION_REBUILD = new Set([
  // Public marketing demo request (2026-11-05): the Class A name demo-request routed to public-demo-request.mjs.
  'app-services.mjs',
  // Login MFA (2026-11-06): the login.mfa step-up binding and loginMfa in /auth/mfa/status.
  'auth-financial-totp.mjs',
  // Fee pull savepoints (production incident 2026-11-06): every pull statement after the provider call under its
  // own savepoint, and a Moov 409 idempotent replay recorded as the leg.
  'tenant-billing-engine.mjs',
  'tenant-collection-v2.mjs',
  // Starter Package (2026-11-10, SQL 151, planning only): tenant-billing-admin update passes starter_package.
  'tenant-billing-handlers.mjs',
  // Second mortgage company fee (2026-11-11, SQL 153, planning only): the 2nd company's accept records the check's
  // normal charge and the flat $5. Not an overlay member: it reaches a function only with a rebuild.
  'mortgage-ops-usage.mjs',
]);
// Members of the fourth staging section (history[3], inspect 41311016111) that main changed since: the section keeps
// the accepted hash it recorded as evidence; the new bytes are the fifth staging section's (inspect 43207489743).
const CHANGED_SINCE_FOURTH_STAGING_SECTION = new Set([
  // Second mortgage company fee (2026-11-11, SQL 153, planning only).
  'mortgage-ops-usage.mjs',
]);
// Of those, the members whose overlay REPLACE has since been applied in production and recorded: the row expects main's
// bytes and names the applied record, whose previous_manifest (the planning manifest) started from the rebuild's bytes.
// Fee pull savepoints: production runs 42302929689 and 42303279340 (2026-11-06). Public demo request: production run
// 42105010522 (2026-11-05, recorded 2026-11-10).
const APPLIED_SINCE_FOURTH_PRODUCTION_REBUILD = {
  'app-services.mjs': 'aws/tests/fixtures/production-public-demo-request-applied-manifest-2026-11-05.json',
  'tenant-billing-engine.mjs': 'aws/tests/fixtures/production-fee-pull-savepoints-applied-manifest-2026-11-06.json',
  'tenant-collection-v2.mjs': 'aws/tests/fixtures/production-fee-pull-savepoints-applied-manifest-2026-11-06.json',
};
// Transfer to bank (2026-11-13, owner "Start the transfer to bank API"): app-services.mjs, providers.mjs, providers/catalog.mjs
// and providers/moov-status-catch-up.mjs change and wallet-withdraw-limits.mjs, fed-holidays.mjs and
// providers/production/moov-wallet-withdraw.mjs are added. Planning only: the overlay plan rows (this manifest) keep main's bytes
// accepted from the bytes each row recorded live; the change is intended for the next full-package rebuild, whose staging and
// production sections are written from their own inspects. The seventh staging section (inspect 43458069245) lists all seven;
// no applied section does.
const TRANSFER_TO_BANK_MANIFEST = 'aws/tests/fixtures/production-wallet-transfer-to-bank-manifest-2026-11-13.json';
// Vendor payments API (2026-11-13, owner "Start the vendor payments API and screens"): providers/production/moov-send.mjs,
// workflow-rpc.mjs and tenant-billing-handlers.mjs REPLACE their applied bytes through the production overlay plan (held on
// SQL 165 / SQL 165 / SQL 154, unchanged), planning only. Not a member of any recorded rebuild section; the history checks read each row
// as it stood before that plan (vendorApiPre).
const VENDOR_API_MANIFEST = 'aws/tests/fixtures/production-vendor-payments-api-manifest-2026-11-13.json';
const vendorApiPre = (row) => {
  if (!row || row.manifest !== VENDOR_API_MANIFEST) return row;
  const planned = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, VENDOR_API_MANIFEST), 'utf8')).members;
  const entry = Object.values(planned).find((e) => e.accepted_sha256 === row.accepted_sha256 && e.live_sha256 === row.expected_live_sha256);
  assert.ok(entry, 'a vendor payments API row names its manifest entry');
  return { ...row, accepted_sha256: entry.live_sha256, expected_live_sha256: entry.live_sha256, manifest: entry.previous_manifest };
};
// Listed changes that go through the production overlay plan, never the current rebuild section.
const OVERLAY_PLAN_CHANGES = new Set([
  // Settlement bank fallback (2026-11-12): a Moov read failure no longer hides the bank on file. Not an overlay
  // member: it reaches a function only with a rebuild. Production inspect 43308083143 (main 83a508fb1,
  // ALREADY_ACCEPTED, 0 changed) shows production runs main's previous bytes 4da8e0c0...; the sixth staging
  // section (inspect 43416770262) lists it.
  'providers/parity/sweep-read.mjs',
  'providers/production/checkalt-eligibility.mjs',
  'providers/production/checkalt-poll.mjs',
  'providers/production/checkalt-status-read.mjs',
  'providers/production/checkalt-status-reconcile.mjs',
  'scheduled.mjs',
  'tenant-billing-engine.mjs',
  'data.mjs',
  'workflow-rpc.mjs',
  'providers.mjs',
  'providers/parity/platform-finance.mjs',
  'providers/catalog.mjs',
  'write.mjs',
  'email-policy.mjs',
  'write-allowlist.mjs',
  // Deployed by the guarded overlay (staging run 40739554272; a REPLACE row of the production plan).
  'db-readonly-validate.mjs',
  // Security audit finding 4 (2026-10-29): a REPLACE row of the production plan.
  'check-reconciliation.mjs',
  // Endorsement email to every recipient (2026-10-29): a REPLACE row of the production plan.
  'endorsement-parity.mjs',
  // Homeowner portal signing (2026-10-29): REPLACE rows of the production plan, held on SQL 127.
  'signature-submit.mjs',
  'homeowner-signing-integration.mjs',
  // Moov webhook body confirmation (2026-10-31): a REPLACE row of the production plan.
  'tenant-collection-v2-settlement.mjs',
  // Money-write flag (2026-10-31, finding 14 step 1): REPLACE rows of the production plan
  // (moov-functions, moov-wallet-sync, tenant-billing-handlers, tenant-collection-v2,
  // tenant-settings-handlers). invoice-provider.mjs, mortgage-ops-usage.mjs and
  // tenant-collection-v2-uat.mjs are not overlay members: they reach a function only with a
  // rebuild (the fourth staging section, inspect 41311016111, lists exactly these three).
  'invoice-provider.mjs',
  'mortgage-ops-usage.mjs',
  'providers/parity/moov-functions.mjs',
  'providers/production/moov-wallet-sync.mjs',
  'tenant-billing-handlers.mjs',
  'tenant-collection-v2.mjs',
  'tenant-collection-v2-uat.mjs',
  'tenant-settings-handlers.mjs',
  // Money step-up window (2026-10-31, finding 7): a REPLACE row of the production plan.
  'providers/production/moov-fund-authz.mjs',
  // OCR payee address split (2026-11-06): REPLACE rows of the production plan.
  'ocr-parse.mjs',
  'check-ocr-provider.mjs',
  'ocr-descriptive-persist.mjs',
]);
const assertSectionAcceptedIsMain = (apiRoot, name, accepted) => {
  const onMain = sha256(fs.readFileSync(path.join(apiRoot, name)));
  if (CHANGED_SINCE_SECOND_REBUILD[name]) assert.notEqual(onMain, accepted, `${name} is listed as changed but main still has the accepted bytes`);
  else assert.equal(onMain, accepted, name);
};

const assertAcceptedIsMainUnlessChangedSince = (apiRoot, name, accepted) => {
  const abs = path.join(apiRoot, name);
  const listed = CHANGED_SINCE_APPLIED_REBUILD[name] || CHANGED_SINCE_SECOND_REBUILD[name];
  if (!fs.existsSync(abs)) {
    assert.equal(listed, 'deleted', `${name} is gone from main but not listed as deleted`);
    return;
  }
  const onMain = sha256(fs.readFileSync(abs));
  if (onMain === accepted) {
    assert.equal(listed, undefined, `${name} is listed as changed but main still has the accepted bytes`);
    return;
  }
  assert.equal(listed, 'changed', `${name}: main's bytes are not the accepted bytes and the file is not listed`);
};

const LIVE_FILES = {
  'index.mjs': 'export const handler = "live";\n',
  'package.json': '{"name":"api","version":"0.1.0"}\n',
  'package-lock.json': '{"name":"api","lockfileVersion":3}\n',
  'ocr.mjs': 'export const ocr = "same";\n',
  'write.mjs': 'export const write = "live";\n',
  'live-only.mjs': 'export const liveOnly = true;\n',
  'node_modules/pg/package.json': '{"name":"pg","version":"8.23.0"}\n',
  'node_modules/pg/index.js': 'module.exports = {};\n',
  'node_modules/@aws-sdk/client-s3/package.json': '{"name":"@aws-sdk/client-s3","version":"3.1124.0"}\n',
};
const CANDIDATE_FILES = {
  ...LIVE_FILES,
  'write.mjs': 'export const write = "main";\n',
  'new-on-main.mjs': 'export const added = true;\n',
  'node_modules/@aws-sdk/client-kms/package.json': '{"name":"@aws-sdk/client-kms","version":"3.1124.0"}\n',
  'node_modules/@aws-sdk/client-kms/index.js': 'module.exports = {};\n',
};
delete CANDIDATE_FILES['live-only.mjs'];

const hashes = (files) => Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha256(text)]));
const inventoryOf = (files) => packageInventory(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, Buffer.from(text)])));

const FULL_PLAN = {
  function_name: 'checksops-staging-api',
  members: { 'write.mjs': { live_sha256: sha256(LIVE_FILES['write.mjs']), accepted_sha256: sha256(CANDIDATE_FILES['write.mjs']) } },
  added: { 'new-on-main.mjs': sha256(CANDIDATE_FILES['new-on-main.mjs']) },
  removed: { 'live-only.mjs': sha256(LIVE_FILES['live-only.mjs']) },
  dependencies: { added: { 'node_modules/@aws-sdk/client-kms': '3.1124.0' }, removed: {}, changed: {} },
};
const planFor = (section) => ({ environments: { staging: section } });

function writeTree(root, files) {
  for (const [name, text] of Object.entries(files)) {
    const abs = path.join(root, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
}

function tmpRepo({ candidate = CANDIDATE_FILES, plan = FULL_PLAN } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-rebuild-'));
  fs.mkdirSync(path.join(root, 'ops/deployment-guard'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/accepted-contracts.json'), path.join(root, 'ops/deployment-guard/accepted-contracts.json'));
  fs.writeFileSync(path.join(root, REBUILD_PLAN_REL), JSON.stringify({ environments: { staging: plan, production: { ...plan, function_name: 'checksops-production-prep-api' } } }));
  writeTree(path.join(root, 'aws/functions/api'), candidate);
  return root;
}

test('lambda-rebuild is a registered deployment type and the component carries the candidate hash', () => {
  assert.ok(DEPLOYMENT_TYPES.includes(REBUILD_DEPLOYMENT_TYPE));
  const component = fullPackageComponent('b'.repeat(64));
  assert.equal(parseFullPackageComponent(component), 'b'.repeat(64));
  assert.equal(parseFullPackageComponent('write.mjs'), null);
  assert.throws(() => fullPackageComponent('short'), /candidate ZIP SHA-256/);
});

test('the committed plan loads for both environments', () => {
  for (const environment of ['staging', 'production']) {
    const section = loadRebuildPlan(REPO_ROOT, environment);
    assert.ok(section.function_name.startsWith('checksops-'));
  }
});

test('the production history keeps the first rebuild (inspect 39587583692, apply 39588578627) and every accepted hash is the bytes on main or a listed later change', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/lambda-rebuild-plan.json'), 'utf8'));
  assert.equal(raw.environments.production.history.length, 6);
  const production = raw.environments.production.history[0];
  assert.equal(production.status, 'applied');
  assert.equal(production.applied.run_id, '39588578627');
  assert.equal(production.applied.code_sha256_after, 'sxodWyRpUr0LbETU0YhBayaqYe1VsfNBQi1OoMZpd4U=');
  assert.equal(production.applied.candidate_zip_sha256, production.inspect.candidate_zip_sha256);
  assert.equal(production.inspect.run_id, '39587583692');
  assert.equal(production.inspect.live_code_sha256, 'ephceZY0Zjg7Dscil3D2cdtZzzAWellnHprPDYZ/50w=');
  assert.equal(production.inspect.candidate_zip_sha256, raw.environments.staging.history[0].inspect.candidate_zip_sha256);
  assert.equal(production.inspect.staging_acceptance, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39587414391');
  const section = production;
  assert.equal(Object.keys(section.members).length, 13);
  assert.equal(Object.keys(section.added).length, 9);
  assert.deepEqual(section.removed, {});
  assert.deepEqual(section.dependencies, { added: { 'node_modules/@aws-sdk/client-kms': '3.1124.0' }, removed: {}, changed: {} });
  const apiRoot = path.join(REPO_ROOT, 'aws/functions/api');
  for (const [name, entry] of Object.entries(section.members)) {
    assertAcceptedIsMainUnlessChangedSince(apiRoot, name, entry.accepted_sha256);
  }
  for (const [name, hash] of Object.entries(section.added)) {
    assertAcceptedIsMainUnlessChangedSince(apiRoot, name, hash);
  }
  const live = {};
  const candidate = {};
  for (const [name, entry] of Object.entries(section.members)) { live[name] = entry.live_sha256; candidate[name] = entry.accepted_sha256; }
  for (const [name, hash] of Object.entries(section.added)) candidate[name] = hash;
  // The recorded section still made the first inspected live package READY, not BLOCKED.
  const plan = { environments: { production: { function_name: raw.environments.production.function_name, ...production } } };
  const result = evaluateRebuild({ plan, environment: 'production', liveMemberHashes: live, candidateMemberHashes: candidate, liveInventory: {}, candidateInventory: { 'node_modules/@aws-sdk/client-kms': '3.1124.0' } });
  assert.equal(result.ok, true);
  assert.equal(result.details.state, 'READY');
});

test('the production history keeps the second rebuild (inspect 39633975144, apply 39636816351): the Plaid/Actum/QuickBooks removal, the same 19 changed and 4 removed as staging', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/lambda-rebuild-plan.json'), 'utf8'));
  const production = raw.environments.production.history[1];
  const staging = raw.environments.staging;
  const first = raw.environments.production.history[0];
  assert.equal(production.status, 'applied');
  assert.equal(production.applied.run_id, '39636816351');
  assert.equal(production.applied.code_sha256_after, 'Bh/f7zaIFGDECA1jTWgMeR/2qRMOUaABRWP1lQbREOc=');
  assert.equal(production.applied.candidate_zip_sha256, production.inspect.candidate_zip_sha256);
  assert.equal(production.inspect.run_id, '39633975144');
  assert.equal(production.inspect.main_commit, 'fd1e059b573ce16dfe51c07c37827aad2fb9bd04');
  assert.equal(production.inspect.live_code_sha256, 'sxodWyRpUr0LbETU0YhBayaqYe1VsfNBQi1OoMZpd4U=');
  assert.equal(production.inspect.live_revision_id, '6cb46f3a-e10d-4645-b18d-6e5b156d65d9');
  assert.equal(production.inspect.candidate_zip_sha256, '061fdfef36881460c4080d634d680c791ff6a9130e51a0014563f59506d110e7');
  assert.equal(production.inspect.staging_acceptance, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39633656412');
  // The package the rebuild starts from is the one the first rebuild left live, and the candidate is
  // the ZIP staging accepted.
  assert.equal(production.inspect.live_code_sha256, first.applied.code_sha256_after);
  assert.equal(production.inspect.candidate_zip_sha256, staging.history[1].inspect.candidate_zip_sha256);
  const section = production;
  assert.equal(Object.keys(section.members).length, 19);
  assert.deepEqual(section.added, {});
  assert.deepEqual(Object.keys(section.removed).sort(), ['providers/actum.mjs', 'providers/plaid-sandbox.mjs', 'providers/plaid.mjs', 'providers/quickbooks.mjs']);
  assert.deepEqual(section.dependencies, { added: {}, removed: {}, changed: {} });
  assert.equal(production.inspect.changed, 19);
  assert.equal(production.inspect.added, 0);
  assert.equal(production.inspect.removed, 4);
  // Production and staging ran the same package after the first rebuild, so the differences match.
  assert.deepEqual(section.members, staging.history[1].members);
  assert.deepEqual(section.removed, staging.history[1].removed);
  const apiRoot = path.join(REPO_ROOT, 'aws/functions/api');
  // Both first rebuilds put the same ZIP live; a file either section listed has those accepted bytes.
  const firstAccepted = (name) => first.members[name]?.accepted_sha256 || first.added[name]
    || staging.history[0].members[name]?.accepted_sha256 || staging.history[0].added[name] || null;
  for (const [name, entry] of Object.entries(section.members)) {
    assertSectionAcceptedIsMain(apiRoot, name, entry.accepted_sha256);
    const before = firstAccepted(name);
    if (before) assert.equal(entry.live_sha256, before, name);
  }
  for (const [name, hash] of Object.entries(section.removed)) {
    assert.equal(fs.existsSync(path.join(apiRoot, name)), false, `${name} is listed as removed but main still has it`);
    assert.equal(hash, firstAccepted(name), name);
  }
  for (const [name, kind] of Object.entries(CHANGED_SINCE_APPLIED_REBUILD)) {
    if (kind === 'deleted') assert.ok(section.removed[name], `${name} is deleted on main but not listed as removed`);
    else assert.ok(section.members[name], `${name} changed on main but is not a production member`);
  }
  // Files changed after the applied second rebuild are either not in its section (a new inspect moves
  // them into its own section) or members whose recorded accepted hash is not main's bytes (checked above).
  for (const name of Object.keys(CHANGED_SINCE_SECOND_REBUILD)) {
    if (!section.members[name]) assert.equal(section.removed[name] || section.added[name], undefined, name);
  }
  // The plan as committed makes the inspected live package READY, not BLOCKED.
  const live = {};
  const candidate = {};
  for (const [name, entry] of Object.entries(section.members)) { live[name] = entry.live_sha256; candidate[name] = entry.accepted_sha256; }
  for (const [name, hash] of Object.entries(section.removed)) live[name] = hash;
  // The recorded section still made the second inspected live package READY, not BLOCKED.
  const plan = { environments: { production: { function_name: raw.environments.production.function_name, ...production } } };
  const result = evaluateRebuild({ plan, environment: 'production', liveMemberHashes: live, candidateMemberHashes: candidate, liveInventory: {}, candidateInventory: {} });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.state, 'READY');
});

test('the production history keeps the third rebuild (inspect 39666717878, apply 39669873076): Moov transfer returns, the same 1 changed and 1 added as staging', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/lambda-rebuild-plan.json'), 'utf8'));
  const production = raw.environments.production.history[2];
  const staging = raw.environments.staging;
  const second = raw.environments.production.history[1];
  assert.equal(production.status, 'applied');
  assert.equal(production.applied.run_id, '39669873076');
  const stagingThird = staging.history[2];
  assert.equal(production.applied.staging_acceptance, stagingThird.applied.run_url);
  assert.equal(production.applied.code_sha256_before, production.inspect.live_code_sha256);
  assert.equal(production.applied.code_sha256_after, stagingThird.applied.code_sha256_after);
  assert.equal(production.applied.candidate_zip_sha256, production.inspect.candidate_zip_sha256);
  assert.equal(production.inspect.run_id, '39666717878');
  assert.equal(production.inspect.main_commit, '96361081c5458bf4de46330b87285fa954b25bbb');
  assert.equal(production.inspect.live_code_sha256, '+cyvVRtA46woHP4FwFBBZoN80aXR4A8Vo6adu5E1/NE=');
  assert.equal(production.inspect.live_revision_id, 'e8820705-bb70-45ab-ae84-8cc43ee8fd86');
  assert.equal(production.inspect.candidate_zip_sha256, 'a4d09ec006855355b523a176669028ec4970127d6f145997bdfb7d8fabecaff7');
  assert.equal(production.inspect.staging_acceptance, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39666390516');
  // The package the rebuild starts from is the second rebuild's plus the #1124 overlay (production
  // overlay run 39663019340): the same package staging inspected before its third rebuild. The
  // candidate is the ZIP staging accepted.
  assert.notEqual(production.inspect.live_code_sha256, second.applied.code_sha256_after);
  assert.equal(production.inspect.live_code_sha256, stagingThird.inspect.live_code_sha256);
  assert.equal(production.inspect.candidate_zip_sha256, stagingThird.inspect.candidate_zip_sha256);
  const section = production;
  assert.deepEqual(Object.keys(section.members), ['providers/webhooks.mjs']);
  assert.deepEqual(Object.keys(section.added), ['providers/moov-transfer-webhook.mjs']);
  assert.deepEqual(section.removed, {});
  assert.deepEqual(section.dependencies, { added: {}, removed: {}, changed: {} });
  assert.equal(production.inspect.changed, 1);
  assert.equal(production.inspect.added, 1);
  assert.equal(production.inspect.removed, 0);
  assert.deepEqual(production.inspect.dependency_counts, { live: 54, candidate: 54 });
  // Production and staging ran the same package before this rebuild, so the differences match.
  assert.deepEqual(section.members, stagingThird.members);
  assert.deepEqual(section.added, stagingThird.added);
  const apiRoot = path.join(REPO_ROOT, 'aws/functions/api');
  for (const [name, entry] of Object.entries(section.members)) {
    assertThirdSectionAccepted(apiRoot, name, entry.accepted_sha256);
    assert.equal(entry.live_sha256, second.members[name].accepted_sha256, name);
  }
  for (const [name, hash] of Object.entries(section.added)) {
    assert.equal(sha256(fs.readFileSync(path.join(apiRoot, name))), hash, name);
    assert.equal(second.members[name] || second.added[name], undefined, name);
  }
  for (const name of Object.keys(CHANGED_SINCE_SECOND_REBUILD)) {
    if (OVERLAY_PLAN_CHANGES.has(name)) assert.equal(section.members[name], undefined, name);
    else assert.ok(section.members[name], `${name} changed on main but is not a production member`);
  }
  // The recorded section still made the third inspected live package READY, not BLOCKED.
  const live = {};
  const candidate = {};
  for (const [name, entry] of Object.entries(section.members)) { live[name] = entry.live_sha256; candidate[name] = entry.accepted_sha256; }
  for (const [name, hash] of Object.entries(section.added)) candidate[name] = hash;
  const result = evaluateRebuild({ plan: { environments: { production: { function_name: raw.environments.production.function_name, ...production } } }, environment: 'production', liveMemberHashes: live, candidateMemberHashes: candidate, liveInventory: {}, candidateInventory: {} });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.state, 'READY');
});

test('the production history keeps the fourth rebuild (inspect 41463084601, apply 41469896446): the fourth rebuild (16 changed, 1 added, 0 removed), staging already on the same candidate', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/lambda-rebuild-plan.json'), 'utf8'));
  // The fifth section (inspect 43210883811) moved the fourth into history[3] verbatim.
  const production = raw.environments.production.history[3];
  const third = raw.environments.production.history[2];
  const staging = raw.environments.staging;
  // Applied 2026-11-02 (run 41469896446) on the owner's phrase, from the staging reference the section names.
  assert.equal(production.status, 'applied');
  assert.equal(production.applied.run_id, '41469896446');
  assert.equal(production.applied.main_commit, '1364af787f2e00b8578a6fbed3c52989eca7121a');
  assert.equal(production.applied.approval_phrase, 'DEPLOY FULL API PACKAGE TO PRODUCTION');
  assert.equal(production.applied.staging_acceptance, production.inspect.staging_acceptance);
  assert.equal(production.applied.code_sha256_before, production.inspect.live_code_sha256);
  assert.equal(production.applied.revision_id_before, production.inspect.live_revision_id);
  assert.equal(production.applied.candidate_zip_sha256, production.inspect.candidate_zip_sha256);
  assert.equal(production.applied.code_sha256_after, 'TQowoiwSTGO+SBFVbzpKabESHfDOF5+pLOBXwT7Y0No=');
  assert.equal(production.applied.revision_id_after, '870cc791-522b-49ee-bb04-4dd4fecc8510');
  assert.equal(production.applied.state, 'VERIFIED');
  assert.deepEqual(production.applied.smoke, ['/health', '/db-health']);
  for (const evidence of ['41468682423', '125360398863', '57321d90-58b5-46ec-98ea-8fa5873591c9', 'TQowoiwS', 'no error-level event', 'SQL 136', 'SQL 140', 'Not verified']) {
    assert.ok(production.applied.notes.includes(evidence), evidence);
  }
  // Production now runs the package staging runs (staging rebuild inspect 41463556950, ALREADY_ACCEPTED on the same candidate).
  assert.ok(production.inspect.notes.includes('TQowoiwSTGO+SBFVbzpKabESHfDOF5+pLOBXwT7Y0No='));
  assert.equal(production.inspect.run_id, '41463084601');
  assert.equal(production.inspect.main_commit, 'ba78d1ddf7a68ac42ff2bfe49e5f07ccd4f8bb11');
  assert.equal(production.inspect.live_code_sha256, '+X7Idizd5DT2QbQJAzC3oi8l52es021M3z/zh5R5Wuc=');
  assert.equal(production.inspect.live_revision_id, '91745cda-2b27-4ff4-9655-1f5754d00e7a');
  assert.equal(production.inspect.candidate_zip_sha256, '4d0a30a22c124c63be4811556f3a4a69b1121df0ce179fa92ce057c13ed8d0da');
  // The staging reference is the staging rebuild inspect of the same main commit: staging already runs that
  // exact candidate (ALREADY_ACCEPTED), through its fourth rebuild (run 41313204838) and overlays since.
  assert.equal(production.inspect.staging_acceptance, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/41463556950');
  for (const evidence of ['41463556950', 'ALREADY_ACCEPTED', 'TQowoiwSTGO+SBFVbzpKabESHfDOF5+pLOBXwT7Y0No=', '41313204838', '41234874570', '#1529', 'DEPLOY FULL API PACKAGE TO PRODUCTION', 'SQL 136', 'SQL 140']) {
    assert.ok(production.inspect.notes.includes(evidence), evidence);
  }
  // The package the rebuild starts from is the third rebuild's plus the production overlays since.
  assert.notEqual(production.inspect.live_code_sha256, third.applied.code_sha256_after);
  const section = production;
  const SIXTEEN = [
    'app-services.mjs', 'auth-financial-totp.mjs', 'check-endorsement.mjs', 'invoice-provider.mjs', 'mortgage-ops-usage.mjs',
    'providers/parity/moov-functions.mjs', 'providers/payees/handlers.mjs', 'providers/production/checkalt-authz.mjs',
    'providers/production/moov-fund-authz.mjs', 'providers/production/moov-wallet-sync.mjs', 'tenant-billing-engine.mjs',
    'tenant-billing-handlers.mjs', 'tenant-collection-v2-settlement.mjs', 'tenant-collection-v2-uat.mjs', 'tenant-collection-v2.mjs',
    'tenant-settings-handlers.mjs',
  ];
  assert.deepEqual(Object.keys(section.members), SIXTEEN);
  assert.deepEqual(Object.keys(section.added), ['money-write-flag.mjs']);
  assert.deepEqual(section.removed, {});
  assert.deepEqual(section.dependencies, { added: {}, removed: {}, changed: {} });
  assert.equal(production.inspect.same, 189);
  assert.equal(production.inspect.changed, 16);
  assert.equal(production.inspect.added, 1);
  assert.equal(production.inspect.removed, 0);
  assert.deepEqual(production.inspect.dependency_counts, { live: 54, candidate: 54 });
  const apiRoot = path.join(REPO_ROOT, 'aws/functions/api');
  // Accepted is main's bytes, unless main changed the member since (listed); live is what production ran before.
  for (const [name, entry] of Object.entries(section.members)) {
    const onMain = sha256(fs.readFileSync(path.join(apiRoot, name)));
    if (CHANGED_SINCE_FOURTH_PRODUCTION_REBUILD.has(name)) assert.notEqual(onMain, entry.accepted_sha256, `${name} is listed as changed but main still has the accepted bytes`);
    else assert.equal(onMain, entry.accepted_sha256, name);
    assert.notEqual(entry.live_sha256, entry.accepted_sha256, name);
  }
  for (const [name, hash] of Object.entries(section.added)) assert.equal(sha256(fs.readFileSync(path.join(apiRoot, name))), hash, name);
  // Where the production overlay plan has a row, the live bytes are that row's expected_live, except
  // check-endorsement.mjs: production runs 85f4bec4 (main's bytes at the third rebuild's commit), the row records 7c6ae301.
  const overlay = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/production-api-overlay-plan.json'), 'utf8'));
  for (const [name, entry] of Object.entries(section.members)) {
    // The production record of 2026-11-11 (tenant-billing-engine.mjs, tenant-billing-handlers.mjs and two other members
    // applied, VERIFIED) moved those rows to their applied records; the checks below read each row as it stood before
    // that record: the applied record's planning manifest and its live bytes.
    let row = vendorApiPre(overlay.members[name]);
    if (row && /-applied-manifest-2026-11-11\.json$/.test(row.manifest) && /second-mortgagee-fee|starter-package/.test(row.manifest)) {
      const applied = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, row.manifest), 'utf8')).members[name];
      assert.deepEqual([applied.live_sha256, applied.accepted_sha256], [row.accepted_sha256, row.accepted_sha256], name);
      const planned0 = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, applied.previous_manifest), 'utf8')).members[name];
      row = { ...row, expected_live_sha256: planned0.live_sha256, manifest: applied.previous_manifest };
    }
    if (!row) { assert.ok(['invoice-provider.mjs', 'mortgage-ops-usage.mjs', 'tenant-collection-v2-uat.mjs'].includes(name), name); continue; }
    // The transfer to bank plan (2026-11-13, planning only, intended for the full-package rebuild) moved app-services.mjs on
    // from its external disbursement applied bytes: the checks below read the row as it stood before that plan, and those
    // applied bytes stand for main's.
    let mainBytes = sha256(fs.readFileSync(path.join(apiRoot, name)));
    // (Likewise the vendor payments API plan: the applied bytes it starts from stand for main's.)
    if (overlay.members[name]?.manifest === VENDOR_API_MANIFEST) {
      assert.equal(overlay.members[name].accepted_sha256, mainBytes, name);
      mainBytes = vendorApiPre(overlay.members[name]).accepted_sha256;
    }
    if (row && row.manifest === TRANSFER_TO_BANK_MANIFEST) {
      const planned = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, row.manifest), 'utf8')).members[name];
      assert.deepEqual([row.accepted_sha256, row.expected_live_sha256], [mainBytes, planned.live_sha256], name);
      assert.equal(planned.accepted_sha256, mainBytes, name);
      row = { ...row, accepted_sha256: planned.live_sha256, expected_live_sha256: planned.live_sha256, manifest: planned.previous_manifest };
      mainBytes = planned.live_sha256;
    }
    if (CHANGED_SINCE_FOURTH_PRODUCTION_REBUILD.has(name)) {
      // The row moved on after the rebuild: main's bytes accepted, the bytes the rebuild put live expected ...
      assert.equal(row.accepted_sha256, mainBytes, name);
      const appliedRel = APPLIED_SINCE_FOURTH_PRODUCTION_REBUILD[name];
      if (name === 'tenant-collection-v2.mjs') {
        // Moved on twice: the fee pull savepoints REPLACE from the rebuild's bytes, applied 2026-11-06 (its applied
        // record), then the fee leg REPLACE (SQL 145) from those applied bytes, applied 2026-11-07 (production run
        // 42366401914): main's bytes expected live, naming the fee leg applied record.
        const recorded = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, appliedRel), 'utf8')).members[name];
        const planned = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, recorded.previous_manifest), 'utf8')).members[name];
        assert.equal(planned.live_sha256, entry.accepted_sha256, name);
        assert.equal(row.expected_live_sha256, row.accepted_sha256, name);
        assert.equal(row.manifest, 'aws/tests/fixtures/production-fee-leg-api-applied-manifest-2026-11-07.json', name);
        const feeLegApplied = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, row.manifest), 'utf8')).members[name];
        assert.equal(feeLegApplied.live_sha256, row.accepted_sha256, name);
        const feeLeg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, feeLegApplied.previous_manifest), 'utf8')).members[name];
        assert.equal(feeLeg.live_sha256, recorded.accepted_sha256, name);
        assert.equal(feeLeg.previous_manifest, appliedRel, name);
        continue;
      }
      if (name === 'app-services.mjs') {
        // Moved on twice: the public demo request REPLACE from the rebuild's bytes, applied 2026-11-05 (production run
        // 42105010522, its applied record), then the external disbursement REPLACE (#1729) from those applied bytes,
        // applied 2026-11-10 (production run 42879179121): main's bytes expected live, naming the external disbursement
        // applied record, whose reconciled planning manifest started from the applied demo request bytes.
        const recorded = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, appliedRel), 'utf8')).members[name];
        const planned = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, recorded.previous_manifest), 'utf8')).members[name];
        assert.equal(planned.live_sha256, entry.accepted_sha256, name);
        assert.equal(recorded.live_sha256, recorded.accepted_sha256, name);
        assert.equal(row.expected_live_sha256, row.accepted_sha256, name);
        assert.notEqual(row.accepted_sha256, recorded.accepted_sha256, name);
        assert.equal(row.manifest, 'aws/tests/fixtures/production-external-disbursement-applied-manifest-2026-11-10.json', name);
        const externalApplied = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, row.manifest), 'utf8')).members[name];
        assert.deepEqual(externalApplied, { live_sha256: row.accepted_sha256, accepted_sha256: row.accepted_sha256, operation: 'replace', previous_manifest: 'aws/tests/fixtures/production-external-disbursement-router-reconciled-manifest-2026-11-10.json' }, name);
        const next = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, externalApplied.previous_manifest), 'utf8')).members[name];
        assert.deepEqual(next, { live_sha256: recorded.accepted_sha256, accepted_sha256: row.accepted_sha256, operation: 'replace', previous_manifest: appliedRel }, name);
        continue;
      }
      if (name === 'tenant-billing-engine.mjs' && [
        'aws/tests/fixtures/production-usage-fees-manifest-2026-11-10.json',
        'aws/tests/fixtures/production-starter-package-manifest-2026-11-10.json',
        'aws/tests/fixtures/production-second-mortgagee-fee-manifest-2026-11-11.json',
      ].includes(row.manifest)) {
        // Moved on twice: the fee pull savepoints REPLACE from the rebuild's bytes, applied 2026-11-06 (its applied
        // record), then the usage fees REPLACE (SQL 149, 2026-11-10, planning only) from those applied bytes, which the
        // Starter Package REPLACE (SQL 151, planning only) supersedes from the same applied bytes, and the second
        // mortgagee fee REPLACE (2026-11-11, planning only) supersedes in turn.
        const recorded = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, appliedRel), 'utf8')).members[name];
        const planned = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, recorded.previous_manifest), 'utf8')).members[name];
        assert.equal(planned.live_sha256, entry.accepted_sha256, name);
        assert.equal(recorded.live_sha256, recorded.accepted_sha256, name);
        assert.equal(row.expected_live_sha256, recorded.accepted_sha256, name);
        assert.notEqual(row.accepted_sha256, recorded.accepted_sha256, name);
        const usageFees = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, row.manifest), 'utf8')).members[name];
        const { supersedes_unapplied_manifest: superseded, ...planned2 } = usageFees;
        assert.deepEqual(planned2, { live_sha256: recorded.accepted_sha256, accepted_sha256: row.accepted_sha256, operation: 'replace', previous_manifest: appliedRel }, name);
        if (row.manifest === 'aws/tests/fixtures/production-second-mortgagee-fee-manifest-2026-11-11.json') {
          assert.equal(superseded, 'aws/tests/fixtures/production-starter-package-manifest-2026-11-10.json', name);
          const starter = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, superseded), 'utf8')).members[name];
          assert.deepEqual([starter.live_sha256, starter.previous_manifest, starter.supersedes_unapplied_manifest],
            [recorded.accepted_sha256, appliedRel, 'aws/tests/fixtures/production-usage-fees-manifest-2026-11-10.json'], name);
          assert.notEqual(starter.accepted_sha256, row.accepted_sha256, name);
        } else if (superseded) assert.equal(superseded, 'aws/tests/fixtures/production-usage-fees-manifest-2026-11-10.json', name);
        continue;
      }
      if (name === 'tenant-billing-handlers.mjs') {
        // Not applied since the rebuild: the Starter Package REPLACE (SQL 151, planning only) starts from the bytes the
        // rebuild put live, main's bytes accepted.
        assert.equal(row.expected_live_sha256, entry.accepted_sha256, name);
        assert.equal(row.manifest, 'aws/tests/fixtures/production-starter-package-manifest-2026-11-10.json', name);
        const planned3 = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, row.manifest), 'utf8')).members[name];
        assert.deepEqual([planned3.live_sha256, planned3.accepted_sha256], [entry.accepted_sha256, row.accepted_sha256], name);
        continue;
      }
      if (appliedRel) {
        // ... unless that REPLACE has been applied since: main's bytes expected live, naming the applied record,
        // whose planning manifest started from the bytes the rebuild put live.
        assert.equal(row.expected_live_sha256, row.accepted_sha256, name);
        assert.equal(row.manifest, appliedRel, name);
        const recorded = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, appliedRel), 'utf8')).members[name];
        assert.equal(recorded.live_sha256, row.accepted_sha256, name);
        const planned = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, recorded.previous_manifest), 'utf8')).members[name];
        assert.equal(planned.live_sha256, entry.accepted_sha256, name);
        continue;
      }
      assert.equal(row.expected_live_sha256, entry.accepted_sha256, name);
      continue;
    }
    assert.equal(row.accepted_sha256, entry.accepted_sha256, name);
    if (name === 'check-endorsement.mjs') {
      assert.equal(entry.live_sha256, '85f4bec43620e574498a289e6d245ddd02301603fd6698a1d6bacb915e922677');
      assert.equal(row.expected_live_sha256, '7c6ae30182358a80184b9617188c59356f357e94d2c79fc875d9d74f8e82e3da');
    } else {
      assert.equal(row.expected_live_sha256, entry.live_sha256, name);
    }
  }
  // The three files that are not overlay members start from the bytes the staging fourth section (history[3]) started from.
  for (const name of ['invoice-provider.mjs', 'mortgage-ops-usage.mjs', 'tenant-collection-v2-uat.mjs']) {
    assert.equal(section.members[name].live_sha256, staging.history[3].members[name].live_sha256, name);
  }
  // providers/webhooks.mjs: the third section listed it at f7353ee1; production runs main's 59b58674 since the
  // guarded overlay of the Moov webhook body confirmation, so it is not a member and is not drifted any more.
  assert.equal(section.members['providers/webhooks.mjs'], undefined);
  assert.equal(third.members['providers/webhooks.mjs'].accepted_sha256, 'f7353ee1673364d45ce564dd8b7f102273e9a871c63f8398d03bd7226360d97f');
  // The plan as committed makes the inspected live package READY, not BLOCKED.
  const live = {};
  const candidate = {};
  for (const [name, entry] of Object.entries(section.members)) { live[name] = entry.live_sha256; candidate[name] = entry.accepted_sha256; }
  for (const [name, hash] of Object.entries(section.added)) candidate[name] = hash;
  const webhooks = sha256(fs.readFileSync(path.join(apiRoot, 'providers/webhooks.mjs')));
  live['providers/webhooks.mjs'] = webhooks;
  candidate['providers/webhooks.mjs'] = webhooks;
  const result = evaluateRebuild({ plan: { environments: { production: { function_name: raw.environments.production.function_name, ...production } } }, environment: 'production', liveMemberHashes: live, candidateMemberHashes: candidate, liveInventory: {}, candidateInventory: {} });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.state, 'READY');
});

test('the production history keeps the fifth section (inspect 43210883811, apply 43215807509): the second mortgage company fee rebuild (1 changed, 0 added, 0 removed), the candidate staging applied and verified', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/lambda-rebuild-plan.json'), 'utf8'));
  // The sixth section (inspect 43425291017) moved the fifth into history[4] verbatim.
  const production = raw.environments.production.history[4];
  const fourth = raw.environments.production.history[3];
  // The staging fifth section (inspect 43207489743, apply 43210074311) is history[4] since the sixth (inspect 43416770262).
  const staging = raw.environments.staging.history[4];
  // Applied 2026-11-12 (run 43215807509) on the owner's phrase, from the staging reference the section names.
  assert.equal(production.status, 'applied');
  assert.equal(production.applied.run_id, '43215807509');
  assert.equal(production.applied.run_url, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/43215807509');
  assert.equal(production.applied.main_commit, 'f6506083c4fa16f9620764d9aa480ff2ba8794a9');
  assert.equal(production.applied.approval_phrase, 'DEPLOY FULL API PACKAGE TO PRODUCTION');
  assert.equal(production.applied.staging_acceptance, production.inspect.staging_acceptance);
  assert.equal(production.applied.code_sha256_before, production.inspect.live_code_sha256);
  assert.equal(production.applied.revision_id_before, production.inspect.live_revision_id);
  assert.equal(production.applied.candidate_zip_sha256, production.inspect.candidate_zip_sha256);
  assert.equal(production.applied.code_sha256_after, '2NKoKhkxtfOpsoTGA3/9SekMHMH8EcmSchqWFMVWoIw=');
  assert.equal(production.applied.revision_id_after, '27206d2d-b0e4-43f8-93d6-ad0da538091c');
  assert.equal(production.applied.state, 'VERIFIED');
  assert.deepEqual(production.applied.smoke, ['/health', '/db-health']);
  // Production now runs the package staging runs since its fifth rebuild.
  assert.equal(production.applied.code_sha256_after, staging.applied.code_sha256_after);
  for (const evidence of ['131174636675', 'db5b3cc4-3a57-4876-9399-8b239990c00e', '6786 members', 'LastUpdateStatus Successful', 'trailing full stop', 'Not verified by this record']) {
    assert.ok(production.applied.notes.includes(evidence), evidence);
  }
  assert.equal(production.inspect.run_id, '43210883811');
  assert.equal(production.inspect.run_url, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/43210883811');
  assert.equal(production.inspect.main_commit, '60b8c734f7dd5f71f5b2bc94faa9633aca5d81d7');
  assert.equal(production.inspect.live_code_sha256, 'UWR5ZSeBSAGV1msYNmueRZQvlt+S2n2gcJAJgC/CaYA=');
  assert.equal(production.inspect.live_revision_id, '0810fadd-1ef4-4b0f-84cb-9c57533ea727');
  assert.equal(production.inspect.live_member_count, 6786);
  assert.equal(production.inspect.candidate_member_count, 6786);
  assert.equal(production.inspect.same, 209);
  assert.equal(production.inspect.changed, 1);
  assert.equal(production.inspect.added, 0);
  assert.equal(production.inspect.removed, 0);
  assert.deepEqual(production.inspect.dependency_counts, { live: 54, candidate: 54 });
  // Production ran the package staging ran before its fifth rebuild; the candidate is the ZIP staging applied and verified.
  assert.equal(production.inspect.live_code_sha256, staging.inspect.live_code_sha256);
  assert.equal(production.inspect.candidate_zip_sha256, staging.applied.candidate_zip_sha256);
  assert.equal(production.inspect.staging_acceptance, staging.applied.run_url);
  assert.equal(staging.applied.state, 'VERIFIED');
  // The package the rebuild starts from is the fourth rebuild's plus the production overlays since.
  assert.notEqual(production.inspect.live_code_sha256, fourth.applied.code_sha256_after);
  for (const evidence of ['SQL 153', '#1797', '43210074311', 'listed_member_drifted', 'history[3]', 'DEPLOY FULL API PACKAGE TO PRODUCTION']) {
    assert.ok(production.inspect.notes.includes(evidence), evidence);
  }
  const section = production;
  // The recorded section still made the fifth inspected live package READY, not BLOCKED.
  const plan = { environments: { production: { function_name: raw.environments.production.function_name, ...production } } };
  assert.deepEqual(Object.keys(section.members), ['mortgage-ops-usage.mjs']);
  assert.deepEqual(section.added, {});
  assert.deepEqual(section.removed, {});
  assert.deepEqual(section.dependencies, { added: {}, removed: {}, changed: {} });
  // Same difference as staging's fifth section: live is the bytes the fourth rebuild accepted, accepted is main's.
  assert.deepEqual(section.members, staging.members);
  const entry = section.members['mortgage-ops-usage.mjs'];
  assert.equal(entry.live_sha256, fourth.members['mortgage-ops-usage.mjs'].accepted_sha256);
  assert.equal(entry.accepted_sha256, sha256(fs.readFileSync(path.join(REPO_ROOT, 'aws/functions/api/mortgage-ops-usage.mjs'))));
  // The five members the inspect reported as drifted against the fourth section are main's bytes now (counted as same),
  // and none of them is a member of this section.
  for (const name of ['app-services.mjs', 'auth-financial-totp.mjs', 'tenant-billing-engine.mjs', 'tenant-billing-handlers.mjs', 'tenant-collection-v2.mjs']) {
    assert.ok(fourth.members[name], name);
    assert.equal(section.members[name], undefined, name);
    assert.ok(CHANGED_SINCE_FOURTH_PRODUCTION_REBUILD.has(name), name);
  }
  // The plan as committed makes the inspected live package READY; the old live bytes and an unlisted member refuse.
  const live = { 'mortgage-ops-usage.mjs': entry.live_sha256 };
  const candidate = { 'mortgage-ops-usage.mjs': entry.accepted_sha256 };
  const result = evaluateRebuild({ plan, environment: 'production', liveMemberHashes: live, candidateMemberHashes: candidate, liveInventory: {}, candidateInventory: {} });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.state, 'READY');
  const drifted = evaluateRebuild({ plan, environment: 'production', liveMemberHashes: { 'mortgage-ops-usage.mjs': fourth.members['mortgage-ops-usage.mjs'].live_sha256 }, candidateMemberHashes: candidate, liveInventory: {}, candidateInventory: {} });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.code, 'DEPLOYMENT_COLLISION');
  const extra = evaluateRebuild({ plan, environment: 'production', liveMemberHashes: { ...live, 'storage.mjs': 'a'.repeat(64) }, candidateMemberHashes: { ...candidate, 'storage.mjs': 'b'.repeat(64) }, liveInventory: {}, candidateInventory: {} });
  assert.equal(extra.ok, false);
  assert.equal(extra.code, 'SOURCE_RECONCILIATION_REQUIRED');
});

test('the staging history keeps the first rebuild (inspect 39585059839, apply 39587414391) and every accepted hash is the bytes on main or a listed later change', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/lambda-rebuild-plan.json'), 'utf8'));
  const staging = raw.environments.staging;
  assert.equal(staging.history.length, 6);
  const first = staging.history[0];
  assert.equal(first.status, 'applied');
  assert.equal(first.applied.run_id, '39587414391');
  assert.equal(first.applied.code_sha256_after, 'sxodWyRpUr0LbETU0YhBayaqYe1VsfNBQi1OoMZpd4U=');
  assert.equal(first.inspect.run_id, '39585059839');
  assert.equal(first.inspect.live_code_sha256, 'nKVEeB8BhnflTfCenx7eUKXBpYoF/dkF6eKZthJ7B1k=');
  assert.equal(first.inspect.candidate_zip_sha256, 'b31a1d5b246952bd0b6c44d4d188416b26aa61ed55b1f341422d4ea0c6697785');
  assert.equal(Object.keys(first.members).length, 122);
  assert.equal(Object.keys(first.added).length, 4);
  assert.deepEqual(first.removed, {});
  assert.deepEqual(first.dependencies, { added: {}, removed: {}, changed: {} });
  const apiRoot = path.join(REPO_ROOT, 'aws/functions/api');
  for (const [name, entry] of Object.entries(first.members)) {
    assertAcceptedIsMainUnlessChangedSince(apiRoot, name, entry.accepted_sha256);
  }
  for (const [name, hash] of Object.entries(first.added)) {
    assertAcceptedIsMainUnlessChangedSince(apiRoot, name, hash);
  }
  // The recorded section still made the first inspected live package READY, not BLOCKED.
  const plan = { environments: { staging: { function_name: staging.function_name, ...first } } };
  const live = {};
  const candidate = {};
  for (const [name, entry] of Object.entries(first.members)) { live[name] = entry.live_sha256; candidate[name] = entry.accepted_sha256; }
  for (const [name, hash] of Object.entries(first.added)) candidate[name] = hash;
  const result = evaluateRebuild({ plan, environment: 'staging', liveMemberHashes: live, candidateMemberHashes: candidate, liveInventory: {}, candidateInventory: {} });
  assert.equal(result.ok, true);
  assert.equal(result.details.state, 'READY');
});

test('the staging history keeps the second rebuild (inspect 39630308266, apply 39633656412): the Plaid/Actum/QuickBooks removal (19 changed, 0 added, 4 removed)', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/lambda-rebuild-plan.json'), 'utf8'));
  const staging = raw.environments.staging;
  const first = staging.history[0];
  const second = staging.history[1];
  assert.equal(second.status, 'applied');
  assert.equal(second.applied.run_id, '39633656412');
  assert.equal(second.applied.code_sha256_after, 'Bh/f7zaIFGDECA1jTWgMeR/2qRMOUaABRWP1lQbREOc=');
  assert.equal(second.inspect.run_id, '39630308266');
  assert.equal(second.inspect.main_commit, '333b54576f3405cdbe5de6bd1503c9be8e7a4b5e');
  assert.equal(second.inspect.live_code_sha256, 'sxodWyRpUr0LbETU0YhBayaqYe1VsfNBQi1OoMZpd4U=');
  assert.equal(second.inspect.live_revision_id, 'b2e6a162-79ad-4c8e-9177-6f33080a9ded');
  assert.equal(second.inspect.candidate_zip_sha256, '061fdfef36881460c4080d634d680c791ff6a9130e51a0014563f59506d110e7');
  // The package the rebuild started from is the one the first rebuild left live.
  assert.equal(second.inspect.live_code_sha256, first.applied.code_sha256_after);
  const section = second;
  assert.equal(Object.keys(section.members).length, 19);
  assert.deepEqual(section.added, {});
  assert.deepEqual(Object.keys(section.removed).sort(), ['providers/actum.mjs', 'providers/plaid-sandbox.mjs', 'providers/plaid.mjs', 'providers/quickbooks.mjs']);
  assert.deepEqual(section.dependencies, { added: {}, removed: {}, changed: {} });
  assert.equal(second.inspect.changed, 19);
  assert.equal(second.inspect.added, 0);
  assert.equal(second.inspect.removed, 4);
  const apiRoot = path.join(REPO_ROOT, 'aws/functions/api');
  const firstAccepted = (name) => first.members[name]?.accepted_sha256 || first.added[name] || null;
  for (const [name, entry] of Object.entries(section.members)) {
    // Accepted is main's bytes; live is what the first rebuild accepted wherever it listed the file.
    assertSectionAcceptedIsMain(apiRoot, name, entry.accepted_sha256);
    const before = firstAccepted(name);
    if (before) assert.equal(entry.live_sha256, before, name);
  }
  for (const [name, hash] of Object.entries(section.removed)) {
    assert.equal(fs.existsSync(path.join(apiRoot, name)), false, `${name} is listed as removed but main still has it`);
    assert.equal(hash, firstAccepted(name), name);
  }
  // Every reviewed post-rebuild change is now covered by the section.
  for (const [name, kind] of Object.entries(CHANGED_SINCE_APPLIED_REBUILD)) {
    if (kind === 'deleted') assert.ok(section.removed[name], `${name} is deleted on main but not listed as removed`);
    else assert.ok(section.members[name], `${name} changed on main but is not a staging member`);
  }
  // Files changed after the applied second rebuild are either not in its section (a new inspect moves
  // them into its own section) or members whose recorded accepted hash is not main's bytes (checked above).
  for (const name of Object.keys(CHANGED_SINCE_SECOND_REBUILD)) {
    if (!section.members[name]) assert.equal(section.removed[name] || section.added[name], undefined, name);
  }
  // The plan as committed makes the inspected live package READY, not BLOCKED.
  const live = {};
  const candidate = {};
  for (const [name, entry] of Object.entries(section.members)) { live[name] = entry.live_sha256; candidate[name] = entry.accepted_sha256; }
  for (const [name, hash] of Object.entries(section.removed)) live[name] = hash;
  // The recorded section still made the second inspected live package READY, not BLOCKED.
  const plan = { environments: { staging: { function_name: staging.function_name, ...second } } };
  const result = evaluateRebuild({ plan, environment: 'staging', liveMemberHashes: live, candidateMemberHashes: candidate, liveInventory: {}, candidateInventory: {} });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.state, 'READY');
});

test('the staging history keeps the third rebuild (inspect 39663300105, apply 39666390516): Moov transfer returns (1 changed, 1 added, 0 removed)', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/lambda-rebuild-plan.json'), 'utf8'));
  const staging = raw.environments.staging;
  const second = staging.history[1];
  const third = staging.history[2];
  assert.equal(third.status, 'applied');
  assert.equal(third.applied.run_id, '39666390516');
  assert.equal(third.applied.code_sha256_before, third.inspect.live_code_sha256);
  assert.equal(third.applied.code_sha256_after, 'pNCewAaFU1W1I6F2ZpAo7ElwEn1vFFmXvft9j6vsr/c=');
  assert.equal(third.applied.candidate_zip_sha256, third.inspect.candidate_zip_sha256);
  assert.equal(third.inspect.run_id, '39663300105');
  assert.equal(third.inspect.main_commit, 'c92fe457b13ca49340dfbd0239f0cf72f029f6fb');
  assert.equal(third.inspect.live_code_sha256, '+cyvVRtA46woHP4FwFBBZoN80aXR4A8Vo6adu5E1/NE=');
  assert.equal(third.inspect.live_revision_id, '3686cef2-0dd1-4fa2-9976-f6dbc139a46e');
  assert.equal(third.inspect.candidate_zip_sha256, 'a4d09ec006855355b523a176669028ec4970127d6f145997bdfb7d8fabecaff7');
  // The package the rebuild starts from is the second rebuild's, plus the #1124 overlay of
  // checkalt-eligibility.mjs (staging overlay run 39662525342), which already equals main.
  assert.notEqual(third.inspect.live_code_sha256, second.applied.code_sha256_after);
  const section = third;
  assert.deepEqual(Object.keys(section.members), ['providers/webhooks.mjs']);
  assert.deepEqual(Object.keys(section.added), ['providers/moov-transfer-webhook.mjs']);
  assert.deepEqual(section.removed, {});
  assert.deepEqual(section.dependencies, { added: {}, removed: {}, changed: {} });
  assert.equal(third.inspect.changed, 1);
  assert.equal(third.inspect.added, 1);
  assert.equal(third.inspect.removed, 0);
  assert.deepEqual(third.inspect.dependency_counts, { live: 54, candidate: 54 });
  const apiRoot = path.join(REPO_ROOT, 'aws/functions/api');
  for (const [name, entry] of Object.entries(section.members)) {
    // Accepted is main's bytes (unless main changed it since); live is the bytes the second rebuild accepted and put live.
    assertThirdSectionAccepted(apiRoot, name, entry.accepted_sha256);
    assert.equal(entry.live_sha256, second.members[name].accepted_sha256, name);
  }
  for (const [name, hash] of Object.entries(section.added)) {
    assert.equal(sha256(fs.readFileSync(path.join(apiRoot, name))), hash, name);
    assert.equal(second.members[name] || second.added[name], undefined, name);
  }
  // Every file main changed after the second rebuild is a member here, or already live at main's bytes
  // through the overlay (checkalt-eligibility.mjs, counted as same by the inspect).
  for (const name of Object.keys(CHANGED_SINCE_SECOND_REBUILD)) {
    if (OVERLAY_PLAN_CHANGES.has(name)) assert.equal(section.members[name], undefined, name);
    else assert.ok(section.members[name], `${name} changed on main but is not a staging member`);
  }
  // The recorded section still made the third inspected live package READY, not BLOCKED.
  const live = {};
  const candidate = {};
  for (const [name, entry] of Object.entries(section.members)) { live[name] = entry.live_sha256; candidate[name] = entry.accepted_sha256; }
  for (const [name, hash] of Object.entries(section.added)) candidate[name] = hash;
  const result = evaluateRebuild({ plan: { environments: { staging: { function_name: staging.function_name, ...third } } }, environment: 'staging', liveMemberHashes: live, candidateMemberHashes: candidate, liveInventory: {}, candidateInventory: {} });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.state, 'READY');
});

test('the staging history keeps the fourth section (inspect 41311016111): the money-write flag rebuild (3 changed, 0 added, 0 removed)', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/lambda-rebuild-plan.json'), 'utf8'));
  const staging = raw.environments.staging;
  const third = staging.history[2];
  // The fifth section (inspect 43207489743) moved the fourth into history[3] verbatim.
  const fourth = staging.history[3];
  assert.equal(fourth.status, 'accepted');
  assert.equal(fourth.applied, undefined);
  assert.equal(fourth.inspect.run_id, '41311016111');
  assert.equal(fourth.inspect.main_commit, '2caf8b22ebbc1009c7d0be6f687e6e8cb4f21fca');
  assert.equal(fourth.inspect.live_code_sha256, 'Zj7edKlGxXAEuB9OuHTdVlTH3rUkK5gPBUW+CuC7srg=');
  assert.equal(fourth.inspect.live_revision_id, '5aa9b001-cc57-42d2-a0fd-12e0466ef711');
  assert.equal(fourth.inspect.candidate_zip_sha256, '5c6a710d58c7b44d9eb9efd533cf974938d6f98937bd0091054ebabf24267ab6');
  // The package the rebuild starts from is the third rebuild's plus later single-member overlays
  // (each VERIFIED and already main's bytes, counted as same), not the third rebuild's own package.
  assert.notEqual(fourth.inspect.live_code_sha256, third.applied.code_sha256_after);
  for (const run of ['41309572005', '41310178084', '41310941335', '41202670517']) assert.match(fourth.inspect.notes, new RegExp(run), run);
  const section = fourth;
  const THREE = ['invoice-provider.mjs', 'mortgage-ops-usage.mjs', 'tenant-collection-v2-uat.mjs'];
  assert.deepEqual(Object.keys(section.members), THREE);
  assert.deepEqual(section.added, {});
  assert.deepEqual(section.removed, {});
  assert.deepEqual(section.dependencies, { added: {}, removed: {}, changed: {} });
  assert.equal(fourth.inspect.same, 203);
  assert.equal(fourth.inspect.changed, 3);
  assert.equal(fourth.inspect.added, 0);
  assert.equal(fourth.inspect.removed, 0);
  assert.deepEqual(fourth.inspect.dependency_counts, { live: 54, candidate: 54 });
  const apiRoot = path.join(REPO_ROOT, 'aws/functions/api');
  // Accepted is main's bytes: the money-write flag (#1498) in the three files that are not overlay members, unless
  // main changed the member since (listed).
  for (const [name, entry] of Object.entries(section.members)) {
    const onMain = sha256(fs.readFileSync(path.join(apiRoot, name)));
    if (CHANGED_SINCE_FOURTH_STAGING_SECTION.has(name)) assert.notEqual(onMain, entry.accepted_sha256, `${name} is listed as changed but main still has the accepted bytes`);
    else assert.equal(onMain, entry.accepted_sha256, name);
    assert.notEqual(entry.live_sha256, entry.accepted_sha256, name);
    assert.ok(OVERLAY_PLAN_CHANGES.has(name), name);
  }
  // providers/webhooks.mjs was a third-section member at f7353ee1...; the guarded staging overlay of
  // the Moov webhook body confirmation (run 41202670517) put main's bytes live, so it is not a member here.
  assert.equal(section.members['providers/webhooks.mjs'], undefined);
  assert.equal(third.members['providers/webhooks.mjs'].accepted_sha256, 'f7353ee1673364d45ce564dd8b7f102273e9a871c63f8398d03bd7226360d97f');
  // Those bytes (59b58674, production run 41219106461) are what the receipt key REPLACE (2026-11-07) started from;
  // main has moved on to its bytes, which production run 42330359623 applied (2026-11-07).
  assert.equal(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'aws/tests/fixtures/production-moov-webhook-body-auth-applied-manifest-2026-10-31.json'), 'utf8')).members['providers/webhooks.mjs'].accepted_sha256, '59b586744332df62524a25b4602966686c9ba9ae869cc644ab9046bfc1ae63b0');
  // The recorded section still made the fourth inspected live package READY, not BLOCKED.
  const plan = { environments: { staging: { function_name: staging.function_name, ...fourth } } };
  const live = {};
  const candidate = {};
  for (const [name, entry] of Object.entries(section.members)) { live[name] = entry.live_sha256; candidate[name] = entry.accepted_sha256; }
  const result = evaluateRebuild({ plan, environment: 'staging', liveMemberHashes: live, candidateMemberHashes: candidate, liveInventory: {}, candidateInventory: {} });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.state, 'READY');
  // The webhooks.mjs bytes the inspect reported as drifted against the third section now read as same.
  const withWebhooks = evaluateRebuild({ plan, environment: 'staging', liveMemberHashes: { ...live, 'providers/webhooks.mjs': '59b586744332df62524a25b4602966686c9ba9ae869cc644ab9046bfc1ae63b0' }, candidateMemberHashes: { ...candidate, 'providers/webhooks.mjs': '59b586744332df62524a25b4602966686c9ba9ae869cc644ab9046bfc1ae63b0' }, liveInventory: {}, candidateInventory: {} });
  assert.equal(withWebhooks.details.state, 'READY', withWebhooks.message);
});

test('the staging history keeps the fifth section (inspect 43207489743, apply 43210074311): the second mortgage company fee rebuild (1 changed, 0 added, 0 removed)', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/lambda-rebuild-plan.json'), 'utf8'));
  // The sixth section (inspect 43416770262) moved the fifth into history[4] verbatim.
  const staging = raw.environments.staging.history[4];
  const fourth = raw.environments.staging.history[3];
  // Applied 2026-11-12 (run 43210074311) on the owner's "DEPLOY FULL API PACKAGE TO STAGING".
  assert.equal(staging.status, 'applied');
  assert.equal(staging.applied.run_id, '43210074311');
  assert.equal(staging.applied.run_url, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/43210074311');
  assert.equal(staging.applied.main_commit, '60b8c734f7dd5f71f5b2bc94faa9633aca5d81d7');
  assert.equal(staging.applied.approval_phrase, 'DEPLOY FULL API PACKAGE TO STAGING');
  assert.equal(staging.applied.code_sha256_before, staging.inspect.live_code_sha256);
  assert.equal(staging.applied.revision_id_before, staging.inspect.live_revision_id);
  assert.equal(staging.applied.candidate_zip_sha256, staging.inspect.candidate_zip_sha256);
  assert.equal(staging.applied.code_sha256_after, '2NKoKhkxtfOpsoTGA3/9SekMHMH8EcmSchqWFMVWoIw=');
  assert.equal(staging.applied.revision_id_after, '3f35c0cf-22e2-460d-a37f-e093bd0f0c0c');
  assert.equal(staging.applied.state, 'VERIFIED');
  assert.deepEqual(staging.applied.smoke, ['/health', '/db-health', '/db-readonly-validate']);
  for (const evidence of ['131155134067', 'f947cef5-9cc5-431c-869c-8892599746a0', '6786 members', 'LastUpdateStatus Successful', 'Not verified by this record']) {
    assert.ok(staging.applied.notes.includes(evidence), evidence);
  }
  assert.equal(staging.inspect.run_id, '43207489743');
  assert.equal(staging.inspect.run_url, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/43207489743');
  assert.equal(staging.inspect.main_commit, 'c3d3959386319faf2be6d152388125bbcc263adf');
  assert.equal(staging.inspect.live_code_sha256, 'UWR5ZSeBSAGV1msYNmueRZQvlt+S2n2gcJAJgC/CaYA=');
  assert.equal(staging.inspect.live_revision_id, '4a206861-aa78-4bda-963a-2dfe2069be47');
  assert.equal(staging.inspect.candidate_zip_sha256, 'd8d2a82a1931b5f3a9b284c6037ffd49e90c1cc1fc11c992721a9614c556a08c');
  assert.equal(staging.inspect.live_member_count, 6786);
  assert.equal(staging.inspect.candidate_member_count, 6786);
  assert.equal(staging.inspect.same, 209);
  assert.equal(staging.inspect.changed, 1);
  assert.equal(staging.inspect.added, 0);
  assert.equal(staging.inspect.removed, 0);
  assert.deepEqual(staging.inspect.dependency_counts, { live: 54, candidate: 54 });
  // Only the second mortgage company fee's accrual: no other workstream's file (SQL 156's two members were overlaid
  // in staging first, runs 43137751086 and 43138073611, which left the RevisionId this inspect reads).
  for (const evidence of ['SQL 153', '#1761', '43137751086', '43138073611', '43132621878', '41313204838', 'DEPLOY FULL API PACKAGE TO STAGING', 'Production is unchanged']) {
    assert.ok(staging.inspect.notes.includes(evidence), evidence);
  }
  const section = staging;
  // The recorded section still made the fifth inspected live package READY, not BLOCKED.
  const plan = { environments: { staging: { function_name: raw.environments.staging.function_name, ...staging } } };
  assert.deepEqual(Object.keys(section.members), ['mortgage-ops-usage.mjs']);
  assert.deepEqual(section.added, {});
  assert.deepEqual(section.removed, {});
  assert.deepEqual(section.dependencies, { added: {}, removed: {}, changed: {} });
  const entry = section.members['mortgage-ops-usage.mjs'];
  // Accepted is main's bytes; live is the bytes the fourth section accepted and put live.
  const apiRoot = path.join(REPO_ROOT, 'aws/functions/api');
  assert.equal(entry.accepted_sha256, sha256(fs.readFileSync(path.join(apiRoot, 'mortgage-ops-usage.mjs'))));
  assert.equal(entry.accepted_sha256, 'abd5fe7a8caba4cf9c48ff4ce0d2cb5ab7cb6e1d122a1c389ac66ede44acb044');
  assert.equal(entry.live_sha256, fourth.members['mortgage-ops-usage.mjs'].accepted_sha256);
  assert.ok(CHANGED_SINCE_FOURTH_STAGING_SECTION.has('mortgage-ops-usage.mjs'));
  assert.ok(OVERLAY_PLAN_CHANGES.has('mortgage-ops-usage.mjs'));
  // Still not a production overlay member: it reaches a function only with a rebuild.
  const overlayPlan = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/production-api-overlay-plan.json'), 'utf8'));
  assert.equal(overlayPlan.members['mortgage-ops-usage.mjs'], undefined);
  assert.equal(overlayPlan.order.includes('mortgage-ops-usage.mjs'), false);
  // Another live hash is a collision.
  const live = { 'mortgage-ops-usage.mjs': entry.live_sha256 };
  const candidate = { 'mortgage-ops-usage.mjs': entry.accepted_sha256 };
  const result = evaluateRebuild({ plan, environment: 'staging', liveMemberHashes: live, candidateMemberHashes: candidate, liveInventory: {}, candidateInventory: {} });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.state, 'READY');
  const drifted = evaluateRebuild({ plan, environment: 'staging', liveMemberHashes: { 'mortgage-ops-usage.mjs': fourth.members['mortgage-ops-usage.mjs'].live_sha256 }, candidateMemberHashes: candidate, liveInventory: {}, candidateInventory: {} });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.code, 'DEPLOYMENT_COLLISION');
  assert.deepEqual(drifted.details.problems.map((p) => p.reason), ['live_mismatch']);
  // Another changed member (for example an unplanned overlay member) still blocks.
  const extra = evaluateRebuild({ plan, environment: 'staging', liveMemberHashes: { ...live, 'storage.mjs': 'a'.repeat(64) }, candidateMemberHashes: { ...candidate, 'storage.mjs': 'b'.repeat(64) }, liveInventory: {}, candidateInventory: {} });
  assert.equal(extra.ok, false);
  assert.equal(extra.code, 'SOURCE_RECONCILIATION_REQUIRED');
  assert.deepEqual(extra.details.problems.map((p) => p.reason), ['unlisted_change']);
});

test('the staging history keeps the sixth section (inspect 43416770262, apply 43420512528): the settlement bank fallback rebuild (1 changed, 0 added, 0 removed)', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/lambda-rebuild-plan.json'), 'utf8'));
  // The seventh section (inspect 43458069245) moved the sixth into history[5] verbatim.
  const staging = raw.environments.staging.history[5];
  const fifth = raw.environments.staging.history[4];
  // Applied 2026-11-13 (run 43420512528) on the owner's "DEPLOY FULL API PACKAGE TO STAGING"; owner: "Staging looks good".
  assert.equal(staging.status, 'applied');
  assert.equal(staging.applied.run_id, '43420512528');
  assert.equal(staging.applied.run_url, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/43420512528');
  assert.equal(staging.applied.main_commit, '78f05e98e53472f4c24866bfa074386018d24149');
  assert.equal(staging.applied.approval_phrase, 'DEPLOY FULL API PACKAGE TO STAGING');
  assert.equal(staging.applied.code_sha256_before, staging.inspect.live_code_sha256);
  assert.equal(staging.applied.revision_id_before, staging.inspect.live_revision_id);
  assert.equal(staging.applied.candidate_zip_sha256, staging.inspect.candidate_zip_sha256);
  assert.equal(staging.applied.code_sha256_after, 'EaCUx/sRQV1qNZC8g11cpzLIuWVea/cfZiTWZ3sdPvQ=');
  assert.equal(staging.applied.revision_id_after, '6df662ee-e9e6-437b-9a73-c126cdc4252d');
  assert.equal(staging.applied.state, 'VERIFIED');
  assert.deepEqual(staging.applied.smoke, ['/health', '/db-health', '/db-readonly-validate']);
  for (const evidence of ['131869037804', 'c4abca88-561a-4a2e-8701-f08a9ddc679b', '43420370488', '6786 members', 'LastUpdateStatus Successful', 'Staging looks good']) {
    assert.ok(staging.applied.notes.includes(evidence), evidence);
  }
  assert.equal(staging.inspect.run_id, '43416770262');
  assert.equal(staging.inspect.run_url, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/43416770262');
  assert.equal(staging.inspect.main_commit, '8d6488e0fef93d3ff3697a6423603d546e7faa08');
  assert.equal(staging.inspect.live_code_sha256, 'Dif2IETi/w3MYw50go94GVDr3iuD505RCSuWiLTs72s=');
  assert.equal(staging.inspect.live_revision_id, '7f83a725-cc3b-4266-b27f-7cd3cf00c3b7');
  assert.equal(staging.inspect.candidate_zip_sha256, '11a094c7fb11415d6a3590bc835d5ca732c8b9655e6bf71f6624d6677b1d3ef4');
  assert.equal(staging.inspect.live_member_count, 6786);
  assert.equal(staging.inspect.candidate_member_count, 6786);
  assert.equal(staging.inspect.same, 209);
  assert.equal(staging.inspect.changed, 1);
  assert.equal(staging.inspect.added, 0);
  assert.equal(staging.inspect.removed, 0);
  assert.deepEqual(staging.inspect.dependency_counts, { live: 54, candidate: 54 });
  // The package the rebuild starts from is the fifth rebuild's plus the guarded overlays since (the partner-send
  // workstream's moov-send.mjs and data.mjs, counted as same), not the fifth rebuild's own package.
  assert.notEqual(staging.inspect.live_code_sha256, fifth.applied.code_sha256_after);
  for (const evidence of ['#1838', '#1844', '#1850', '43348784836', '43348781774', '43371290665', 'history[4]', 'DEPLOY FULL API PACKAGE TO STAGING', 'Production is unchanged']) {
    assert.ok(staging.inspect.notes.includes(evidence), evidence);
  }
  const section = staging;
  // The recorded section still made the sixth inspected live package READY, not BLOCKED.
  const plan = { environments: { staging: { function_name: raw.environments.staging.function_name, ...staging } } };
  assert.deepEqual(Object.keys(section.members), ['providers/parity/sweep-read.mjs']);
  assert.deepEqual(section.added, {});
  assert.deepEqual(section.removed, {});
  assert.deepEqual(section.dependencies, { added: {}, removed: {}, changed: {} });
  const entry = section.members['providers/parity/sweep-read.mjs'];
  // Accepted is main's bytes; live is main's bytes before #1838 (977bfedbd^1), which no rebuild section listed.
  const apiRoot = path.join(REPO_ROOT, 'aws/functions/api');
  assert.equal(entry.accepted_sha256, sha256(fs.readFileSync(path.join(apiRoot, 'providers/parity/sweep-read.mjs'))));
  assert.equal(entry.accepted_sha256, '32d7ffaaeffc27a13615e1c310666e87bdccf619c12c15ddb5823921035a44f4');
  assert.equal(entry.live_sha256, '4da8e0c0e1b3bb6c78248cde67738f953044b065dde75cfc4885d6fac2bae02f');
  assert.equal(entry.live_sha256, raw.environments.staging.history[0].members['providers/parity/sweep-read.mjs'].accepted_sha256);
  assert.equal(CHANGED_SINCE_SECOND_REBUILD['providers/parity/sweep-read.mjs'], 'changed');
  assert.ok(OVERLAY_PLAN_CHANGES.has('providers/parity/sweep-read.mjs'));
  // Not a production overlay member: it reaches a function only with a rebuild.
  const overlayPlan = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/production-api-overlay-plan.json'), 'utf8'));
  assert.equal(overlayPlan.members['providers/parity/sweep-read.mjs'], undefined);
  assert.equal(overlayPlan.order.includes('providers/parity/sweep-read.mjs'), false);
  // Another live hash is a collision.
  const live = { 'providers/parity/sweep-read.mjs': entry.live_sha256 };
  const candidate = { 'providers/parity/sweep-read.mjs': entry.accepted_sha256 };
  const result = evaluateRebuild({ plan, environment: 'staging', liveMemberHashes: live, candidateMemberHashes: candidate, liveInventory: {}, candidateInventory: {} });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.state, 'READY');
  const drifted = evaluateRebuild({ plan, environment: 'staging', liveMemberHashes: { 'providers/parity/sweep-read.mjs': 'c'.repeat(64) }, candidateMemberHashes: candidate, liveInventory: {}, candidateInventory: {} });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.code, 'DEPLOYMENT_COLLISION');
  assert.deepEqual(drifted.details.problems.map((p) => p.reason), ['live_mismatch']);
  // Another changed member (for example the fifth section's accrual, or an unplanned overlay member) still blocks.
  const extra = evaluateRebuild({ plan, environment: 'staging', liveMemberHashes: { ...live, 'mortgage-ops-usage.mjs': 'a'.repeat(64) }, candidateMemberHashes: { ...candidate, 'mortgage-ops-usage.mjs': 'b'.repeat(64) }, liveInventory: {}, candidateInventory: {} });
  assert.equal(extra.ok, false);
  assert.equal(extra.code, 'SOURCE_RECONCILIATION_REQUIRED');
  assert.deepEqual(extra.details.problems.map((p) => p.reason), ['unlisted_change']);
});

test('the staging plan section accepts inspect run 43458069245 and records apply 43460848634: the transfer to bank API rebuild (4 changed, 3 added, 0 removed)', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/lambda-rebuild-plan.json'), 'utf8'));
  const staging = raw.environments.staging;
  const sixth = staging.history[5];
  // Applied 2026-11-13 (run 43460848634) on the owner's "DEPLOY FULL API PACKAGE TO STAGING". The staging acceptance is
  // the guarded apply and its verification: no person has looked at Transfer to bank on staging.
  assert.equal(staging.status, 'applied');
  assert.equal(staging.applied.run_id, '43460848634');
  assert.equal(staging.applied.run_url, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/43460848634');
  assert.equal(staging.applied.main_commit, '338323b0b1e010a13cfb296ef4e8922cb7c2e5cd');
  assert.equal(staging.applied.approval_phrase, 'DEPLOY FULL API PACKAGE TO STAGING');
  assert.equal(staging.applied.code_sha256_before, staging.inspect.live_code_sha256);
  assert.equal(staging.applied.revision_id_before, staging.inspect.live_revision_id);
  assert.equal(staging.applied.candidate_zip_sha256, staging.inspect.candidate_zip_sha256);
  assert.equal(staging.applied.code_sha256_after, 'DvQOhuCiv/Li3EeVjr+WsErARsPA4S95lgBMgwsGEhg=');
  assert.equal(staging.applied.revision_id_after, '84e074cf-987a-4d4f-a3c7-0c3c813c27d6');
  assert.equal(staging.applied.state, 'VERIFIED');
  assert.deepEqual(staging.applied.smoke, ['/health', '/db-health', '/db-readonly-validate']);
  for (const evidence of ['132007064054', '69ff264f-8dbf-4499-9249-220baa0fe765', '43460684842', '6789 members', 'no person has looked at Transfer to bank on staging', 'Not verified by this record']) {
    assert.ok(staging.applied.notes.includes(evidence), evidence);
  }
  assert.ok(!staging.applied.notes.includes('Staging looks good'));
  assert.equal(staging.inspect.run_id, '43458069245');
  assert.equal(staging.inspect.run_url, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/43458069245');
  assert.equal(staging.inspect.main_commit, '9c1cf295a12627ec06a31e9c66fd330d65a86a55');
  assert.equal(staging.inspect.live_code_sha256, 'bphhLdCS8TSGIfwC4lGAbFkMFF9GXInjD3Cx9TDKneY=');
  assert.equal(staging.inspect.live_revision_id, 'db0c3cd4-6d07-49d8-94e9-0daea4e3933f');
  assert.equal(staging.inspect.candidate_zip_sha256, '0ef40e86e0a2bff2e2dc47958ebf96b04ac046c3c0e12f7996004c830b061218');
  assert.equal(staging.inspect.live_member_count, 6786);
  assert.equal(staging.inspect.candidate_member_count, 6789);
  assert.equal(staging.inspect.same, 206);
  assert.equal(staging.inspect.changed, 4);
  assert.equal(staging.inspect.added, 3);
  assert.equal(staging.inspect.removed, 0);
  assert.deepEqual(staging.inspect.dependency_counts, { live: 54, candidate: 54 });
  // The package the rebuild starts from is the sixth rebuild's plus the guarded desk overlay since (#1865,
  // mortgage-desk-esign.mjs, staging run 43432513146, counted as same), not the sixth rebuild's own package.
  assert.notEqual(staging.inspect.live_code_sha256, sixth.applied.code_sha256_after);
  for (const evidence of ['#1876', '#1875', '#1865', '43432513146', 'history[5]', 'Start the transfer to bank API', 'DEPLOY FULL API PACKAGE TO STAGING', 'Production is unchanged']) {
    assert.ok(staging.inspect.notes.includes(evidence), evidence);
  }
  const section = loadRebuildPlan(REPO_ROOT, 'staging');
  const CHANGED = ['app-services.mjs', 'providers.mjs', 'providers/catalog.mjs', 'providers/moov-status-catch-up.mjs'];
  const ADDED = ['fed-holidays.mjs', 'providers/production/moov-wallet-withdraw.mjs', 'wallet-withdraw-limits.mjs'];
  assert.deepEqual(Object.keys(section.members), CHANGED);
  assert.deepEqual(Object.keys(section.added), ADDED);
  assert.deepEqual(section.removed, {});
  assert.deepEqual(section.dependencies, { added: {}, removed: {}, changed: {} });
  // Accepted is main's bytes; live is main's bytes before #1876 (9c1cf295a^1), as the inspect printed them.
  const apiRoot = path.join(REPO_ROOT, 'aws/functions/api');
  const INSPECTED = {
    'app-services.mjs': ['8b91a6444e8b05c7fc5fec9b4d1883b4e042f6c0efeb045f777c934223b22199', '6735d88fc0aeaf5789fbf96ec2f33b980a1f85a6f71d9224ec4f93272810e769'],
    'providers.mjs': ['58207e5e8762a1a912c2e2fc5e143f0df90205e5e16be604dc3c1cdf19ca73d9', '19f6a19bde07f67a33b50fbef883b9bf6f893f018d8995172003d0d1942225f6'],
    'providers/catalog.mjs': ['91f9ea543d484f6daa584ec76a99218fecfccb8f628546c165a448e968bcc969', 'b912585f4ab6014af4a4a6da69cbe8f565c2882eefa61f3aa71975c825e3ceed'],
    'providers/moov-status-catch-up.mjs': ['6083f54bbaf1a72395ab45495b90c3b4f5136b8adbf33d386f7584ea2e95b9ab', '8d82adf4ea29dbb6fc17d75c4e469643c8daf5dbf251eae9911e2e2994ff09f2'],
    'fed-holidays.mjs': [null, '162580f1a9b0a99b93e5ba1512fc00fed86f1edd6dda033cced72c56115a1638'],
    'providers/production/moov-wallet-withdraw.mjs': [null, '22c6c77990c54042ecd82ce13a119dadc84f34adcc9883df17d522e7471f64e0'],
    'wallet-withdraw-limits.mjs': [null, 'aa3f2f0ec07e2d30c0555683a41de5deea3643add006a7ed1e516077206d07c9'],
  };
  for (const [name, [live, accepted]] of Object.entries(INSPECTED)) {
    const listed = live === null ? section.added[name] : section.members[name].accepted_sha256;
    assert.equal(listed, accepted, name);
    assert.equal(sha256(fs.readFileSync(path.join(apiRoot, name))), accepted, name);
    if (live !== null) assert.equal(section.members[name].live_sha256, live, name);
  }
  // The plan as committed makes the inspected live package READY, not BLOCKED; another live hash is a collision.
  const live = Object.fromEntries(CHANGED.map((name) => [name, section.members[name].live_sha256]));
  const candidate = {
    ...Object.fromEntries(CHANGED.map((name) => [name, section.members[name].accepted_sha256])),
    ...section.added,
  };
  const result = evaluateRebuild({ plan: raw, environment: 'staging', liveMemberHashes: live, candidateMemberHashes: candidate, liveInventory: {}, candidateInventory: {} });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.state, 'READY');
  const drifted = evaluateRebuild({ plan: raw, environment: 'staging', liveMemberHashes: { ...live, 'providers.mjs': 'c'.repeat(64) }, candidateMemberHashes: candidate, liveInventory: {}, candidateInventory: {} });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.code, 'DEPLOYMENT_COLLISION');
  assert.deepEqual(drifted.details.problems.map((p) => p.reason), ['live_mismatch']);
  // Another changed member (for example the sixth section's sweep-read.mjs, or an unplanned overlay member) still blocks.
  const extra = evaluateRebuild({ plan: raw, environment: 'staging', liveMemberHashes: { ...live, 'providers/parity/sweep-read.mjs': 'a'.repeat(64) }, candidateMemberHashes: { ...candidate, 'providers/parity/sweep-read.mjs': 'b'.repeat(64) }, liveInventory: {}, candidateInventory: {} });
  assert.equal(extra.ok, false);
  assert.equal(extra.code, 'SOURCE_RECONCILIATION_REQUIRED');
  assert.deepEqual(extra.details.problems.map((p) => p.reason), ['unlisted_change']);
});

test('the production history keeps the sixth section (inspect 43425291017, apply 43430080268): the settlement bank fallback rebuild (1 changed, 0 added, 0 removed), the candidate staging applied and verified', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/lambda-rebuild-plan.json'), 'utf8'));
  // The seventh section (inspect 43461114623) moved the sixth into history[5] verbatim.
  const production = raw.environments.production.history[5];
  const fifth = raw.environments.production.history[4];
  // The staging sixth section (inspect 43416770262, apply 43420512528) is history[5] since the seventh (inspect 43458069245).
  const staging = raw.environments.staging.history[5];
  // Applied 2026-11-13 (run 43430080268) on the owner's phrase, from the staging reference the section names.
  assert.equal(production.status, 'applied');
  assert.equal(production.applied.run_id, '43430080268');
  assert.equal(production.applied.run_url, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/43430080268');
  assert.equal(production.applied.main_commit, 'ccd98eae935dfe28002b31e553052dd07a514c71');
  assert.equal(production.applied.approval_phrase, 'DEPLOY FULL API PACKAGE TO PRODUCTION');
  assert.equal(production.applied.staging_acceptance, production.inspect.staging_acceptance);
  assert.equal(production.applied.code_sha256_before, production.inspect.live_code_sha256);
  assert.equal(production.applied.revision_id_before, production.inspect.live_revision_id);
  assert.equal(production.applied.candidate_zip_sha256, production.inspect.candidate_zip_sha256);
  assert.equal(production.applied.code_sha256_after, 'EaCUx/sRQV1qNZC8g11cpzLIuWVea/cfZiTWZ3sdPvQ=');
  assert.equal(production.applied.revision_id_after, '429a3086-859f-4da3-a486-ef589d1ebadf');
  assert.equal(production.applied.state, 'VERIFIED');
  assert.deepEqual(production.applied.smoke, ['/health', '/db-health']);
  // Production now runs the package staging runs since its sixth rebuild.
  assert.equal(production.applied.code_sha256_after, staging.applied.code_sha256_after);
  for (const evidence of ['131901086048', 'a23acf16-ec27-4c53-86a6-3ffa0ca33f79', '6786 members', 'LastUpdateStatus Successful', 'Staging looks good', 'Not verified by this record']) {
    assert.ok(production.applied.notes.includes(evidence), evidence);
  }
  assert.equal(production.inspect.run_id, '43425291017');
  assert.equal(production.inspect.run_url, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/43425291017');
  assert.equal(production.inspect.main_commit, '37d50181c3e28911bd06b5a930fde9ab218c3ec3');
  assert.equal(production.inspect.live_code_sha256, 'Dif2IETi/w3MYw50go94GVDr3iuD505RCSuWiLTs72s=');
  assert.equal(production.inspect.live_revision_id, 'fd050f1f-7a45-416d-8e11-bd1edf3a5c85');
  assert.equal(production.inspect.live_member_count, 6786);
  assert.equal(production.inspect.candidate_member_count, 6786);
  assert.equal(production.inspect.same, 209);
  assert.equal(production.inspect.changed, 1);
  assert.equal(production.inspect.added, 0);
  assert.equal(production.inspect.removed, 0);
  assert.deepEqual(production.inspect.dependency_counts, { live: 54, candidate: 54 });
  // Production runs the package staging ran before its sixth rebuild; the candidate is the ZIP staging applied and verified.
  assert.equal(production.inspect.live_code_sha256, staging.inspect.live_code_sha256);
  assert.equal(production.inspect.candidate_zip_sha256, staging.applied.candidate_zip_sha256);
  assert.equal(production.inspect.staging_acceptance, staging.applied.run_url);
  assert.equal(staging.applied.state, 'VERIFIED');
  // The package the rebuild starts from is the fifth rebuild's plus the production overlays since.
  assert.notEqual(production.inspect.live_code_sha256, fifth.applied.code_sha256_after);
  for (const evidence of ['#1838', 'Staging looks good', '43420512528', 'history[4]', 'unlisted_change', 'DEPLOY FULL API PACKAGE TO PRODUCTION']) {
    assert.ok(production.inspect.notes.includes(evidence), evidence);
  }
  const section = production;
  // The recorded section still made the sixth inspected live package READY, not BLOCKED.
  const plan = { environments: { production: { function_name: raw.environments.production.function_name, ...production } } };
  assert.deepEqual(Object.keys(section.members), ['providers/parity/sweep-read.mjs']);
  assert.deepEqual(section.added, {});
  assert.deepEqual(section.removed, {});
  assert.deepEqual(section.dependencies, { added: {}, removed: {}, changed: {} });
  // Same difference as staging's sixth section.
  assert.deepEqual(section.members, staging.members);
  const entry = section.members['providers/parity/sweep-read.mjs'];
  assert.equal(entry.accepted_sha256, sha256(fs.readFileSync(path.join(REPO_ROOT, 'aws/functions/api/providers/parity/sweep-read.mjs'))));
  // The plan as committed makes the inspected live package READY; other live bytes and an unlisted member refuse.
  const live = { 'providers/parity/sweep-read.mjs': entry.live_sha256 };
  const candidate = { 'providers/parity/sweep-read.mjs': entry.accepted_sha256 };
  const result = evaluateRebuild({ plan, environment: 'production', liveMemberHashes: live, candidateMemberHashes: candidate, liveInventory: {}, candidateInventory: {} });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.state, 'READY');
  const drifted = evaluateRebuild({ plan, environment: 'production', liveMemberHashes: { 'providers/parity/sweep-read.mjs': 'c'.repeat(64) }, candidateMemberHashes: candidate, liveInventory: {}, candidateInventory: {} });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.code, 'DEPLOYMENT_COLLISION');
  const extra = evaluateRebuild({ plan, environment: 'production', liveMemberHashes: { ...live, 'mortgage-ops-usage.mjs': 'a'.repeat(64) }, candidateMemberHashes: { ...candidate, 'mortgage-ops-usage.mjs': 'b'.repeat(64) }, liveInventory: {}, candidateInventory: {} });
  assert.equal(extra.ok, false);
  assert.equal(extra.code, 'SOURCE_RECONCILIATION_REQUIRED');
});

test('the production plan section accepts inspect run 43461114623 and records apply 43464046767: the transfer to bank API rebuild (4 changed, 3 added, 0 removed), the candidate staging applied and verified', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/lambda-rebuild-plan.json'), 'utf8'));
  const production = raw.environments.production;
  const sixth = production.history[5];
  const staging = raw.environments.staging;
  // Applied 2026-11-13 (run 43464046767) on the owner's phrase, from the staging reference the section names.
  assert.equal(production.status, 'applied');
  assert.equal(production.applied.run_id, '43464046767');
  assert.equal(production.applied.run_url, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/43464046767');
  assert.equal(production.applied.main_commit, '4bcdd8db2e4279bfd298aaad27c632d0dfea7579');
  assert.equal(production.applied.approval_phrase, 'DEPLOY FULL API PACKAGE TO PRODUCTION');
  assert.equal(production.applied.staging_acceptance, production.inspect.staging_acceptance);
  assert.equal(production.applied.code_sha256_before, production.inspect.live_code_sha256);
  assert.equal(production.applied.revision_id_before, production.inspect.live_revision_id);
  assert.equal(production.applied.candidate_zip_sha256, production.inspect.candidate_zip_sha256);
  assert.equal(production.applied.code_sha256_after, 'DvQOhuCiv/Li3EeVjr+WsErARsPA4S95lgBMgwsGEhg=');
  assert.equal(production.applied.revision_id_after, '17f6bd67-f508-421f-abb7-7c5c3441741e');
  assert.equal(production.applied.state, 'VERIFIED');
  assert.deepEqual(production.applied.smoke, ['/health', '/db-health']);
  // Production now runs the package staging runs since its seventh rebuild.
  assert.equal(production.applied.code_sha256_after, staging.applied.code_sha256_after);
  for (const evidence of ['132018292125', '43463908901', '48c6785c-718e-4217-9655-232d52860e15', '6789 members', 'LastUpdateStatus Successful', 'no person exercised Transfer to bank on staging', 'Not verified by this record']) {
    assert.ok(production.applied.notes.includes(evidence), evidence);
  }
  assert.equal(production.inspect.run_id, '43461114623');
  assert.equal(production.inspect.run_url, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/43461114623');
  assert.equal(production.inspect.main_commit, '338323b0b1e010a13cfb296ef4e8922cb7c2e5cd');
  assert.equal(production.inspect.live_code_sha256, 'bphhLdCS8TSGIfwC4lGAbFkMFF9GXInjD3Cx9TDKneY=');
  assert.equal(production.inspect.live_revision_id, '8e6bb1be-7e8b-4234-a7ef-458e2acd0371');
  assert.equal(production.inspect.live_member_count, 6786);
  assert.equal(production.inspect.candidate_member_count, 6789);
  assert.equal(production.inspect.same, 206);
  assert.equal(production.inspect.changed, 4);
  assert.equal(production.inspect.added, 3);
  assert.equal(production.inspect.removed, 0);
  assert.deepEqual(production.inspect.dependency_counts, { live: 54, candidate: 54 });
  // Production runs the package staging ran before its seventh rebuild; the candidate is the ZIP staging applied and verified.
  assert.equal(production.inspect.live_code_sha256, staging.inspect.live_code_sha256);
  assert.equal(production.inspect.candidate_zip_sha256, staging.applied.candidate_zip_sha256);
  assert.equal(production.inspect.staging_acceptance, staging.applied.run_url);
  assert.equal(staging.applied.state, 'VERIFIED');
  // The package the rebuild starts from is the sixth rebuild's plus the guarded desk overlay since (#1865, production
  // apply 43432666872, counted as same), not the sixth rebuild's own package.
  assert.notEqual(production.inspect.live_code_sha256, sixth.applied.code_sha256_after);
  const desk = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'aws/tests/fixtures/production-desk-check-timeline-link-applied-manifest-2026-11-13.json'), 'utf8'));
  assert.ok(desk.notes.includes(`after RevisionId ${production.inspect.live_revision_id}, CodeSha256 ${production.inspect.live_code_sha256}`));
  for (const evidence of ['#1876', '#1875', '#1865', '43432666872', '43460848634', 'history[5]', 'unlisted_add', 'no person has looked at Transfer to bank on staging', 'DEPLOY FULL API PACKAGE TO PRODUCTION']) {
    assert.ok(production.inspect.notes.includes(evidence), evidence);
  }
  const section = loadRebuildPlan(REPO_ROOT, 'production');
  const CHANGED = ['app-services.mjs', 'providers.mjs', 'providers/catalog.mjs', 'providers/moov-status-catch-up.mjs'];
  const ADDED = ['fed-holidays.mjs', 'providers/production/moov-wallet-withdraw.mjs', 'wallet-withdraw-limits.mjs'];
  assert.deepEqual(Object.keys(section.members), CHANGED);
  assert.deepEqual(Object.keys(section.added), ADDED);
  assert.deepEqual(section.removed, {});
  assert.deepEqual(section.dependencies, { added: {}, removed: {}, changed: {} });
  // Same difference as staging's seventh section; accepted is main's bytes.
  assert.deepEqual(section.members, staging.members);
  assert.deepEqual(section.added, staging.added);
  const apiRoot = path.join(REPO_ROOT, 'aws/functions/api');
  for (const name of CHANGED) assert.equal(section.members[name].accepted_sha256, sha256(fs.readFileSync(path.join(apiRoot, name))), name);
  for (const name of ADDED) assert.equal(section.added[name], sha256(fs.readFileSync(path.join(apiRoot, name))), name);
  // The plan as committed makes the inspected live package READY; other live bytes and an unlisted member refuse.
  const live = Object.fromEntries(CHANGED.map((name) => [name, section.members[name].live_sha256]));
  const candidate = {
    ...Object.fromEntries(CHANGED.map((name) => [name, section.members[name].accepted_sha256])),
    ...section.added,
  };
  const result = evaluateRebuild({ plan: raw, environment: 'production', liveMemberHashes: live, candidateMemberHashes: candidate, liveInventory: {}, candidateInventory: {} });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.state, 'READY');
  const drifted = evaluateRebuild({ plan: raw, environment: 'production', liveMemberHashes: { ...live, 'app-services.mjs': 'c'.repeat(64) }, candidateMemberHashes: candidate, liveInventory: {}, candidateInventory: {} });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.code, 'DEPLOYMENT_COLLISION');
  assert.deepEqual(drifted.details.problems.map((p) => p.reason), ['live_mismatch']);
  const extra = evaluateRebuild({ plan: raw, environment: 'production', liveMemberHashes: { ...live, 'providers/parity/sweep-read.mjs': 'a'.repeat(64) }, candidateMemberHashes: { ...candidate, 'providers/parity/sweep-read.mjs': 'b'.repeat(64) }, liveInventory: {}, candidateInventory: {} });
  assert.equal(extra.ok, false);
  assert.equal(extra.code, 'SOURCE_RECONCILIATION_REQUIRED');
  assert.deepEqual(extra.details.problems.map((p) => p.reason), ['unlisted_change']);
});

test('member and dependency diffs classify every live-vs-candidate difference', () => {
  const members = diffMembers(hashes(LIVE_FILES), hashes(CANDIDATE_FILES));
  assert.deepEqual(members.changed.map((row) => row.name), ['write.mjs']);
  assert.deepEqual(members.added.map((row) => row.name), ['new-on-main.mjs']);
  assert.deepEqual(members.removed.map((row) => row.name), ['live-only.mjs']);
  assert.ok(members.same.includes('ocr.mjs'));
  assert.ok(!members.same.some((name) => name.startsWith('node_modules/')));
  const deps = diffDependencies(inventoryOf(LIVE_FILES), inventoryOf(CANDIDATE_FILES));
  assert.deepEqual(deps, { added: { 'node_modules/@aws-sdk/client-kms': '3.1124.0' }, removed: {}, changed: {} });
});

test('an empty plan blocks with every difference listed as a problem; a full plan is READY; identical packages are ALREADY_ACCEPTED', () => {
  const base = { liveMemberHashes: hashes(LIVE_FILES), candidateMemberHashes: hashes(CANDIDATE_FILES), liveInventory: inventoryOf(LIVE_FILES), candidateInventory: inventoryOf(CANDIDATE_FILES), environment: 'staging' };
  const empty = evaluateRebuild({ ...base, plan: planFor({ function_name: 'checksops-staging-api', members: {}, added: {}, removed: {}, dependencies: {} }) });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, CODES.SOURCE_RECONCILIATION_REQUIRED);
  assert.deepEqual(empty.details.problems.map((row) => row.reason).sort(), ['unlisted_add', 'unlisted_change', 'unlisted_dependency_add', 'unlisted_removal']);
  const ready = evaluateRebuild({ ...base, plan: planFor(FULL_PLAN) });
  assert.equal(ready.ok, true, ready.message);
  assert.equal(ready.details.state, 'READY');
  const same = evaluateRebuild({ ...base, candidateMemberHashes: hashes(LIVE_FILES), candidateInventory: inventoryOf(LIVE_FILES), plan: planFor({ ...FULL_PLAN, members: {}, added: {}, removed: {}, dependencies: {} }) });
  assert.equal(same.details.state, 'ALREADY_ACCEPTED');
});

test('a listed member whose live bytes drifted, or whose candidate is not the accepted bytes, is refused', () => {
  const base = { liveMemberHashes: hashes(LIVE_FILES), candidateMemberHashes: hashes(CANDIDATE_FILES), liveInventory: inventoryOf(LIVE_FILES), candidateInventory: inventoryOf(CANDIDATE_FILES), environment: 'staging' };
  const drifted = evaluateRebuild({ ...base, plan: planFor({ ...FULL_PLAN, members: { 'write.mjs': { ...FULL_PLAN.members['write.mjs'], live_sha256: 'c'.repeat(64) } } }) });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.code, CODES.DEPLOYMENT_COLLISION);
  assert.equal(drifted.details.problems[0].reason, 'live_mismatch');
  const stale = evaluateRebuild({ ...base, plan: planFor({ ...FULL_PLAN, members: { 'write.mjs': { ...FULL_PLAN.members['write.mjs'], accepted_sha256: 'd'.repeat(64) } } }) });
  assert.equal(stale.code, CODES.STALE_PACKAGE);
  const wrongVersion = evaluateRebuild({ ...base, plan: planFor({ ...FULL_PLAN, dependencies: { added: { 'node_modules/@aws-sdk/client-kms': '3.0.0' } } }) });
  assert.equal(wrongVersion.ok, false);
  assert.equal(wrongVersion.details.problems[0].reason, 'unlisted_dependency_add');
  assert.throws(() => evaluateRebuild({ ...base, plan: planFor({ ...FULL_PLAN, members: { 'write.mjs': { live_sha256: 'e'.repeat(64), accepted_sha256: 'e'.repeat(64) } } }) }), /identical live and accepted/);
});

test('the candidate build is deterministic, needs node_modules, and refuses symlinks', () => {
  const root = tmpRepo();
  const api = path.join(root, 'aws/functions/api');
  const first = buildCandidatePackage(api);
  const second = buildCandidatePackage(api);
  assert.equal(first.zipSha256, second.zipSha256);
  assert.equal(first.fileCount, Object.keys(CANDIDATE_FILES).length);
  assert.deepEqual(readPackage(first.zip).memberHashes, first.memberHashes);
  assert.equal(first.inventory['node_modules/@aws-sdk/client-kms'], '3.1124.0');
  fs.rmSync(path.join(api, 'node_modules'), { recursive: true });
  assert.throws(() => buildCandidatePackage(api), /no node_modules/);
  const sourceCount = Object.keys(CANDIDATE_FILES).filter((name) => !name.startsWith('node_modules/')).length;
  assert.equal(buildCandidatePackage(api, { requireNodeModules: false }).fileCount, sourceCount);
  fs.symlinkSync(path.join(api, 'index.mjs'), path.join(api, 'link.mjs'));
  assert.throws(() => buildCandidatePackage(api, { requireNodeModules: false }), /symlink/);
});

function fakeLambda({ zip, codeSha256 = 'live-code', revisionId = 'rev-1', updateStatus = 'Successful', variables = { KEEP: '1' } }) {
  const state = { zip, codeSha256, revisionId, calls: [], variables: { ...variables } };
  const configuration = () => ({ Role: 'arn:role', Runtime: 'nodejs22.x', Handler: 'index.handler', MemorySize: 1024, Timeout: 30, Environment: { Variables: { ...state.variables } }, VpcConfig: { SubnetIds: ['a'], SecurityGroupIds: ['b'] } });
  const adapter = {
    state,
    authorizeWrites: (details) => { state.calls.push(['authorizeWrites', details]); return { ok: true }; },
    getFunction: async () => ({ ok: true, details: { codeSha256: state.codeSha256, revisionId: state.revisionId, code_location: 'https://example.invalid/zip', configuration: configuration() } }),
    getFunctionConfiguration: async () => ({ ok: true, details: { codeSha256: state.codeSha256, revisionId: state.revisionId, lastUpdateStatus: updateStatus, configuration: configuration() } }),
    downloadFunctionCode: async () => ({ ok: true, details: { zip: state.zip, origin: 'fresh-live-download' } }),
    updateFunctionCode: async ({ zip, revisionId }) => {
      state.calls.push(['updateFunctionCode', revisionId]);
      if (revisionId !== state.revisionId) return { ok: false, code: CODES.DEPLOYMENT_COLLISION, message: 'revision mismatch' };
      state.zip = zip;
      state.codeSha256 = `code-${sha256(zip).slice(0, 8)}`;
      state.revisionId = 'rev-2';
      return { ok: true, details: { codeSha256: state.codeSha256, revisionId: state.revisionId } };
    },
  };
  return adapter;
}

function issueRebuildReceipt(root, { candidateSha256, environment = 'staging', component = 'checksops-staging-api', fingerprint = { codeSha256: 'live-code', revisionId: 'rev-1' } }) {
  const lease = acquireLease(root, { workstream_id: 'ws-rebuild', component, environment, commit: SHA, operator: 'tester' }, NOW);
  assert.equal(lease.ok, true, lease.message);
  const issued = issueReceipt(root, {
    workstream_id: 'ws-rebuild',
    branch: 'main',
    commit: SHA,
    operator: 'tester',
    target_environment: environment,
    target_component: component,
    deployment_type: REBUILD_DEPLOYMENT_TYPE,
    owned_components: [fullPackageComponent(candidateSha256)],
    preflight_live_fingerprint: fingerprint,
    lease: lease.details.lease,
  }, { now: NOW });
  assert.equal(issued.ok, true, issued.message);
  return issued.details;
}

function stageCandidate(root, zip) {
  const dir = path.join(root, '.deployment-guard');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rebuild-candidate-staging.zip');
  fs.writeFileSync(file, zip);
  return file;
}

const applyInput = (root, receipt, candidatePath, extra = {}) => ({
  apply: true,
  function_name: 'checksops-staging-api',
  target_environment: 'staging',
  workstream_id: 'ws-rebuild',
  commit: SHA,
  receipt_path: receipt.file,
  candidate_zip_path: candidatePath,
  ...extra,
});
const applyCtx = (root, aws, receiptFile = null) => ({
  env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1', ...(receiptFile ? { CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: receiptFile } : {}) },
  guardRoot: root,
  repoRoot: root,
  aws,
  now: NOW,
});

test('the writer uploads the receipt-owned candidate, verifies every member and keeps configuration', async () => {
  const root = tmpRepo();
  const candidate = buildCandidatePackage(path.join(root, 'aws/functions/api'));
  const liveZip = writeZipMembers(LIVE_FILES);
  const aws = fakeLambda({ zip: liveZip });
  const receipt = issueRebuildReceipt(root, { candidateSha256: candidate.zipSha256 });
  const file = stageCandidate(root, candidate.zip);
  const result = await applyLambdaRebuild(applyInput(root, receipt, file), applyCtx(root, aws, receipt.file));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.details.candidate_zip_sha256, candidate.zipSha256);
  assert.deepEqual(readPackage(aws.state.zip).memberHashes, candidate.memberHashes);
  assert.equal(result.details.rebuild.state, 'READY');
  assert.equal(result.details.after.fingerprint.revisionId, 'rev-2');
  // The receipt is consumed: a second apply with the same receipt is refused.
  const again = await applyLambdaRebuild(applyInput(root, receipt, file), applyCtx(root, fakeLambda({ zip: liveZip }), receipt.file));
  assert.equal(again.ok, false);
});

// The rebuild result is printed to the GitHub Actions log: production rebuild run 39636816351
// printed the live CHECKSOPS_DB_BRIDGE_TOKEN through before/after.configuration.
const SECRET_VALUE = 'cobt_live_0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e';

test('the writer result names environment variables and hashes them, never printing a value', async () => {
  const root = tmpRepo();
  const candidate = buildCandidatePackage(path.join(root, 'aws/functions/api'));
  const aws = fakeLambda({ zip: writeZipMembers(LIVE_FILES), variables: { KEEP: '1', CHECKSOPS_DB_BRIDGE_TOKEN: SECRET_VALUE } });
  const receipt = issueRebuildReceipt(root, { candidateSha256: candidate.zipSha256 });
  const file = stageCandidate(root, candidate.zip);
  const result = await applyLambdaRebuild(applyInput(root, receipt, file), applyCtx(root, aws, receipt.file));
  assert.equal(result.ok, true, result.message);
  assert.equal(JSON.stringify(result, null, 2).includes(SECRET_VALUE), false);
  assert.deepEqual(result.details.before.configuration.Environment.variable_names, ['CHECKSOPS_DB_BRIDGE_TOKEN', 'KEEP']);
  assert.match(result.details.before.configuration.Environment.variables_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.details.after.configuration, result.details.before.configuration);
});

test('a value-only environment change after the upload fails with key names, never values', async () => {
  const root = tmpRepo();
  const candidate = buildCandidatePackage(path.join(root, 'aws/functions/api'));
  const aws = fakeLambda({ zip: writeZipMembers(LIVE_FILES), variables: { KEEP: '1', CHECKSOPS_DB_BRIDGE_TOKEN: SECRET_VALUE } });
  const rotated = `${SECRET_VALUE}-rotated`;
  const update = aws.updateFunctionCode;
  aws.updateFunctionCode = async (input) => {
    const res = await update(input);
    aws.state.variables.CHECKSOPS_DB_BRIDGE_TOKEN = rotated;
    return res;
  };
  const receipt = issueRebuildReceipt(root, { candidateSha256: candidate.zipSha256 });
  const file = stageCandidate(root, candidate.zip);
  const result = await applyLambdaRebuild(applyInput(root, receipt, file), applyCtx(root, aws, receipt.file));
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.UNRELATED_MUTATION);
  assert.deepEqual(result.details.changed_environment_keys, ['CHECKSOPS_DB_BRIDGE_TOKEN']);
  assert.deepEqual(result.details.before.Environment.variable_names, result.details.after.Environment.variable_names);
  const printed = JSON.stringify(result, null, 2);
  assert.equal(printed.includes(SECRET_VALUE), false);
  assert.equal(printed.includes(rotated), false);
});

test('the writer refuses a candidate the receipt does not own, a candidate outside the guard state, and live drift', async () => {
  const root = tmpRepo();
  const candidate = buildCandidatePackage(path.join(root, 'aws/functions/api'));
  const liveZip = writeZipMembers(LIVE_FILES);
  const receipt = issueRebuildReceipt(root, { candidateSha256: candidate.zipSha256 });
  const file = stageCandidate(root, candidate.zip);

  const tampered = path.join(root, '.deployment-guard', 'other.zip');
  fs.writeFileSync(tampered, writeZipMembers({ ...CANDIDATE_FILES, 'index.mjs': 'export const handler = "tampered";\n' }));
  const notOwned = await applyLambdaRebuild(applyInput(root, receipt, tampered), applyCtx(root, fakeLambda({ zip: liveZip }), receipt.file));
  assert.equal(notOwned.code, CODES.RECEIPT_MISMATCH);

  const outside = path.join(root, 'outside.zip');
  fs.writeFileSync(outside, candidate.zip);
  assert.equal(resolveCandidateZip(root, outside).code, CODES.UNRELATED_MUTATION);
  const outsideResult = await applyLambdaRebuild(applyInput(root, receipt, outside), applyCtx(root, fakeLambda({ zip: liveZip }), receipt.file));
  assert.equal(outsideResult.code, CODES.UNRELATED_MUTATION);

  const drifted = await applyLambdaRebuild(applyInput(root, receipt, file), applyCtx(root, fakeLambda({ zip: liveZip, revisionId: 'rev-9' }), receipt.file));
  assert.equal(drifted.code, CODES.DEPLOYMENT_COLLISION);

  const unlisted = await applyLambdaRebuild(applyInput(root, receipt, file, { plan: { ...FULL_PLAN, removed: {} } }), applyCtx(root, fakeLambda({ zip: liveZip }), receipt.file));
  assert.equal(unlisted.code, CODES.SOURCE_RECONCILIATION_REQUIRED);

  const noFlag = await applyLambdaRebuild(applyInput(root, receipt, file), { ...applyCtx(root, fakeLambda({ zip: liveZip }), receipt.file), env: { CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: receipt.file } });
  assert.equal(noFlag.code, CODES.GUARD_APPLY_FORBIDDEN);
  const restore = await applyLambdaRebuild(applyInput(root, receipt, file, { restore: true }), applyCtx(root, fakeLambda({ zip: liveZip }), receipt.file));
  assert.equal(restore.code, CODES.STALE_PACKAGE);
});

test('an overlay receipt cannot authorize a rebuild', async () => {
  const root = tmpRepo();
  const candidate = buildCandidatePackage(path.join(root, 'aws/functions/api'));
  const lease = acquireLease(root, { workstream_id: 'ws-rebuild', component: 'checksops-staging-api', environment: 'staging', commit: SHA }, NOW);
  const overlay = issueReceipt(root, {
    workstream_id: 'ws-rebuild', branch: 'main', commit: SHA, target_environment: 'staging', target_component: 'checksops-staging-api',
    deployment_type: 'lambda-overlay', owned_components: ['write.mjs'], preflight_live_fingerprint: { codeSha256: 'live-code', revisionId: 'rev-1' }, lease: lease.details.lease,
  }, { now: NOW });
  const file = stageCandidate(root, candidate.zip);
  const result = await applyLambdaRebuild(applyInput(root, overlay.details, file), applyCtx(root, fakeLambda({ zip: writeZipMembers(LIVE_FILES) }), overlay.details.file));
  assert.equal(result.code, CODES.RECEIPT_MISMATCH);
});

const ENV = { GITHUB_SHA: SHA, GITHUB_REF_NAME: 'main', GITHUB_ACTOR: 'owner', GITHUB_RUN_ID: '777', CHECKSOPS_REBUILD_ENVIRONMENT: 'staging' };
const liveDeps = (zip, extra = {}) => ({
  inspectLive: async () => ({ functionName: 'checksops-staging-api', codeSha256: 'live-code', revisionId: 'rev-1', ...readPackage(zip) }),
  signer: (unsigned) => unsigned,
  ...extra,
});

test('preflight inspect reports BLOCKED with the unlisted differences and writes the diff file', async () => {
  const root = tmpRepo({ plan: { function_name: 'checksops-staging-api', members: {}, added: {}, removed: {}, dependencies: {} } });
  const result = await preflight({ ...ENV, CHECKSOPS_REBUILD_MODE: 'inspect' }, { root, ...liveDeps(writeZipMembers(LIVE_FILES)) });
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.mutation, false);
  assert.equal(result.problems.length, 4);
  assert.ok(fs.existsSync(path.join(root, '.deployment-guard/rebuild-diff-staging.json')));
  assert.ok(!fs.existsSync(path.join(root, '.deployment-guard/rebuild-candidate-staging.zip')));
});

test('preflight apply needs the inspect CodeSha256 and the exact phrase, then issues a rebuild receipt and the candidate', async () => {
  const root = tmpRepo();
  const live = writeZipMembers(LIVE_FILES);
  await assert.rejects(
    preflight({ ...ENV, CHECKSOPS_REBUILD_MODE: 'apply', CHECKSOPS_EXPECTED_LIVE_CODE_SHA256: 'live-code', CHECKSOPS_REBUILD_APPROVAL: 'deploy please' }, { root, ...liveDeps(live) }),
    (error) => error.code === CODES.PRODUCTION_APPROVAL_REQUIRED,
  );
  await assert.rejects(
    preflight({ ...ENV, CHECKSOPS_REBUILD_MODE: 'apply', CHECKSOPS_EXPECTED_LIVE_CODE_SHA256: 'stale', CHECKSOPS_REBUILD_APPROVAL: approvalPhrase('staging') }, { root, ...liveDeps(live) }),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION,
  );
  const result = await preflight({ ...ENV, CHECKSOPS_REBUILD_MODE: 'apply', CHECKSOPS_EXPECTED_LIVE_CODE_SHA256: 'live-code', CHECKSOPS_REBUILD_APPROVAL: approvalPhrase('staging') }, { root, ...liveDeps(live) });
  assert.equal(result.state, 'READY');
  const receipt = JSON.parse(fs.readFileSync(result.authorization.receiptFile, 'utf8'));
  assert.equal(receipt.deployment_type, REBUILD_DEPLOYMENT_TYPE);
  assert.deepEqual(receipt.owned_components, [fullPackageComponent(result.candidate_zip_sha256)]);
  assert.equal(sha256(fs.readFileSync(result.authorization.candidateZip)), result.candidate_zip_sha256);
  const input = JSON.parse(fs.readFileSync(result.authorization.rebuildInput, 'utf8'));
  assert.equal(input.candidate_zip_path, result.authorization.candidateZip);
  // The writer accepts exactly what the preflight produced.
  const aws = fakeLambda({ zip: live });
  // The preflight issued the receipt at the real clock; apply at the real clock too.
  const applied = await applyLambdaRebuild({ ...input, apply: true }, { ...applyCtx(root, aws, input.receipt_path), now: Date.now() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
});

test('production apply needs a staging acceptance reference and refuses an unlisted plan', async () => {
  assert.throws(() => validateApplyInputs({ environment: 'production', approval: approvalPhrase('production'), stagingAcceptance: '', expectedLiveCodeSha256: 'x', liveCodeSha256: 'x' }), (error) => error.code === CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.doesNotThrow(() => validateApplyInputs({ environment: 'production', approval: approvalPhrase('production'), stagingAcceptance: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/1', expectedLiveCodeSha256: 'x', liveCodeSha256: 'x' }));
  const root = tmpRepo({ plan: { function_name: 'checksops-staging-api', members: {}, added: {}, removed: {}, dependencies: {} } });
  await assert.rejects(
    preflight({ ...ENV, CHECKSOPS_REBUILD_MODE: 'apply', CHECKSOPS_EXPECTED_LIVE_CODE_SHA256: 'live-code', CHECKSOPS_REBUILD_APPROVAL: approvalPhrase('staging') }, { root, ...liveDeps(writeZipMembers(LIVE_FILES)) }),
    (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
  );
});

test('preflight verify passes only when the live package equals the candidate', async () => {
  const root = tmpRepo();
  const candidateZip = buildCandidatePackage(path.join(root, 'aws/functions/api')).zip;
  const verified = await preflight({ ...ENV, CHECKSOPS_REBUILD_MODE: 'verify' }, { root, ...liveDeps(candidateZip) });
  assert.equal(verified.state, 'VERIFIED');
  await assert.rejects(
    preflight({ ...ENV, CHECKSOPS_REBUILD_MODE: 'verify' }, { root, ...liveDeps(writeZipMembers(LIVE_FILES)) }),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION,
  );
});

test('transfer to bank (2026-11-13, planning only): its seven API files wait for the full-package rebuild; only the seventh sections list them', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/lambda-rebuild-plan.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, TRANSFER_TO_BANK_MANIFEST), 'utf8'));
  const apiRoot = path.join(REPO_ROOT, 'aws/functions/api');
  const ADDS = ['wallet-withdraw-limits.mjs', 'fed-holidays.mjs', 'providers/production/moov-wallet-withdraw.mjs'];
  const REPLACES = ['app-services.mjs', 'providers/catalog.mjs', 'providers/moov-status-catch-up.mjs', 'providers.mjs'];
  assert.deepEqual(Object.keys(manifest.members).sort(), [...ADDS, ...REPLACES].sort());
  assert.equal(manifest.deploy_authorized, false);
  assert.ok(manifest.notes.includes('full-package API rebuild'));
  for (const [name, entry] of Object.entries(manifest.members)) {
    // Main's bytes are the accepted bytes; each REPLACE starts from the bytes its overlay row recorded live, never main's.
    assert.equal(sha256(fs.readFileSync(path.join(apiRoot, name))), entry.accepted_sha256, name);
    assert.equal(entry.operation, ADDS.includes(name) ? 'add' : 'replace', name);
    if (entry.operation === 'replace') assert.notEqual(entry.live_sha256, entry.accepted_sha256, name);
    else assert.equal(entry.live_sha256, null, name);
  }
  // The applied sixth sections (history[5] in both environments) list only the settlement bank fallback.
  for (const [environment, section] of [['staging', raw.environments.staging.history[5]], ['production', raw.environments.production.history[5]]]) {
    assert.equal(section.status, 'applied', environment);
    for (const name of [...ADDS, ...REPLACES]) {
      assert.equal(section.members[name], undefined, `${environment} ${name}`);
      assert.equal(section.added[name], undefined, `${environment} ${name}`);
    }
  }
  // The seventh sections (staging inspect 43458069245, applied 43460848634; production inspect 43461114623, applied
  // 43464046767) list exactly these seven, from the manifest's live bytes to main's: four changed, three added.
  const staging = raw.environments.staging;
  const production = raw.environments.production;
  assert.equal(staging.status, 'applied');
  assert.equal(production.status, 'applied');
  assert.equal(production.applied.run_id, '43464046767');
  for (const [environment, section] of [['staging', staging], ['production', production]]) {
    assert.deepEqual(Object.keys(section.members).sort(), [...REPLACES].sort(), environment);
    assert.deepEqual(Object.keys(section.added).sort(), [...ADDS].sort(), environment);
    for (const name of REPLACES) {
      assert.equal(section.members[name].live_sha256, manifest.members[name].live_sha256, `${environment} ${name}`);
      assert.equal(section.members[name].accepted_sha256, manifest.members[name].accepted_sha256, `${environment} ${name}`);
    }
    for (const name of ADDS) assert.equal(section.added[name], manifest.members[name].accepted_sha256, `${environment} ${name}`);
  }
  // The manifest stays planning only: the rebuild, not an overlay, carries these files to production.
  assert.equal(manifest.deploy_authorized, false);
  // Already listed as changed since the applied sections that record their older bytes.
  for (const name of ['providers.mjs', 'providers/catalog.mjs']) assert.equal(CHANGED_SINCE_SECOND_REBUILD[name], 'changed', name);
  assert.ok(CHANGED_SINCE_FOURTH_PRODUCTION_REBUILD.has('app-services.mjs'));
});

test('vendor payments API (2026-11-13, planning only): its three REPLACEs go through the production overlay plan from their applied bytes; no recorded rebuild section lists them', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/lambda-rebuild-plan.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, VENDOR_API_MANIFEST), 'utf8'));
  const overlay = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/production-api-overlay-plan.json'), 'utf8'));
  const apiRoot = path.join(REPO_ROOT, 'aws/functions/api');
  const REPLACES = ['providers/production/moov-send.mjs', 'workflow-rpc.mjs', 'tenant-billing-handlers.mjs'];
  assert.deepEqual(Object.keys(manifest.members), REPLACES);
  assert.equal(manifest.deploy_authorized, false);
  for (const [name, entry] of Object.entries(manifest.members)) {
    // Main's bytes accepted; each starts from the bytes its overlay row recorded live (an applied record), never main's.
    assert.equal(sha256(fs.readFileSync(path.join(apiRoot, name))), entry.accepted_sha256, name);
    assert.equal(entry.operation, 'replace', name);
    assert.notEqual(entry.live_sha256, entry.accepted_sha256, name);
    const row = overlay.members[name];
    assert.deepEqual([row.accepted_sha256, row.expected_live_sha256, row.manifest], [entry.accepted_sha256, entry.live_sha256, VENDOR_API_MANIFEST], name);
    assert.deepEqual(vendorApiPre(row).manifest, entry.previous_manifest, name);
  }
  // The current sections, applied in both environments, list none of them: a staging inspect of a full-package rebuild of
  // a main that carries this change would report them in its own section.
  for (const environment of ['staging', 'production']) {
    const section = raw.environments[environment];
    assert.equal(section.status, 'applied', environment);
    for (const name of REPLACES) {
      assert.equal(section.members[name], undefined, `${environment} ${name}`);
      assert.equal(section.added[name], undefined, `${environment} ${name}`);
    }
  }
});
