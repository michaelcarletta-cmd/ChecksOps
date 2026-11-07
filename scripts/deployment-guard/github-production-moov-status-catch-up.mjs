#!/usr/bin/env node
/**
 * The step of .github/workflows/production-moov-status-catch-up.yml that invokes the Moov status
 * catch-up in the production API Lambda (ops/moov-status-catch-up.md), with the dedicated role
 * ChecksOpsGitHubProductionMoovStatusCatchUp (ops/deployment-guard/production-moov-status-catch-up/).
 *
 * plan   one read-only invocation; prints the plan JSON (counts, manifest_sha256, transfer_ids).
 * apply  only with the reviewed plan's manifest_sha256 and transfer_ids, the same limit, and the
 *        owner's phrase for that plan: "apply the Moov catch-up plan <manifest_sha256> in production".
 *        It plans again first and refuses, without an apply invocation, unless the fresh plan has
 *        exactly that manifest_sha256 and those transfer ids. The Lambda re-plans and checks again
 *        before it writes (catch_up_plan_changed).
 *
 * Inputs come only from the environment (the workflow passes them through env, never as shell
 * source). Event building and the invoke are scripts/deployment-guard/moov-status-catch-up.mjs;
 * this file adds no other AWS call. It reads no secret and prints only the Lambda's JSON answer,
 * which carries no secret, account number or hostname.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATCH_UP_FUNCTIONS, buildCatchUpEvent, invokeCatchUp } from './moov-status-catch-up.mjs';

export const ACCOUNT_ID = '806168576068';
export const REGION = 'us-east-1';
export const FUNCTION_NAME = 'checksops-production-prep-api';
export const FUNCTION_ARN = `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}`;
export const ROLE_NAME = 'ChecksOpsGitHubProductionMoovStatusCatchUp';
export const ROLE_ARN = `arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}`;
export const ROLE_ARN_VARIABLE = 'CHECKSOPS_PRODUCTION_MOOV_STATUS_CATCH_UP_ROLE_ARN';
export const WORKFLOW_FILE = '.github/workflows/production-moov-status-catch-up.yml';
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const applyPhrase = (manifestSha256) => `apply the Moov catch-up plan ${manifestSha256} in production`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const TRANSFER_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

const refuse = (error, extra = {}) => ({ ok: false, error, ...extra });

/** Comma, space or newline separated ids, sorted; null when empty, malformed or repeated. */
export function parseTransferIds(text) {
  const ids = String(text || '').split(/[\s,]+/).filter(Boolean);
  if (!ids.length || ids.length > MAX_LIMIT || ids.some((id) => !TRANSFER_ID_RE.test(id))) return null;
  if (new Set(ids).size !== ids.length) return null;
  return [...ids].sort();
}

/** The validated workflow inputs, or a refusal. Pure. */
export function validateInputs(env = {}) {
  const phase = env.CHECKSOPS_CATCH_UP_PHASE;
  if (phase !== 'plan' && phase !== 'apply') return refuse('phase_must_be_plan_or_apply');
  const actor = String(env.CHECKSOPS_CATCH_UP_ACTOR_APPLICATION_USER_ID || '');
  if (!UUID_RE.test(actor)) return refuse('actor_application_user_id_required');
  const limitText = String(env.CHECKSOPS_CATCH_UP_LIMIT ?? '').trim() || String(DEFAULT_LIMIT);
  if (!/^[1-9][0-9]{0,2}$/.test(limitText) || Number(limitText) > MAX_LIMIT) return refuse('limit_must_be_1_to_200');
  const limit = Number(limitText);
  const phrase = String(env.CHECKSOPS_CATCH_UP_APPROVAL_PHRASE || '');
  const manifestSha256 = String(env.CHECKSOPS_CATCH_UP_MANIFEST_SHA256 || '');
  const idsText = String(env.CHECKSOPS_CATCH_UP_TRANSFER_IDS || '');
  if (phase === 'plan') {
    if (phrase || manifestSha256 || idsText) return refuse('plan_takes_no_approval_phrase_manifest_or_transfer_ids');
    return { ok: true, phase, actor: actor.toLowerCase(), limit };
  }
  if (!SHA256_RE.test(manifestSha256)) return refuse('apply_requires_manifest_sha256_from_the_reviewed_plan');
  const transferIds = parseTransferIds(idsText);
  if (!transferIds) return refuse('apply_requires_transfer_ids_from_the_reviewed_plan');
  if (phrase !== applyPhrase(manifestSha256)) return refuse('approval_phrase_must_be_exact', { expected: applyPhrase(manifestSha256) });
  return { ok: true, phase, actor: actor.toLowerCase(), limit, manifestSha256, transferIds, statement: phrase };
}

