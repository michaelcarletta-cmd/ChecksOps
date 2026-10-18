#!/usr/bin/env node
/**
 * GitHub-hosted guarded production overlay for checksops-production-prep-api.
 *
 * One member per run, only members in ops/deployment-guard/production-api-overlay-plan.json.
 * Main's bytes must equal the accepted SHA-256. REPLACE requires the live member to
 * still be the reconciled pre-deploy bytes; ADD requires it to be absent. Apply also
 * requires a staging acceptance reference and the exact per-member approval phrase,
 * and the official overlay writer re-checks the production gate before writing.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, GuardError } from './lib/errors.mjs';
import { acquireLease } from './lib/lease.mjs';
import { issueReceiptWithSigner } from './lib/receipt.mjs';
import { signReceiptWithKms } from './lib/kms-issuer.mjs';
import { validateZipMemberName } from './lib/lambda-owned-members.mjs';
import { readZipMembers } from './lib/zip-members.mjs';

export const FUNCTION_NAME = 'checksops-production-prep-api';
export const PLAN_REL = 'ops/deployment-guard/production-api-overlay-plan.json';
const REGION = 'us-east-1';
const HEX64 = /^[0-9a-f]{64}$/i;
const STAGING_ACCEPTANCE_RE = /^https:\/\/github\.com\/michaelcarletta-cmd\/ChecksOps\/(actions\/runs\/\d+(\/job\/\d+)?|pull\/\d+)$/;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function loadPlan(root = repoRoot) {
  const plan = JSON.parse(fs.readFileSync(path.join(root, PLAN_REL), 'utf8'));
  if (plan.function_name !== FUNCTION_NAME) {
    throw new GuardError(CODES.UNRELATED_MUTATION, 'production overlay plan targets a different function');
  }
  validatePlanOptionalImports(plan);
  return plan;
}

const OPTIONAL_IMPORT_RE = /^(?!\.{0,2}\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._/-]+\.mjs$/;

/**
 * Shape of the reviewed optional_imports list on a plan member: an array of
 * distinct ZIP member paths (as localImports resolves them: relative to the ZIP
 * root, no leading ./ or ../ or /, ending .mjs). The member-specific checks (the
 * member imports it, only by a dynamic import, and handles ERR_MODULE_NOT_FOUND)
 * run in optionalImportProblems against the member's bytes.
 */
export function validatePlanOptionalImports(plan) {
  for (const [name, row] of Object.entries(plan?.members || {})) {
    if (!Object.hasOwn(row, 'optional_imports')) continue;
    const list = row.optional_imports;
    const bad = (reason) => new GuardError(CODES.INVALID_MANIFEST, 'optional_imports must be a reviewed list of relative .mjs ZIP member paths', { member: name, reason });
    if (!Array.isArray(list) || list.length === 0) throw bad('not_a_non_empty_array');
    if (new Set(list).size !== list.length) throw bad('duplicate_entry');
    for (const entry of list) {
      if (typeof entry !== 'string' || !OPTIONAL_IMPORT_RE.test(entry) || path.posix.normalize(entry) !== entry) throw bad('invalid_path');
      if (entry === name) throw bad('self_import');
    }
  }
}

