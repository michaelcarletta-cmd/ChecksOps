#!/usr/bin/env node
/**
 * Invoke the Moov status catch-up inside the API Lambda (ops/moov-status-catch-up.md).
 *
 *   node scripts/deployment-guard/moov-status-catch-up.mjs --environment production \
 *     --phase plan --actor-application-user-id <platform owner uuid> [--limit 50] --out plan.json
 *
 *   node scripts/deployment-guard/moov-status-catch-up.mjs --environment production \
 *     --phase apply --actor-application-user-id <uuid> --plan plan.json \
 *     --approval-statement "<the owner's exact words>"   (or --approval-statement-b64 <base64>)
 *
 * The code runs in the Lambda because only the production API runtime holds the production
 * Moov keys (resolveBillingMoovContext refuses them anywhere else: production_credentials_refused).
 * This script only builds the direct-invocation event, calls lambda:InvokeFunction with the
 * caller's AWS identity, and prints the Lambda's JSON answer. apply takes its manifest hash,
 * transfer ids and limit from the plan file the owner reviewed; nothing else selects rows.
 * It reads no secret, connects to no database and calls no provider itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/cli.mjs';

export const CATCH_UP_FUNCTIONS = Object.freeze({
  production: 'checksops-production-prep-api',
  staging: 'checksops-staging-api',
});
const ALLOWED = new Set(['environment', 'phase', 'actor-application-user-id', 'limit', 'out', 'plan',
  'approval-statement', 'approval-statement-b64', 'region']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const refuse = (error, extra = {}) => ({ ok: false, error, ...extra });

/** The invocation event, or a refusal. Pure. */
export function buildCatchUpEvent(opts = {}, { readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const unknown = Object.keys(opts).filter((key) => !ALLOWED.has(key));
  if (unknown.length) return refuse('unknown_flags', { unknown });
  const functionName = CATCH_UP_FUNCTIONS[opts.environment];
  if (!functionName) return refuse('environment_must_be_production_or_staging');
  if (!UUID_RE.test(String(opts['actor-application-user-id'] || ''))) return refuse('actor_application_user_id_required');
  const event = {
    checksops_operator: 'moov-status-catch-up',
    rawPath: '/scheduled/moov-status-catch-up',
    requestContext: { http: { method: 'POST' } },
    phase: opts.phase,
    actor_application_user_id: String(opts['actor-application-user-id']).toLowerCase(),
  };
  if (opts.phase === 'plan') {
    if (opts.plan || opts['approval-statement'] || opts['approval-statement-b64']) return refuse('plan_takes_no_apply_flags');
    if (opts.limit !== undefined) event.limit = Number(opts.limit);
    return { ok: true, functionName, event };
  }
  if (opts.phase !== 'apply') return refuse('phase_must_be_plan_or_apply');
  if (opts.limit !== undefined) return refuse('apply_takes_the_limit_from_the_plan');
  if (Boolean(opts['approval-statement']) === Boolean(opts['approval-statement-b64'])) {
    return refuse('pass_exactly_one_approval_statement_flag');
  }
  const statement = opts['approval-statement-b64']
    ? Buffer.from(String(opts['approval-statement-b64']), 'base64').toString('utf8')
    : String(opts['approval-statement']);
  if (!statement.trim()) return refuse('approval_statement_empty');
  if (!opts.plan) return refuse('plan_file_required');
  let plan;
  try {
    plan = JSON.parse(readFile(path.resolve(String(opts.plan))));
  } catch {
    return refuse('plan_file_unreadable');
  }
  if (plan?.ok !== true || plan.phase !== 'plan' || plan.environment !== (opts.environment === 'staging' ? 'sandbox' : 'production')) {
    return refuse('plan_file_is_not_a_successful_plan_for_this_environment');
  }
  if (plan.truncated) return refuse('plan_was_truncated');
  if (!Array.isArray(plan.transfer_ids) || !plan.transfer_ids.length) return refuse('plan_has_nothing_to_apply');
  Object.assign(event, {
    limit: plan.manifest?.limit,
    approval_statement: statement,
    manifest_sha256: plan.manifest_sha256,
    transfer_ids: plan.transfer_ids,
  });
  return { ok: true, functionName, event };
}

export async function invokeCatchUp({ functionName, event, region = 'us-east-1' }, { loadSdk = () => import('@aws-sdk/client-lambda') } = {}) {
  const { LambdaClient, InvokeCommand } = await loadSdk();
  const client = new LambdaClient({ region });
  const res = await client.send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify(event)),
  }));
  const raw = Buffer.from(res.Payload || []).toString('utf8');
  if (res.FunctionError) return refuse('lambda_function_error', { function_error: res.FunctionError });
  let outer;
  try { outer = JSON.parse(raw); } catch { return refuse('lambda_answer_not_json'); }
  // index.mjs answers { statusCode, body } for the /scheduled branch.
  const body = typeof outer?.body === 'string' ? JSON.parse(outer.body) : outer;
  return body;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { opts, positional } = parseArgs(argv);
  if (positional.length) return { code: 1, result: refuse('positional_arguments_not_accepted') };
  const built = buildCatchUpEvent(opts, deps);
  if (!built.ok) return { code: 1, result: built };
  const result = await (deps.invoke || invokeCatchUp)({ ...built, region: opts.region || 'us-east-1' });
  if (opts.out) fs.writeFileSync(path.resolve(String(opts.out)), `${JSON.stringify(result, null, 2)}\n`);
  return { code: result?.ok ? 0 : 1, result };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const { code, result } = await main();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = code;
}
