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
};
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
  assert.equal(raw.environments.production.history.length, 2);
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

test('the production plan section accepts inspect run 39666717878: Moov transfer returns, the same 1 changed and 1 added as staging', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/lambda-rebuild-plan.json'), 'utf8'));
  const production = raw.environments.production;
  const staging = raw.environments.staging;
  const second = production.history[1];
  assert.equal(production.status, 'accepted');
  assert.equal(production.applied, undefined);
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
  assert.equal(production.inspect.live_code_sha256, staging.inspect.live_code_sha256);
  assert.equal(production.inspect.candidate_zip_sha256, staging.inspect.candidate_zip_sha256);
  const section = loadRebuildPlan(REPO_ROOT, 'production');
  assert.deepEqual(Object.keys(section.members), ['providers/webhooks.mjs']);
  assert.deepEqual(Object.keys(section.added), ['providers/moov-transfer-webhook.mjs']);
  assert.deepEqual(section.removed, {});
  assert.deepEqual(section.dependencies, { added: {}, removed: {}, changed: {} });
  assert.equal(production.inspect.changed, 1);
  assert.equal(production.inspect.added, 1);
  assert.equal(production.inspect.removed, 0);
  assert.deepEqual(production.inspect.dependency_counts, { live: 54, candidate: 54 });
  // Production and staging ran the same package before this rebuild, so the differences match.
  assert.deepEqual(section.members, staging.members);
  assert.deepEqual(section.added, staging.added);
  const apiRoot = path.join(REPO_ROOT, 'aws/functions/api');
  for (const [name, entry] of Object.entries(section.members)) {
    assert.equal(sha256(fs.readFileSync(path.join(apiRoot, name))), entry.accepted_sha256, name);
    assert.equal(entry.live_sha256, second.members[name].accepted_sha256, name);
  }
  for (const [name, hash] of Object.entries(section.added)) {
    assert.equal(sha256(fs.readFileSync(path.join(apiRoot, name))), hash, name);
    assert.equal(second.members[name] || second.added[name], undefined, name);
  }
  for (const name of Object.keys(CHANGED_SINCE_SECOND_REBUILD)) {
    if (name === 'providers/production/checkalt-eligibility.mjs') assert.equal(section.members[name], undefined, name);
    else assert.ok(section.members[name], `${name} changed on main but is not a production member`);
  }
  // The plan as committed makes the inspected live package READY, not BLOCKED.
  const live = {};
  const candidate = {};
  for (const [name, entry] of Object.entries(section.members)) { live[name] = entry.live_sha256; candidate[name] = entry.accepted_sha256; }
  for (const [name, hash] of Object.entries(section.added)) candidate[name] = hash;
  const result = evaluateRebuild({ plan: raw, environment: 'production', liveMemberHashes: live, candidateMemberHashes: candidate, liveInventory: {}, candidateInventory: {} });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.state, 'READY');
});

test('the staging history keeps the first rebuild (inspect 39585059839, apply 39587414391) and every accepted hash is the bytes on main or a listed later change', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/lambda-rebuild-plan.json'), 'utf8'));
  const staging = raw.environments.staging;
  assert.equal(staging.history.length, 2);
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

test('the staging plan section accepts inspect run 39663300105: Moov transfer returns (1 changed, 1 added, 0 removed)', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/lambda-rebuild-plan.json'), 'utf8'));
  const staging = raw.environments.staging;
  const second = staging.history[1];
  assert.equal(staging.status, 'accepted');
  assert.equal(staging.applied, undefined);
  assert.equal(staging.inspect.run_id, '39663300105');
  assert.equal(staging.inspect.main_commit, 'c92fe457b13ca49340dfbd0239f0cf72f029f6fb');
  assert.equal(staging.inspect.live_code_sha256, '+cyvVRtA46woHP4FwFBBZoN80aXR4A8Vo6adu5E1/NE=');
  assert.equal(staging.inspect.live_revision_id, '3686cef2-0dd1-4fa2-9976-f6dbc139a46e');
  assert.equal(staging.inspect.candidate_zip_sha256, 'a4d09ec006855355b523a176669028ec4970127d6f145997bdfb7d8fabecaff7');
  // The package the rebuild starts from is the second rebuild's, plus the #1124 overlay of
  // checkalt-eligibility.mjs (staging overlay run 39662525342), which already equals main.
  assert.notEqual(staging.inspect.live_code_sha256, second.applied.code_sha256_after);
  const section = loadRebuildPlan(REPO_ROOT, 'staging');
  assert.deepEqual(Object.keys(section.members), ['providers/webhooks.mjs']);
  assert.deepEqual(Object.keys(section.added), ['providers/moov-transfer-webhook.mjs']);
  assert.deepEqual(section.removed, {});
  assert.deepEqual(section.dependencies, { added: {}, removed: {}, changed: {} });
  assert.equal(staging.inspect.changed, 1);
  assert.equal(staging.inspect.added, 1);
  assert.equal(staging.inspect.removed, 0);
  assert.deepEqual(staging.inspect.dependency_counts, { live: 54, candidate: 54 });
  const apiRoot = path.join(REPO_ROOT, 'aws/functions/api');
  for (const [name, entry] of Object.entries(section.members)) {
    // Accepted is main's bytes; live is the bytes the second rebuild accepted and put live.
    assert.equal(sha256(fs.readFileSync(path.join(apiRoot, name))), entry.accepted_sha256, name);
    assert.equal(entry.live_sha256, second.members[name].accepted_sha256, name);
  }
  for (const [name, hash] of Object.entries(section.added)) {
    assert.equal(sha256(fs.readFileSync(path.join(apiRoot, name))), hash, name);
    assert.equal(second.members[name] || second.added[name], undefined, name);
  }
  // Every file main changed after the second rebuild is a member here, or already live at main's bytes
  // through the overlay (checkalt-eligibility.mjs, counted as same by the inspect).
  for (const name of Object.keys(CHANGED_SINCE_SECOND_REBUILD)) {
    if (name === 'providers/production/checkalt-eligibility.mjs') assert.equal(section.members[name], undefined, name);
    else assert.ok(section.members[name], `${name} changed on main but is not a staging member`);
  }
  // The plan as committed makes the inspected live package READY, not BLOCKED.
  const live = {};
  const candidate = {};
  for (const [name, entry] of Object.entries(section.members)) { live[name] = entry.live_sha256; candidate[name] = entry.accepted_sha256; }
  for (const [name, hash] of Object.entries(section.added)) candidate[name] = hash;
  const result = evaluateRebuild({ plan: raw, environment: 'staging', liveMemberHashes: live, candidateMemberHashes: candidate, liveInventory: {}, candidateInventory: {} });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.state, 'READY');
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