/** Relative specifiers in `source` that resolve to ZIP member `target`, by import form. */
function importForms(source, fromMember, target) {
  const dir = path.posix.dirname(fromMember);
  const resolves = (spec) => path.posix.normalize(path.posix.join(dir, spec)) === target;
  const forms = { static: 0, dynamic: 0, destructured: 0 };
  for (const m of String(source).matchAll(/(?:\bfrom\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+\.mjs)['"]/g)) if (resolves(m[1])) forms.static += 1;
  for (const m of String(source).matchAll(/\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+\.mjs)['"]\s*\)/g)) if (resolves(m[1])) forms.dynamic += 1;
  for (const m of String(source).matchAll(/\}\s*=\s*await\s+import\(\s*['"](\.{1,2}\/[^'"]+\.mjs)['"]\s*\)/g)) if (resolves(m[1])) forms.destructured += 1;
  return forms;
}

/**
 * Reviewed exemption from the live module-presence check: a module listed in the
 * member's optional_imports may be missing from the live ZIP only if the member's
 * bytes import it, only by a whole-module dynamic import(), never statically
 * (from / bare import) and never destructured, and handle a missing module
 * (ERR_MODULE_NOT_FOUND). Returns the problems (empty when the exemption holds).
 */
export function optionalImportProblems(memberName, source, optionalImports = [], imports = localImports(source, memberName)) {
  const problems = [];
  const text = String(source || '');
  if (optionalImports.length && !text.includes('ERR_MODULE_NOT_FOUND')) {
    problems.push(`${memberName} does not handle ERR_MODULE_NOT_FOUND`);
  }
  for (const module of optionalImports) {
    if (!imports.includes(module)) {
      problems.push(`${module} is not imported by ${memberName}`);
      continue;
    }
    const forms = importForms(text, memberName, module);
    if (forms.static) problems.push(`${module} is imported statically by ${memberName}`);
    if (forms.destructured) problems.push(`${module} is imported by a destructured dynamic import in ${memberName}`);
    if (!forms.dynamic) problems.push(`${module} is not imported by a dynamic import() in ${memberName}`);
  }
  return problems;
}

export function approvalPhrase(member) {
  return `DEPLOY ${member} TO PRODUCTION`;
}

/** Plan membership, accepted source bytes and SQL prerequisites. */
export function resolvePlannedMember(member, { root = repoRoot, plan = loadPlan(root) } = {}) {
  const named = validateZipMemberName(member, 'production overlay member');
  if (!named.ok) return named;
  const name = named.details.member;
  if ((plan.do_not_overlay || []).includes(name) || !plan.order.includes(name) || !plan.members[name]) {
    return { ok: false, code: CODES.UNRELATED_MUTATION, message: 'member is not in the accepted production overlay plan', details: { member: name } };
  }
  const row = plan.members[name];
  const sourceRelative = `aws/functions/api/${name}`;
  const source = path.join(root, sourceRelative);
  if (!fs.existsSync(source)) {
    return { ok: false, code: CODES.STALE_PACKAGE, message: 'accepted member is missing from main', details: { member: name } };
  }
  const bytes = fs.readFileSync(source);
  const sourceSha256 = sha256(bytes);
  try {
    validatePlanOptionalImports({ members: { [name]: row } });
  } catch (error) {
    return { ok: false, code: error.code, message: error.message, details: error.details };
  }
  if (sourceSha256 !== row.accepted_sha256) {
    return {
      ok: false,
      code: CODES.SOURCE_RECONCILIATION_REQUIRED,
      message: "main's member bytes are not the accepted production bytes",
      details: { member: name, source_sha256: sourceSha256, accepted_sha256: row.accepted_sha256 },
    };
  }
  const text = bytes.toString('utf8');
  const imports = localImports(text, name);
  const optionalImports = row.optional_imports || [];
  // Every listed module must be one this member imports (no unknown modules), by a
  // whole-module dynamic import only, in bytes that handle ERR_MODULE_NOT_FOUND.
  const problems = optionalImportProblems(name, text, optionalImports, imports);
  if (problems.length) {
    return { ok: false, code: CODES.INVALID_MANIFEST, message: 'optional_imports is not handled by the accepted member bytes', details: { member: name, problems } };
  }
  return {
    ok: true,
    details: {
      member: name,
      operation: row.operation,
      acceptedSha256: row.accepted_sha256,
      expectedLiveSha256: row.expected_live_sha256 || null,
      sqlBefore: row.sql_before || null,
      sourceRelative,
      imports,
      optionalImports,
      source: text,
    },
  };
}

/** Relative static and dynamic imports, resolved against the member's ZIP directory. */
export function localImports(source, fromMember = '') {
  const dir = path.posix.dirname(fromMember);
  const found = new Set();
  const re = /(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[A-Za-z0-9._/-]+\.mjs)['"]/g;
  let match;
  while ((match = re.exec(source))) found.add(path.posix.normalize(path.posix.join(dir, match[1])));
  return [...found].sort();
}

/**
 * Named imports from relative modules, resolved to ZIP member paths: static
 * `import { a } from './x.mjs'` and destructured dynamic
 * `const { a } = await import('./x.mjs')` (a dropped name there fails at call
 * time instead of link time, so it is refused the same way).
 */
export function namedImports(source, fromMember = '') {
  const dir = path.posix.dirname(fromMember);
  const out = [];
  const patterns = [
    { re: /import\s*\{([^}]*)\}\s*from\s*['"](\.{1,2}\/[^'"]+\.mjs)['"]/g, split: /\s+as\s+/ },
    { re: /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*['"](\.{1,2}\/[^'"]+\.mjs)['"]\s*\)/g, split: /\s*:\s*/ },
  ];
  for (const { re, split } of patterns) {
    let match;
    while ((match = re.exec(source))) {
      const names = match[1].split(',').map((part) => part.trim().split(split)[0].trim()).filter(Boolean);
      const unparsed = names.filter((name) => !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name));
      if (unparsed.length) {
        // Fail closed: a binding the scanner cannot read (nested destructuring,
        // defaults, a rest element, a comment) could hide a dropped export.
        throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'cannot verify imported names; refuse rather than guess', {
          member: fromMember, module: match[2], unparsed,
        });
      }
      out.push({ module: path.posix.normalize(path.posix.join(dir, match[2])), names });
    }
  }
  // Fail closed on a destructured dynamic import of a relative module that the
  // pattern above could not read (nested destructuring, defaults with braces).
  const dynamicTargets = [...String(source).matchAll(/\}\s*=\s*await\s+import\(\s*['"](\.{1,2}\/[^'"]+\.mjs)['"]\s*\)/g)].length;
  const dynamicRead = [...String(source).matchAll(patterns[1].re)].length;
  if (dynamicTargets !== dynamicRead) {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'cannot verify imported names; refuse rather than guess', {
      member: fromMember, reason: 'unreadable_dynamic_import',
    });
  }
  return out;
}