/** A fresh plan must be the reviewed one: same manifest hash, same ids, complete. Pure. */
export function compareWithReviewedPlan(plan, { manifestSha256, transferIds }) {
  if (plan?.ok !== true || plan.phase !== 'plan' || plan.environment !== 'production') return refuse('fresh_plan_failed');
  if (plan.truncated) return refuse('fresh_plan_truncated');
  if (plan.moov_unavailable) return refuse('fresh_plan_moov_unavailable');
  if (plan.manifest_sha256 !== manifestSha256) {
    return refuse('catch_up_plan_changed', { reviewed_manifest_sha256: manifestSha256, fresh_manifest_sha256: plan.manifest_sha256 ?? null });
  }
  const fresh = Array.isArray(plan.transfer_ids) ? [...plan.transfer_ids].sort() : [];
  if (JSON.stringify(fresh) !== JSON.stringify(transferIds)) return refuse('transfer_ids_differ_from_reviewed_plan');
  return { ok: true };
}

const productionOnly = (built) => (built.ok && built.functionName !== FUNCTION_NAME
  ? refuse('not_the_production_api_function')
  : built);

/**
 * Validate, invoke, and return { code, result }. deps.invoke replaces the Lambda call in tests.
 * apply: plan, compare, then apply from that fresh plan (never from typed values alone).
 */
export async function run(env = process.env, deps = {}) {
  const invoke = deps.invoke || invokeCatchUp;
  const inputs = validateInputs(env);
  if (!inputs.ok) return { code: 2, result: inputs };
  const planBuilt = productionOnly(buildCatchUpEvent({
    environment: 'production',
    phase: 'plan',
    'actor-application-user-id': inputs.actor,
    limit: String(inputs.limit),
  }));
  if (!planBuilt.ok) return { code: 2, result: planBuilt };
  const plan = await invoke({ functionName: planBuilt.functionName, event: planBuilt.event, region: REGION });
  if (inputs.phase === 'plan') return { code: plan?.ok ? 0 : 1, result: plan };

  const same = compareWithReviewedPlan(plan, inputs);
  if (!same.ok) return { code: 1, result: { ...same, phase: 'apply', apply_invoked: false, fresh_plan: plan } };
  const applyBuilt = productionOnly(buildCatchUpEvent({
    environment: 'production',
    phase: 'apply',
    'actor-application-user-id': inputs.actor,
    plan: 'fresh-plan.json',
    'approval-statement-b64': Buffer.from(inputs.statement, 'utf8').toString('base64'),
  }, { readFile: () => JSON.stringify(plan) }));
  if (!applyBuilt.ok) return { code: 2, result: { ...applyBuilt, apply_invoked: false } };
  if (applyBuilt.event.manifest_sha256 !== inputs.manifestSha256
      || applyBuilt.event.approval_statement !== inputs.statement
      || applyBuilt.event.limit !== inputs.limit) {
    return { code: 2, result: refuse('apply_event_differs_from_inputs', { apply_invoked: false }) };
  }
  const applied = await invoke({ functionName: applyBuilt.functionName, event: applyBuilt.event, region: REGION });
  return { code: applied?.ok ? 0 : 1, result: { fresh_plan: plan, apply: applied } };
}

export async function main(env = process.env, deps = {}) {
  const { code, result } = await run(env, deps);
  const json = JSON.stringify(result, null, 2);
  process.stdout.write(`${json}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `### Moov status catch-up (${env.CHECKSOPS_CATCH_UP_PHASE})\n\n\`\`\`json\n${json}\n\`\`\`\n`);
  }
  return code;
}

// Guard against a caller swapping the production function name in the shared CLI.
if (CATCH_UP_FUNCTIONS.production !== FUNCTION_NAME) throw new Error('catch_up_production_function_mismatch');

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = await main();
