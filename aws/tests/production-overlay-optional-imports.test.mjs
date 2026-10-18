/**
 * Reviewed optional-import exemption in the guarded production Lambda overlay
 * (owner decision on the PR #1033 security review, 2026-10-18).
 *
 * providers/parity/moov-onboard.mjs and providers/parity/moov-functions.mjs load
 * invoice-actions.mjs / public-invoice.mjs by a whole-module dynamic import and
 * handle ERR_MODULE_NOT_FOUND. Those modules are absent from the live production
 * ZIP until a rebuilt ZIP. The apply-mode module-presence check skips a missing
 * module only when the plan lists it in that member's optional_imports AND the
 * member's bytes import it only by import() and handle ERR_MODULE_NOT_FOUND.
 * Every other missing import still refuses with DEPLOYMENT_COLLISION.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  FUNCTION_NAME,
  PLAN_REL,
  approvalPhrase,
  classifyLive,
  loadPlan,
  optionalImportProblems,
  resolvePlannedMember,
  run,
  validatePlanOptionalImports,
} from '../../scripts/deployment-guard/github-production-lambda-overlay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLAN = loadPlan(ROOT);
const API = path.join(ROOT, 'aws/functions/api');
const ONBOARD = 'providers/parity/moov-onboard.mjs';
const FUNCTIONS = 'providers/parity/moov-functions.mjs';
const SQL98_FILE = 'aws/workflows/sql/98_tenant_fee_collection.sql';
const ACCEPTANCE = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/37973071977';
const hash = (text) => createHash('sha256').update(text).digest('hex');

// Not in the live production ZIP (plan notes: absent from the live bundle, reach
// production only with a rebuilt ZIP). No recorded full production member list
// exists in the repository, so main's modules minus these stand in for it.
const PRODUCTION_ABSENT = [
  'invoice-actions.mjs',
  'invoice-provider.mjs',
  'public-invoice.mjs',
  'tenant-collection-v2-uat.mjs',
  'tenant-maintenance-payments-catalog-inspect.mjs',
];

function repoModules(dir = API, prefix = '') {
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const rel = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(out, repoModules(path.join(dir, entry.name), `${rel}/`));
    else if (entry.name.endsWith('.mjs')) out[rel] = fs.readFileSync(path.join(dir, entry.name), 'utf8');
  }
  return out;
}
const REPO_MODULES = {
  ...repoModules(),
  'mortgage-ops-usage.mjs': 'export async function accrueMortgageOpsAcceptedRequest() {}\n',
};

// Live ZIP stand-in for `member` (as in github-production-lambda-overlay.test.mjs):
// earlier plan members on their accepted bytes, later REPLACE members on their
// reconciled pre-deploy bytes, later ADD members absent, plus `absent` removed.
function liveFor(member, { plan = PLAN, absent = PRODUCTION_ABSENT } = {}) {
  const index = plan.order.indexOf(member);
  const sources = { ...REPO_MODULES };
  for (const name of absent) delete sources[name];
  const memberHashes = {};
  for (const name of Object.keys(sources)) {
    const row = plan.members[name];
    if (!row) { memberHashes[name] = hash(sources[name]); continue; }
    const position = plan.order.indexOf(name);
    if (name === member) memberHashes[name] = row.expected_live_sha256;
    else if (position < index) memberHashes[name] = row.accepted_sha256;
    else if (row.operation === 'replace') memberHashes[name] = row.expected_live_sha256;
  }
  for (const name of Object.keys(sources)) if (!Object.hasOwn(memberHashes, name)) delete sources[name];
  return {
    functionName: FUNCTION_NAME,
    codeSha256: 'oQDCIRFyreTPe781aeSFLdXNfU3M2ZUQo5Wcgi0EqWI=',
    revisionId: 'f4904e55-61b3-46c4-bf1f-da178e84911b',
    member,
    memberState: 'PRESENT',
    memberSha256: plan.members[member].expected_live_sha256,
    members: Object.keys(memberHashes),
    memberHashes,
    sources,
  };
}

const withoutOptional = (member) => {
  const plan = structuredClone(PLAN);
  delete plan.members[member].optional_imports;
  return plan;
};

const applyClassify = (member, { plan = PLAN, planned, live } = {}) => {
  const resolved = planned || resolvePlannedMember(member, { root: ROOT, plan });
  assert.equal(resolved.ok ?? true, true, JSON.stringify(resolved));
  const details = resolved.details || resolved;
  return classifyLive(details, live || liveFor(member, { plan }), {
    plan,
    mode: 'apply',
    expectedLiveSha256: plan.members[member].expected_live_sha256,
  });
};

const collision = (fn, check = () => true) => assert.throws(fn, (error) => {
  assert.equal(error.code, CODES.DEPLOYMENT_COLLISION, error.message);
  return check(error) !== false;
});

test('plan lists exactly the reviewed optional imports, in the guard path form', () => {
  const listed = Object.fromEntries(Object.entries(PLAN.members)
    .filter(([, row]) => Object.hasOwn(row, 'optional_imports'))
    .map(([name, row]) => [name, row.optional_imports]));
  assert.deepEqual(listed, {
    [ONBOARD]: ['invoice-actions.mjs'],
    [FUNCTIONS]: ['public-invoice.mjs'],
  });
  assert.equal(Object.hasOwn(PLAN.members, 'invoice-provider.mjs'), false);
  for (const name of PRODUCTION_ABSENT) assert.equal(PLAN.order.includes(name), false, name);
  for (const [member, modules] of Object.entries(listed)) {
    const resolved = resolvePlannedMember(member, { root: ROOT, plan: PLAN });
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    for (const module of modules) assert.ok(resolved.details.imports.includes(module), `${member} imports ${module}`);
    assert.deepEqual(resolved.details.optionalImports, modules);
  }
});

test('(a) apply: both re-pinned members are accepted against a live ZIP without the invoice modules', () => {
  for (const member of [FUNCTIONS, ONBOARD]) {
    const live = liveFor(member);
    for (const name of ['invoice-actions.mjs', 'public-invoice.mjs', 'invoice-provider.mjs']) {
      assert.equal(live.members.includes(name), false, name);
    }
    assert.deepEqual(applyClassify(member, { live }), { state: 'READY' }, member);
  }
});

test('(a) apply run(): the guarded workflow entry point accepts both members and issues one receipt each', async () => {
  for (const member of [FUNCTIONS, ONBOARD]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-overlay-optional-'));
    fs.mkdirSync(path.join(root, path.dirname(PLAN_REL)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, PLAN_REL), path.join(root, PLAN_REL));
    fs.mkdirSync(path.join(root, 'aws/functions/api/providers/parity'), { recursive: true });
    fs.copyFileSync(path.join(API, member), path.join(root, 'aws/functions/api', member));
    const calls = {};
    const result = await run({
      GITHUB_SHA: 'a'.repeat(40),
      GITHUB_REF_NAME: 'main',
      GITHUB_ACTOR: 'owner',
      GITHUB_RUN_ID: '12345',
      CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'apply',
      CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: member,
      CHECKSOPS_EXPECTED_LIVE_MEMBER_SHA256: PLAN.members[member].expected_live_sha256,
      CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE: ACCEPTANCE,
      CHECKSOPS_PRODUCTION_APPROVAL: approvalPhrase(member),
    }, {
      root,
      inspectLive: async () => liveFor(member),
      acquireLease: (_root, input) => ({ ok: true, details: { lease: { id: 'lease-1', ...input } } }),
      issueReceipt: (_root, input) => { calls.receipt = input; return { ok: true, details: { file: path.join(root, 'receipt.json') } }; },
    });
    assert.equal(result.state, 'READY', member);
    assert.deepEqual(calls.receipt.owned_member_ops, { replace: [member], add: [] });
  }
});

test('(b) the same members without optional_imports are refused with DEPLOYMENT_COLLISION', () => {
  for (const [member, module] of [[FUNCTIONS, 'public-invoice.mjs'], [ONBOARD, 'invoice-actions.mjs']]) {
    const plan = withoutOptional(member);
    collision(() => applyClassify(member, { plan }), (error) => {
      assert.deepEqual(error.details.missing, [module]);
    });
  }
  // A planned member built by hand without the list is refused the same way.
  const resolved = resolvePlannedMember(ONBOARD, { root: ROOT, plan: PLAN }).details;
  collision(() => applyClassify(ONBOARD, { planned: { ...resolved, optionalImports: undefined } }));
});

test('(c) a listed optional module imported statically is refused', () => {
  const resolved = resolvePlannedMember(ONBOARD, { root: ROOT, plan: PLAN }).details;
  for (const line of [
    "import { runInvoiceAction } from '../../invoice-actions.mjs';\n",
    "import '../../invoice-actions.mjs';\n",
    "export { runInvoiceAction } from '../../invoice-actions.mjs';\n",
  ]) {
    const source = line + resolved.source;
    assert.ok(optionalImportProblems(ONBOARD, source, ['invoice-actions.mjs']).some((p) => /statically/.test(p)), line);
    collision(() => applyClassify(ONBOARD, { planned: { ...resolved, source } }), (error) => {
      assert.ok(error.details.problems.some((p) => /statically/.test(p)), JSON.stringify(error.details));
    });
  }
  // Destructured dynamic import (a missing module could not be told from a dropped export).
  {
    const source = `${resolved.source}\nconst f = async () => { const { runInvoiceAction } = await import('../../invoice-actions.mjs'); return runInvoiceAction; };\n`;
    collision(() => applyClassify(ONBOARD, { planned: { ...resolved, source } }), (error) => {
      assert.ok(error.details.problems.some((p) => /destructured/.test(p)));
    });
  }
  // Bytes that do not handle ERR_MODULE_NOT_FOUND.
  {
    const source = resolved.source.replaceAll('ERR_MODULE_NOT_FOUND', 'ERR_SOMETHING_ELSE');
    collision(() => applyClassify(ONBOARD, { planned: { ...resolved, source } }), (error) => {
      assert.ok(error.details.problems.some((p) => /ERR_MODULE_NOT_FOUND/.test(p)));
    });
  }
  // resolvePlannedMember refuses such bytes before any live inspect (accepted pin moved to them).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-overlay-static-'));
  const source = `import { runInvoiceAction } from '../../invoice-actions.mjs';\n${resolved.source}`;
  fs.mkdirSync(path.join(root, 'aws/functions/api/providers/parity'), { recursive: true });
  fs.writeFileSync(path.join(root, 'aws/functions/api', ONBOARD), source);
  const plan = structuredClone(PLAN);
  plan.members[ONBOARD].accepted_sha256 = hash(source);
  const refused = resolvePlannedMember(ONBOARD, { root, plan });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, CODES.INVALID_MANIFEST);
  assert.ok(refused.details.problems.some((p) => /statically/.test(p)));
});

test('(d) a missing module that is not listed is still refused', () => {
  // Listed module missing too, plus a non-listed one: only the non-listed one is reported.
  for (const [member, other] of [[ONBOARD, 'providers/parity/moov-wallet.mjs'], [FUNCTIONS, 'providers/parity/db.mjs']]) {
    const live = liveFor(member, { absent: [...PRODUCTION_ABSENT, other] });
    collision(() => applyClassify(member, { live }), (error) => {
      assert.deepEqual(error.details.missing, [other]);
    });
  }
  // A module listed for one member does not exempt another member.
  const resolved = resolvePlannedMember(FUNCTIONS, { root: ROOT, plan: PLAN }).details;
  const source = `${resolved.source}\nconst g = async () => { try { return await import('../../invoice-actions.mjs'); } catch (e) { if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e; } };\n`;
  const planned = { ...resolved, source, imports: [...resolved.imports, 'invoice-actions.mjs'].sort() };
  collision(() => applyClassify(FUNCTIONS, { planned }), (error) => {
    assert.deepEqual(error.details.missing, ['invoice-actions.mjs']);
  });
});

test('optional_imports shape is validated wherever the plan is loaded', () => {
  const bad = [
    'invoice-actions.mjs',
    [],
    [''],
    ['./invoice-actions.mjs'],
    ['../invoice-actions.mjs'],
    ['/invoice-actions.mjs'],
    ['providers/../invoice-actions.mjs'],
    ['invoice-actions.js'],
    ['invoice actions.mjs'],
    ['invoice-actions.mjs', 'invoice-actions.mjs'],
    [ONBOARD],
    [42],
  ];
  for (const value of bad) {
    const plan = structuredClone(PLAN);
    plan.members[ONBOARD].optional_imports = value;
    assert.throws(() => validatePlanOptionalImports(plan), (error) => error.code === CODES.INVALID_MANIFEST, JSON.stringify(value));
    const resolved = resolvePlannedMember(ONBOARD, { root: ROOT, plan });
    assert.equal(resolved.ok, false, JSON.stringify(value));
    assert.equal(resolved.code, CODES.INVALID_MANIFEST, JSON.stringify(value));
  }
  // loadPlan refuses a plan file with a bad list.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-overlay-plan-'));
  fs.mkdirSync(path.join(root, path.dirname(PLAN_REL)), { recursive: true });
  const plan = structuredClone(PLAN);
  plan.members[FUNCTIONS].optional_imports = ['../public-invoice.mjs'];
  fs.writeFileSync(path.join(root, PLAN_REL), JSON.stringify(plan));
  assert.throws(() => loadPlan(root), (error) => error.code === CODES.INVALID_MANIFEST);
  // A well-formed entry for a module the member does not import (unknown module) is refused.
  for (const [member, module] of [[ONBOARD, 'public-invoice.mjs'], [FUNCTIONS, 'invoice-provider.mjs'], [ONBOARD, 'email.mjs']]) {
    const unknown = structuredClone(PLAN);
    unknown.members[member].optional_imports = [module];
    const resolved = resolvePlannedMember(member, { root: ROOT, plan: unknown });
    assert.equal(resolved.ok, false, `${member} ${module}`);
    assert.equal(resolved.code, CODES.INVALID_MANIFEST);
  }
  // email.mjs is a static import of moov-onboard.mjs: even when it is imported, listing it is refused.
  assert.ok(optionalImportProblems(ONBOARD, fs.readFileSync(path.join(API, ONBOARD), 'utf8'), ['email.mjs'])
    .some((p) => /statically/.test(p)));
});

test('the exemption only covers the module-presence check: ordering and SQL holds still apply', () => {
  // An earlier plan member not yet on its accepted bytes still blocks the re-pinned members.
  for (const member of [FUNCTIONS, ONBOARD]) {
    const live = liveFor(member);
    const earlier = PLAN.order[PLAN.order.indexOf(member) - 1];
    live.memberHashes[earlier] = 'f'.repeat(64);
    collision(() => applyClassify(member, { live }), (error) => {
      assert.ok(error.details.pending.includes(earlier));
    });
  }
  // Members after them in order are not blocked by the invoice modules being absent.
  const later = PLAN.order.slice(PLAN.order.indexOf(ONBOARD) + 1)
    .filter((name) => !PLAN.members[name].sql_before || PLAN.members[name].sql_before === SQL98_FILE)
    .slice(0, 3);
  assert.ok(later.some((member) => PLAN.members[member].operation === 'replace'), JSON.stringify(later));
  const plan = structuredClone(PLAN);
  plan.sql_prerequisites[SQL98_FILE] = { verified_live: true, evidence: 'test' };
  for (const member of later) {
    if (PLAN.members[member].operation !== 'replace') continue;
    assert.deepEqual(applyClassify(member, { plan, live: liveFor(member, { plan }) }), { state: 'READY' }, member);
  }
});