export function exportNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z0-9_$]+)/g)) names.add(match[1]);
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(',')) {
      const [local, alias] = part.trim().split(/\s+as\s+/);
      if (local) names.add((alias || local).trim());
    }
  }
  return names;
}

/**
 * ESM link check against the live ZIP: every name the new member imports must be
 * exported by the live module, and every live module that imports from this member
 * must still find its names in the new bytes. A failure here would take the whole
 * Lambda down at module link time.
 */
export function linkProblems(memberName, newSource, liveSources) {
  const problems = [];
  for (const { module, names } of namedImports(newSource, memberName)) {
    if (!Object.hasOwn(liveSources, module)) {
      problems.push(`${module} is not live`);
      continue;
    }
    const exported = exportNames(liveSources[module]);
    for (const name of names) if (!exported.has(name)) problems.push(`${module} does not export ${name}`);
  }
  const newExports = exportNames(newSource);
  for (const [file, source] of Object.entries(liveSources)) {
    if (file === memberName) continue;
    for (const { module, names } of namedImports(source, file)) {
      if (module !== memberName) continue;
      for (const name of names) if (!newExports.has(name)) problems.push(`${file} imports ${name} from ${memberName}, which the new bytes drop`);
    }
  }
  return problems;
}

/**
 * Decide what a run may do given the live member state. Returns
 * { state: 'ALREADY_ACCEPTED' | 'READY', ... } or throws a GuardError.
 */
export function classifyLive(planned, live, { plan, expectedLiveSha256 = null, mode = 'inspect' } = {}) {
  if (live.memberSha256 && live.memberSha256 === planned.acceptedSha256) {
    return { state: 'ALREADY_ACCEPTED' };
  }
  if (planned.operation === 'add') {
    if (live.memberState !== 'ABSENT') {
      throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'ADD requires the member to be absent from the live production ZIP', { member: planned.member, live_sha256: live.memberSha256 });
    }
  } else {
    if (live.memberState !== 'PRESENT' || live.memberSha256 !== planned.expectedLiveSha256) {
      throw new GuardError(CODES.SOURCE_RECONCILIATION_REQUIRED, 'live production member is not the reconciled pre-deploy bytes; refuse same-file overwrite', {
        member: planned.member,
        expected_live_sha256: planned.expectedLiveSha256,
        actual_live_sha256: live.memberSha256,
      });
    }
    if (mode === 'apply') {
      if (!HEX64.test(String(expectedLiveSha256 || ''))) {
        throw new GuardError(CODES.INVALID_MANIFEST, 'REPLACE apply requires expected_live_member_sha256 from a prior inspect');
      }
      if (String(expectedLiveSha256).toLowerCase() !== live.memberSha256) {
        throw new GuardError(CODES.SOURCE_RECONCILIATION_REQUIRED, 'live production member changed since inspect', {
          expected_live_sha256: expectedLiveSha256,
          actual_live_sha256: live.memberSha256,
        });
      }
    }
  }
  if (mode === 'apply' && planned.sqlBefore) {
    const prerequisite = plan?.sql_prerequisites?.[planned.sqlBefore];
    if (!prerequisite || prerequisite.verified_live !== true) {
      throw new GuardError(CODES.PRODUCTION_APPROVAL_REQUIRED, 'required production SQL is not recorded as verified live', { sql_before: planned.sqlBefore });
    }
  }
  if (mode === 'apply') {
    const absent = planned.imports.filter((name) => !live.members.includes(name));
    // Reviewed exemption (plan optional_imports): re-checked against the bytes being
    // deployed, so a planned member built by hand cannot skip the check either.
    const optional = Array.isArray(planned.optionalImports) ? planned.optionalImports : [];
    const exempt = absent.filter((name) => optional.includes(name));
    if (exempt.length) {
      const problems = optionalImportProblems(planned.member, planned.source, exempt, planned.imports);
      if (problems.length) {
        throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'member imports modules that are not in the live production ZIP yet', { member: planned.member, missing: absent, problems });
      }
    }
    const missing = absent.filter((name) => !exempt.includes(name));
    if (missing.length) {
      throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'member imports modules that are not in the live production ZIP yet', { member: planned.member, missing });
    }
    const index = plan.order.indexOf(planned.member);
    const pending = plan.order.slice(0, index)
      .filter((name) => live.memberHashes?.[name] !== plan.members[name].accepted_sha256);
    if (pending.length) {
      throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'apply plan members in order; earlier members are not yet the accepted bytes', { member: planned.member, pending });
    }
    const problems = linkProblems(planned.member, planned.source, live.sources || {});
    if (problems.length) {
      throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'member would not link against the live production modules', { member: planned.member, problems });
    }
  }
  return { state: 'READY' };
}

export function validateApplyInputs({ member, approval, stagingAcceptance }) {
  if (approval !== approvalPhrase(member)) {
    throw new GuardError(CODES.PRODUCTION_APPROVAL_REQUIRED, 'production apply requires the exact per-member approval phrase', { expected: approvalPhrase(member) });
  }
  if (!STAGING_ACCEPTANCE_RE.test(String(stagingAcceptance || ''))) {
    throw new GuardError(CODES.PRODUCTION_APPROVAL_REQUIRED, 'production apply requires a staging acceptance reference (a ChecksOps GitHub run or PR URL)');
  }
}

export function workflowIdentity(env = process.env) {
  const commit = String(env.GITHUB_SHA || '').trim();
  const branch = String(env.GITHUB_REF_NAME || '').trim();
  const actor = String(env.GITHUB_ACTOR || '').trim();
  const runId = String(env.GITHUB_RUN_ID || '').trim();
  if (!/^[0-9a-f]{40}$/.test(commit) || !branch || !actor || !runId) {
    throw new GuardError(CODES.ANONYMOUS_DEPLOYMENT, 'GitHub workflow identity is incomplete');
  }
  if (branch !== 'main') {
    throw new GuardError(CODES.UNRELATED_MUTATION, 'guarded production overlay may only run from main', { branch });
  }
  return { commit, branch, operator: actor, workstreamId: `github-production-overlay-${runId}` };
}

export async function inspectLive(member, { lambda = null, fetchImpl = fetch, loadSdk = (specifier) => import(specifier) } = {}) {
  let client = lambda;
  let command;
  if (!client) {
    const sdk = await loadSdk('@aws-sdk/client-lambda');
    client = new sdk.LambdaClient({ region: REGION });
    command = new sdk.GetFunctionCommand({ FunctionName: FUNCTION_NAME });
  } else {
    command = { operation: 'GetFunction', input: { FunctionName: FUNCTION_NAME } };
  }
  const live = await client.send(command);
  const codeSha256 = live?.Configuration?.CodeSha256 || null;
  const revisionId = live?.Configuration?.RevisionId || null;
  const location = live?.Code?.Location || null;
  if (!codeSha256 || !revisionId || !location) {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'live production Lambda fingerprint/code location is incomplete');
  }
  const response = await fetchImpl(location);
  if (!response?.ok) {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'failed to download current live production Lambda ZIP', { status: response?.status || null });
  }
  const files = readZipMembers(Buffer.from(await response.arrayBuffer()));
  const memberHashes = {};
  const sources = {};
  for (const [name, data] of Object.entries(files)) {
    memberHashes[name] = sha256(data);
    if (name.endsWith('.mjs') && !name.startsWith('node_modules/')) sources[name] = data.toString('utf8');
  }
  const present = Object.hasOwn(memberHashes, member);
  return {
    functionName: FUNCTION_NAME,
    codeSha256,
    revisionId,
    member,
    memberState: present ? 'PRESENT' : 'ABSENT',
    memberSha256: present ? memberHashes[member] : null,
    members: Object.keys(memberHashes),
    memberHashes,
    sources,
  };
}

const publicLive = ({ members, memberHashes, sources, ...rest }) => rest;

function appendGithubOutput(values, env = process.env) {
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(file, `${Object.entries(values).map(([key, value]) => `${key}=${String(value)}`).join('\n')}\n`);
}

export async function run(env = process.env, deps = {}) {
  const root = deps.root || repoRoot;
  const mode = String(env.CHECKSOPS_PRODUCTION_DEPLOY_MODE || 'inspect').trim();
  if (!['inspect', 'apply', 'verify'].includes(mode)) {
    throw new GuardError(CODES.INVALID_MANIFEST, 'mode must be inspect, apply or verify');
  }
  const plan = deps.plan || loadPlan(root);
  const planned = resolvePlannedMember(String(env.CHECKSOPS_PRODUCTION_OVERLAY_MEMBER || '').trim(), { root, plan });
  if (!planned.ok) throw new GuardError(planned.code, planned.message, planned.details || {});
  const member = planned.details;
  const identity = workflowIdentity(env);
  const live = await (deps.inspectLive || inspectLive)(member.member, deps);

  const summary = {
    live_code_sha256: live.codeSha256,
    live_revision_id: live.revisionId,
    live_member_state: live.memberState,
    live_member_sha256: live.memberSha256 || '',
    owned_member: member.member,
    planned_operation: member.operation,
    accepted_sha256: member.acceptedSha256,
  };

  if (mode === 'verify') {
    if (live.memberSha256 !== member.acceptedSha256) {
      throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'post-apply live member is not the accepted bytes', { expected: member.acceptedSha256, actual: live.memberSha256 });
    }
    appendGithubOutput({ ...summary, state: 'VERIFIED' }, env);
    return { ok: true, mode, identity, live: publicLive(live), state: 'VERIFIED', mutation: false };
  }

  const classified = classifyLive(member, live, {
    plan,
    mode,
    expectedLiveSha256: env.CHECKSOPS_EXPECTED_LIVE_MEMBER_SHA256,
  });
  appendGithubOutput({ ...summary, state: classified.state }, env);
  if (mode === 'inspect' || classified.state === 'ALREADY_ACCEPTED') {
    if (mode === 'apply') {
      throw new GuardError(CODES.UNRELATED_MUTATION, 'live member already equals the accepted bytes; nothing to apply', { member: member.member });
    }
    return { ok: true, mode, identity, live: publicLive(live), state: classified.state, mutation: false };
  }

  validateApplyInputs({
    member: member.member,
    approval: env.CHECKSOPS_PRODUCTION_APPROVAL,
    stagingAcceptance: env.CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE,
  });
  const fingerprint = { codeSha256: live.codeSha256, revisionId: live.revisionId };
  const approval = { approved: true, workstream_id: identity.workstreamId, phrase: approvalPhrase(member.member), approver: identity.operator };
  const stagingAcceptance = { ok: true, reference: String(env.CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE) };

  const lease = (deps.acquireLease || acquireLease)(root, {
    workstream_id: identity.workstreamId,
    component: FUNCTION_NAME,
    environment: 'production',
    commit: identity.commit,
    operator: identity.operator,
  });
  if (!lease.ok) throw new GuardError(lease.code, lease.message, lease.details || {});

  const issued = (deps.issueReceipt || issueReceiptWithSigner)(root, {
    workstream_id: identity.workstreamId,
    branch: identity.branch,
    commit: identity.commit,
    operator: identity.operator,
    target_environment: 'production',
    target_component: FUNCTION_NAME,
    deployment_type: 'lambda-overlay',
    owned_components: [member.member],
    owned_member_ops: {
      replace: member.operation === 'replace' ? [member.member] : [],
      add: member.operation === 'add' ? [member.member] : [],
    },
    preflight_live_fingerprint: fingerprint,
    production_fingerprint: fingerprint,
    immediately_before_fingerprint: fingerprint,
    staging_acceptance: stagingAcceptance,
    approval,
    lease: lease.details.lease,
  }, deps.signer || ((unsigned) => signReceiptWithKms(unsigned, { env })));
  if (!issued.ok) throw new GuardError(issued.code, issued.message, issued.details || {});

  const inputPath = path.join(root, '.deployment-guard', 'github-production-overlay-input.json');
  fs.mkdirSync(path.dirname(inputPath), { recursive: true });
  fs.writeFileSync(inputPath, JSON.stringify({
    workstream_id: identity.workstreamId,
    branch: identity.branch,
    commit: identity.commit,
    operator: identity.operator,
    target_environment: 'production',
    target_component: FUNCTION_NAME,
    function_name: FUNCTION_NAME,
    receipt_path: issued.details.file,
    member_sources: { [member.member]: member.sourceRelative },
    staging_acceptance: stagingAcceptance,
    approval,
  }, null, 2));

  appendGithubOutput({ overlay_input: inputPath, receipt_path: issued.details.file, workstream_id: identity.workstreamId }, env);
  return {
    ok: true,
    mode,
    identity,
    live: publicLive(live),
    state: classified.state,
    mutation: false,
    authorization: { lease: lease.details.lease, receiptFile: issued.details.file, overlayInput: inputPath },
  };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  run().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code || CODES.DEPLOYMENT_COLLISION,
      message: error?.message || String(error),
      details: error?.details || {},
    }, null, 2)}\n`);
    process.exitCode = 2;
  });
}
