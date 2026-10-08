#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZipMembers } from './lib/zip-members.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REGION = 'us-east-1';
const SPA_ORIGIN = 'https://checksops.com';
const SPA_BUCKET = 'checksops-production-frontend-806168576068';
const DISTRIBUTION_ID = 'E1B0ZWWO5559U5';
const API_ID = 'kiqojucc02';
const API_STAGE = 'prep';
const API_FUNCTION = 'checksops-production-prep-api';
const API_TARGET_ID = 'checksops-production-prep-api';
const PRODUCTION_SPA_TARGET_ID = 'production-spa';
const PRODUCTION_API_GATEWAY_TARGET_ID = 'production-http-api';
const PRODUCTION_TARGETS_PATH = 'ops/deployment-guard/protected-targets.json';
const DB_HOST = 'db.nbcqwpysqgyxrrbgtmkw.supabase.co';
const DB_USER = 'checksops_prod_inspector';
const DB_SECRET_ENV = 'CHECKSOPS_PRODUCTION_INSPECT_DATABASE_URL';
const MIGRATION_PATH = 'supabase/migrations/20261007193200_skip_claim_ledger_event_for_endorsement_stage.sql';
const LAMBDA_SOURCE_FILES = Object.freeze([
  'claim-settlement-rpc.mjs',
  'data.mjs',
  'workflow.mjs',
  'workflow-transitions.mjs',
  'workflow-flags.mjs',
  'write-allowlist.mjs',
]);
const FLAG_NAMES = Object.freeze([
  'AWS_WRITES_ENABLED',
  'AWS_APPLICATION_WORKFLOW_WRITES_ENABLED',
  'AWS_CHECK_WORKFLOW_WRITES_ENABLED',
  'AWS_STORAGE_WRITES_ENABLED',
  'AWS_PROVIDER_EXECUTION_ENABLED',
  'AWS_PROVIDER_LIVE_READS_ENABLED',
  'AWS_FINANCIAL_PERMISSIONS_ACTIVATED',
]);

export const DATABASE_READ_ONLY_SQL = Object.freeze({
  identity: `
    SELECT current_user AS role_name,
           current_database() AS database_name,
           current_setting('transaction_read_only') AS transaction_read_only,
           r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
           has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_in_database,
           has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_in_public
      FROM pg_roles r
     WHERE r.rolname = current_user
  `.trim(),
  micr: `
    SELECT
           CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'checksops')
                 AND EXISTS (
                   SELECT 1 FROM pg_attribute a
                   JOIN pg_class c ON c.oid = a.attrelid
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relname = 'check_intake_items'
                      AND a.attname = 'routing_number' AND a.attnum > 0 AND NOT a.attisdropped
                 )
               THEN has_column_privilege('checksops', 'public.check_intake_items', 'routing_number', 'UPDATE')
               ELSE false END AS checksops_routing_update,
           CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'checksops')
                 AND EXISTS (
                   SELECT 1 FROM pg_attribute a
                   JOIN pg_class c ON c.oid = a.attrelid
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relname = 'check_intake_items'
                      AND a.attname = 'account_number' AND a.attnum > 0 AND NOT a.attisdropped
                 )
               THEN has_column_privilege('checksops', 'public.check_intake_items', 'account_number', 'UPDATE')
               ELSE false END AS checksops_account_update,
           EXISTS (
             SELECT 1 FROM pg_attribute a
             JOIN pg_class c ON c.oid = a.attrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             CROSS JOIN LATERAL aclexplode(a.attacl) acl
             JOIN pg_roles gr ON gr.oid = acl.grantee
              WHERE n.nspname = 'public' AND c.relname = 'check_intake_items'
                AND a.attname = 'routing_number' AND a.attnum > 0 AND NOT a.attisdropped
                AND gr.rolname = 'checksops' AND acl.privilege_type = 'UPDATE'
           ) AS explicit_routing_column_grant,
           EXISTS (
             SELECT 1 FROM pg_attribute a
             JOIN pg_class c ON c.oid = a.attrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             CROSS JOIN LATERAL aclexplode(a.attacl) acl
             JOIN pg_roles gr ON gr.oid = acl.grantee
              WHERE n.nspname = 'public' AND c.relname = 'check_intake_items'
                AND a.attname = 'account_number' AND a.attnum > 0 AND NOT a.attisdropped
                AND gr.rolname = 'checksops' AND acl.privilege_type = 'UPDATE'
           ) AS explicit_account_column_grant,
           CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
                  AND EXISTS (
                    SELECT 1 FROM pg_attribute a
                    JOIN pg_class c ON c.oid = a.attrelid
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = 'public' AND c.relname = 'check_intake_items'
                       AND a.attname = 'routing_number' AND a.attnum > 0 AND NOT a.attisdropped
                  )
                THEN has_column_privilege('authenticated', 'public.check_intake_items', 'routing_number', 'UPDATE')
                ELSE false END AS authenticated_routing_update,
           CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
                  AND EXISTS (
                    SELECT 1 FROM pg_attribute a
                    JOIN pg_class c ON c.oid = a.attrelid
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = 'public' AND c.relname = 'check_intake_items'
                       AND a.attname = 'account_number' AND a.attnum > 0 AND NOT a.attisdropped
                  )
                THEN has_column_privilege('authenticated', 'public.check_intake_items', 'account_number', 'UPDATE')
                ELSE false END AS authenticated_account_update,
           CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
                  AND EXISTS (
                    SELECT 1 FROM pg_attribute a
                    JOIN pg_class c ON c.oid = a.attrelid
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = 'public' AND c.relname = 'check_intake_items'
                       AND a.attname = 'routing_number' AND a.attnum > 0 AND NOT a.attisdropped
                  )
                THEN has_column_privilege('anon', 'public.check_intake_items', 'routing_number', 'UPDATE')
                ELSE false END AS anon_routing_update,
           CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
                  AND EXISTS (
                    SELECT 1 FROM pg_attribute a
                    JOIN pg_class c ON c.oid = a.attrelid
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = 'public' AND c.relname = 'check_intake_items'
                       AND a.attname = 'account_number' AND a.attnum > 0 AND NOT a.attisdropped
                  )
                THEN has_column_privilege('anon', 'public.check_intake_items', 'account_number', 'UPDATE')
                ELSE false END AS anon_account_update
  `.trim(),
  settlement: `
    SELECT p.oid IS NOT NULL AS exists,
           pg_get_functiondef(p.oid) AS definition,
           pg_get_userbyid(p.proowner) AS owner,
           p.prosecdef AS security_definer,
           p.proconfig AS settings,
           CASE WHEN p.oid IS NOT NULL THEN EXISTS (
             SELECT 1
               FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
              WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
           ) ELSE false END AS public_execute,
           CASE WHEN p.oid IS NOT NULL
                  AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'checksops')
                THEN has_function_privilege('checksops', p.oid, 'EXECUTE') ELSE false END AS checksops_execute,
           CASE WHEN p.oid IS NOT NULL
                  AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
                THEN has_function_privilege('authenticated', p.oid, 'EXECUTE') ELSE false END AS authenticated_execute,
           CASE WHEN p.oid IS NOT NULL
                  AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
                THEN has_function_privilege('anon', p.oid, 'EXECUTE') ELSE false END AS anon_execute
      FROM (SELECT to_regprocedure('public.save_claim_settlement_breakdown(uuid,uuid,jsonb)') AS oid) f
      LEFT JOIN pg_proc p ON p.oid = f.oid
  `.trim(),
  endorsement: `
    SELECT p.oid IS NOT NULL AS function_exists,
           pg_get_functiondef(p.oid) AS definition,
           p.prosrc AS body,
           pg_get_userbyid(p.proowner) AS owner,
           p.prosecdef AS security_definer,
           p.proconfig AS settings,
           EXISTS (
             SELECT 1
               FROM pg_trigger t
               JOIN pg_class c ON c.oid = t.tgrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
               JOIN pg_attribute status_column
                 ON status_column.attrelid = c.oid
                AND status_column.attname = 'status'
                AND status_column.attnum > 0
                AND NOT status_column.attisdropped
              WHERE n.nspname = 'public'
                AND c.relname = 'check_intake_items'
                AND t.tgfoid = p.oid
                AND t.tgname = 'trg_sync_homeowner_ledger_upd'
                AND NOT t.tgisinternal
                AND t.tgenabled IN ('O', 'A')
                AND (t.tgtype & 1) = 1
                AND (t.tgtype & 2) = 0
                AND (t.tgtype & 16) = 16
                AND status_column.attnum = ANY(t.tgattr)
           ) AS enabled_status_update_trigger,
           (
             SELECT pg_get_triggerdef(t.oid)
               FROM pg_trigger t
               JOIN pg_class c ON c.oid = t.tgrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public'
                AND c.relname = 'check_intake_items'
                AND t.tgname = 'trg_sync_homeowner_ledger_upd'
                AND t.tgfoid = p.oid
                AND NOT t.tgisinternal
              LIMIT 1
           ) AS status_update_trigger_definition
      FROM (SELECT to_regprocedure('public.sync_homeowner_ledger_from_check()') AS oid) f
      LEFT JOIN pg_proc p ON p.oid = f.oid
  `.trim(),
  settlement_write_privileges: `
    SELECT CASE WHEN to_regclass('public.claim_settlements') IS NOT NULL
                  AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'checksops')
                THEN has_table_privilege('checksops', 'public.claim_settlements', 'INSERT') ELSE false END AS can_insert,
           CASE WHEN to_regclass('public.claim_settlements') IS NOT NULL
                  AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'checksops')
                THEN has_table_privilege('checksops', 'public.claim_settlements', 'UPDATE') ELSE false END AS can_update,
           CASE WHEN to_regclass('public.claim_settlements') IS NOT NULL
                  AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'checksops')
                THEN has_table_privilege('checksops', 'public.claim_settlements', 'DELETE') ELSE false END AS can_delete,
           CASE WHEN to_regclass('public.claim_settlements') IS NOT NULL
                  AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'checksops')
                THEN has_table_privilege('checksops', 'public.claim_settlements', 'TRUNCATE') ELSE false END AS can_truncate
  `.trim(),
});

export const READ_ONLY_AWS_OPERATIONS = Object.freeze([
  'lambda.get-function',
  'lambda.get-function-configuration',
  'lambda.list-aliases',
  'apigatewayv2.get-api',
  'apigatewayv2.get-stages',
  'apigatewayv2.get-routes',
  'apigatewayv2.get-integrations',
  'cloudfront.get-distribution',
  's3api.head-object',
]);
export const REQUIRED_AWS_READ_PERMISSIONS = Object.freeze({
  'lambda.get-function': 'lambda:GetFunction',
  'lambda.get-function-configuration': 'lambda:GetFunctionConfiguration',
  'lambda.list-aliases': 'lambda:ListAliases',
  'apigatewayv2.get-api': 'apigateway:GET',
  'apigatewayv2.get-stages': 'apigateway:GET',
  'apigatewayv2.get-routes': 'apigateway:GET',
  'apigatewayv2.get-integrations': 'apigateway:GET',
  'cloudfront.get-distribution': 'cloudfront:GetDistribution',
  's3api.head-object': 's3:GetObject',
});
const ALLOWED_INSPECTION_SQL = new Set(Object.values(DATABASE_READ_ONLY_SQL));

export const ACCEPTANCE_REQUIRED_BEFORE_PROMOTION = Object.freeze([
  'Claim Ledger save persists and refreshes without writes_disabled or historical 42501.',
  'Generic claim_settlements writes remain denied; unauthorized and cross-tenant requests remain denied.',
  'Claim-linked Review to Endorsing succeeds without requiring/writing settlement amounts and preserves existing ledger values.',
  'Verified OCR MICR routing/account values persist.',
  'Delete Check, Signature Requests, tenant isolation, and deposited/final-state protections remain intact.',
  'Payee and issue-date extraction are not considered repaired without separate evidence.',
]);

const SAFE_AWS_ENV = Object.freeze([
  'PATH', 'HOME', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
]);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bool = (value) => value === true;

export function extractBundlePath(html) {
  const matches = [...String(html || '').matchAll(/(?:src=["']|)(\/assets\/index-[A-Za-z0-9_-]+\.js)(?:["']|)/g)];
  const paths = [...new Set(matches.map((match) => match[1]))];
  return paths.length === 1 ? paths[0] : null;
}

export function normalizeSqlBody(body) {
  const source = String(body || '');
  let normalized = '';
  let index = 0;
  let pendingSpace = false;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      pendingSpace = normalized.length > 0;
      index += 1;
      continue;
    }
    if (pendingSpace) {
      normalized += ' ';
      pendingSpace = false;
    }

    const character = source[index];
    if (character === "'" || character === '"') {
      const escapeString = character === "'"
        && /[Ee]$/.test(source.slice(0, index))
        && (index < 2 || !/[\w$]/.test(source[index - 2]));
      let end = index + 1;
      while (end < source.length) {
        if (escapeString && source[end] === '\\') {
          end += 2;
        } else if (source[end] === character && source[end + 1] === character) {
          end += 2;
        } else if (source[end] === character) {
          end += 1;
          break;
        } else {
          end += 1;
        }
      }
      normalized += source.slice(index, end);
      index = end;
      continue;
    }

    if (character === '$') {
      const tag = source.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (tag) {
        const close = source.indexOf(tag, index + tag.length);
        const end = close === -1 ? source.length : close + tag.length;
        normalized += source.slice(index, end);
        index = end;
        continue;
      }
    }

    normalized += character;
    index += 1;
  }
  return normalized.trim();
}

export function sqlFunctionBody(sql) {
  return String(sql || '').match(/\bAS\s+\$\$([\s\S]*?)\$\$\s*;/i)?.[1]?.trim() || null;
}

export function normalizeFlags(environment = {}) {
  return Object.fromEntries(FLAG_NAMES.map((name) => [
    name,
    environment[name] === 'true' ? 'true' : environment[name] === 'false' ? 'false' : 'unset',
  ]));
}

export function compareSpaToLock(live, lock, proof) {
  const lockedEntry = lock?.artifact?.name || null;
  const lockedBundleSha = lock?.deployment_fingerprint?.spa_sha256 || null;
  const proofEntry = proof?.entry || null;
  const proofBundleSha = proof?.bundle_sha256 || null;
  const lockMatches = live?.entry === lockedEntry && live?.bundle_sha256 === lockedBundleSha;
  const proofMatchesLock = proofEntry === lockedEntry && proofBundleSha === lockedBundleSha;
  return {
    lock_matches_live: lockMatches,
    proof_matches_lock: proofMatchesLock,
    drift: [
      ...(!lockMatches ? ['live SPA differs from accepted production SPA lock'] : []),
      ...(!proofMatchesLock ? ['linked SPA proof disagrees with the current production lock'] : []),
    ],
  };
}

export function buildMinimumDelta(report) {
  const delta = [];
  const unknown = [];
  if (report.spa.status !== 'verified') unknown.push('production SPA');
  else if (!report.spa.comparison.lock_matches_live
    || report.spa.repairs.claim_settlement_rpc_client_present !== true) {
    delta.push('Compose and promote a fresh SPA containing the approved repairs through the production-spa guard; do not restore a historical bundle.');
  }
  if (report.api_lambda.status !== 'verified') unknown.push('production API/Lambda');
  else {
    if (report.api_lambda.repairs.claim_settlement_rpc !== true
      || report.api_lambda.repairs.review_to_endorsing_backend !== true
      || report.api_lambda.repairs.generic_claim_settlements_writes_blocked !== true) {
      delta.push('Use a fresh live-ZIP, member-preserving guarded Lambda overlay for only the missing #762/#772 runtime members.');
    }
    if (report.api_lambda.flags.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED !== 'true') {
      delta.push('Separately review and authorize the application-workflow write-flag configuration; the Lambda overlay does not change configuration.');
    }
  }
  if (report.database.status !== 'verified') unknown.push('production database');
  else {
    if (report.database.sql52?.intended_state !== true) {
      delta.push('Apply SQL52 only if the live column grants differ from the intended least-privilege grant.');
    }
    if (report.database.sql53?.intended_state !== true) {
      delta.push('Install/correct SQL53 only if the live function or execute privileges differ from the reviewed definition.');
    }
    if (report.database.endorsement_trigger?.intended_state !== true) {
      delta.push('Install/correct the endorsement-stage trigger function only if live behavior differs from migration 20261007193200.');
    }
  }
  return { status: unknown.length ? 'incomplete' : 'complete', unknown, mutations: delta };
}

export function verifyInspectionWorkflowIdentity(env, headSha, fetchedMainSha) {
  if (env.GITHUB_ACTIONS !== 'true'
    || env.GITHUB_REF !== 'refs/heads/main'
    || !/^[0-9a-f]{40}$/.test(String(env.GITHUB_SHA || ''))
    || env.GITHUB_SHA !== headSha
    || env.GITHUB_SHA !== fetchedMainSha) {
    throw new Error('Inspection requires the exact current origin/main workflow commit.');
  }
  return env.GITHUB_SHA;
}

export function validateProductionTargetMetadata(metadata) {
  const production = metadata?.environments?.production;
  const targets = Array.isArray(metadata?.targets) ? metadata.targets : [];
  const lambda = targets.find((target) => target.id === API_TARGET_ID);
  const spa = targets.find((target) => target.id === PRODUCTION_SPA_TARGET_ID);
  const api = targets.find((target) => target.id === PRODUCTION_API_GATEWAY_TARGET_ID);
  if (metadata?.fail_closed !== true
    || production?.requires_lease !== true
    || production?.requires_explicit_approval !== true
    || production?.requires_staging_acceptance !== true
    || production?.requires_second_fingerprint_before_write !== true
    || lambda?.kind !== 'lambda'
    || lambda?.environment !== 'production'
    || lambda?.function_name !== API_FUNCTION
    || lambda?.region !== REGION
    || lambda?.overlay_required !== true
    || lambda?.full_replace_forbidden !== true
    || lambda?.revision_id_cas !== true
    || spa?.kind !== 'spa'
    || spa?.environment !== 'production'
    || spa?.host !== SPA_ORIGIN
    || spa?.s3_bucket !== SPA_BUCKET
    || spa?.cloudfront_id !== DISTRIBUTION_ID
    || spa?.index_toctou !== true
    || spa?.s3_sync_delete_forbidden !== true
    || api?.kind !== 'apigateway'
    || api?.environment !== 'production'
    || api?.api_id !== API_ID) {
    throw new Error('Production inspection targets do not match accepted fail-closed guard metadata.');
  }
  return true;
}

export function validateReadOnlyInspectionQuery(query) {
  if (typeof query !== 'string' || !ALLOWED_INSPECTION_SQL.has(query)) {
    throw new Error('Refusing SQL outside the fixed production catalog SELECT allowlist.');
  }
  return query;
}

export function safeInspectionFailure(error) {
  const message = String(error?.message || '');
  if (/^Required production read permission denied: [A-Za-z0-9:]+$/.test(message)) {
    return message;
  }
  return 'Live production inspection unavailable.';
}

export function classifyAwsReadFailure(operation, error) {
  const permission = REQUIRED_AWS_READ_PERMISSIONS[operation];
  if (!permission) throw new Error('Cannot classify a non-allowlisted AWS operation.');
  const detail = `${error?.message || ''}\n${error?.stderr || ''}`;
  if (/AccessDenied|UnauthorizedOperation|not authorized|is not authorized/i.test(detail)) {
    return `Required production read permission denied: ${permission}`;
  }
  return `Production read operation failed: ${operation}`;
}

function awsEnv(env) {
  return {
    ...Object.fromEntries(
      SAFE_AWS_ENV.filter((key) => Object.hasOwn(env, key))
      .map((key) => [key, env[key]])),
    AWS_CONFIG_FILE: '/dev/null',
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    AWS_EC2_METADATA_DISABLED: 'true',
  };
}

function assertInputKeys(input, allowedKeys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !allowedKeys.includes(key))) {
    throw new Error('Refusing unexpected production inspection command parameters.');
  }
}

export function commandFor(operation, input = {}) {
  switch (operation) {
    case 'lambda.get-function':
      assertInputKeys(input, ['qualifier']);
      return ['lambda', 'get-function', '--function-name', API_FUNCTION,
        ...(input.qualifier ? ['--qualifier', safeQualifier(input.qualifier)] : [])];
    case 'lambda.get-function-configuration':
      assertInputKeys(input, ['qualifier']);
      return ['lambda', 'get-function-configuration', '--function-name', API_FUNCTION,
        ...(input.qualifier ? ['--qualifier', safeQualifier(input.qualifier)] : [])];
    case 'lambda.list-aliases':
      assertInputKeys(input, []);
      return ['lambda', 'list-aliases', '--function-name', API_FUNCTION];
    case 'apigatewayv2.get-api':
      assertInputKeys(input, []);
      return ['apigatewayv2', 'get-api', '--api-id', API_ID];
    case 'apigatewayv2.get-stages':
      assertInputKeys(input, []);
      return ['apigatewayv2', 'get-stages', '--api-id', API_ID];
    case 'apigatewayv2.get-routes':
      assertInputKeys(input, []);
      return ['apigatewayv2', 'get-routes', '--api-id', API_ID];
    case 'apigatewayv2.get-integrations':
      assertInputKeys(input, []);
      return ['apigatewayv2', 'get-integrations', '--api-id', API_ID];
    case 'cloudfront.get-distribution':
      assertInputKeys(input, []);
      return ['cloudfront', 'get-distribution', '--id', DISTRIBUTION_ID];
    case 's3api.head-object':
      assertInputKeys(input, ['key']);
      if (typeof input.key !== 'string'
        || !/^index\.html$|^assets\/index-[A-Za-z0-9_-]+\.js$/.test(input.key)) {
        throw new Error('Refusing an unexpected production SPA object key.');
      }
      return ['s3api', 'head-object', '--bucket', SPA_BUCKET, '--key', input.key];
    default:
      throw new Error('Refusing an AWS operation not allowlisted for read-only inspection.');
  }
}

function runAwsJson(operation, input = {}, env = process.env) {
  const args = commandFor(operation, input);
  let output;
  try {
    output = execFileSync('aws', ['--no-cli-pager', '--region', REGION, '--output', 'json', ...args], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env: awsEnv(env),
    });
  } catch (error) {
    throw new Error(classifyAwsReadFailure(operation, error));
  }
  return JSON.parse(output || '{}');
}

async function fetchBytes(url, fetchImpl, maximumBytes) {
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok || new URL(response.url || url).origin !== SPA_ORIGIN) {
    throw new Error('Production SPA HTTP read failed or changed origin.');
  }
  const length = Number(response.headers.get('content-length') || 0);
  if (length > maximumBytes) throw new Error('Production artifact exceeds the inspection size limit.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximumBytes) throw new Error('Production artifact exceeds the inspection size limit.');
  return { bytes, headers: response.headers };
}

function readSpaLock(root) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'ops/release-locks/locked-components.json'), 'utf8'));
  const proofText = fs.readFileSync(path.join(root, 'ops/release-locks/proof/production-spa-baseline.md'), 'utf8');
  const entry = proofText.match(/^\|\s*Entry\s*\|\s*`([^`]+)`/m)?.[1] || null;
  const bundleSha = proofText.match(/^\|\s*Entry JS SHA256\s*\|\s*`([0-9a-f]{64})`/m)?.[1] || null;
  return {
    lock: lock.components?.['production-spa'] || null,
    proof: { entry, bundle_sha256: bundleSha },
  };
}

async function inspectSpa({ root, env, fetchImpl, awsJson }) {
  const indexResponse = await fetchBytes(`${SPA_ORIGIN}/index.html`, fetchImpl, 4 * 1024 * 1024);
  const html = indexResponse.bytes.toString('utf8');
  const entry = extractBundlePath(html);
  if (!entry) throw new Error('Production index did not contain exactly one recognized JS entry.');
  const bundleResponse = await fetchBytes(new URL(entry, SPA_ORIGIN).toString(), fetchImpl, 100 * 1024 * 1024);
  const bundleText = bundleResponse.bytes.toString('utf8');
  const indexHead = awsJson('s3api.head-object', { key: 'index.html' }, env);
  const bundleHead = awsJson('s3api.head-object', { key: entry.slice(1) }, env);
  const distributionResponse = awsJson('cloudfront.get-distribution', {}, env);
  const distribution = distributionResponse.Distribution || {};
  const { lock, proof } = readSpaLock(root);
  const live = {
    entry,
    index_sha256: sha256(indexResponse.bytes),
    bundle_sha256: sha256(bundleResponse.bytes),
    index_etag: String(indexHead.ETag || '').replaceAll('"', ''),
    index_version_id: indexHead.VersionId || null,
    index_last_modified: indexHead.LastModified || null,
    bundle_etag: String(bundleHead.ETag || '').replaceAll('"', ''),
    bundle_version_id: bundleHead.VersionId || null,
    distribution: {
      id: DISTRIBUTION_ID,
      domain_name: distribution.DomainName || null,
      aliases: distribution.DistributionConfig?.Aliases?.Items || [],
      status: distribution.Status || null,
      etag: distributionResponse.ETag || null,
      last_modified: distribution.LastModifiedTime || null,
      cloudfront_request_id: indexResponse.headers.get('x-amz-cf-id'),
      cloudfront_cache: indexResponse.headers.get('x-cache'),
    },
  };
  const distributionMatchesHost = live.distribution.aliases.includes('checksops.com')
    && live.distribution.status === 'Deployed'
    && Boolean(live.distribution.etag)
    && Boolean(live.distribution.domain_name);
  const comparison = compareSpaToLock(live, lock, proof);
  if (!distributionMatchesHost) comparison.drift.push('The locked CloudFront distribution is not deployed with the checksops.com alias.');
  return {
    status: 'verified',
    live,
    repairs: {
      claim_settlement_rpc_client_present: bundleText.includes('save_claim_settlement_breakdown'),
    },
    comparison: {
      ...comparison,
      distribution_matches_host: distributionMatchesHost,
    },
    proof_reference: proof,
  };
}

function safeQualifier(value) {
  if (!value) return null;
  if (!/^(?:\$LATEST|[0-9]+|[A-Za-z0-9_-]{1,128})$/.test(value)) {
    throw new Error('Production API integration returned an unexpected Lambda qualifier.');
  }
  return value;
}

export function validateLambdaCodeLocation(location) {
  const url = new URL(location);
  if (url.protocol !== 'https:' || url.username || url.password
    || url.hostname !== 'awslambda-us-east-1-tasks.s3.us-east-1.amazonaws.com') {
    throw new Error('Production Lambda code location is not a trusted AWS S3 download URL.');
  }
  return url.toString();
}

function integrationsForFunction(integrations, routes) {
  const routeIntegrationIds = new Set((routes || [])
    .map((route) => String(route.Target || '').match(/^integrations\/([A-Za-z0-9_-]+)$/)?.[1])
    .filter(Boolean));
  return (integrations || [])
    .filter((item) => routeIntegrationIds.has(item.IntegrationId))
    .flatMap((item) => {
    const uri = String(item.IntegrationUri || '');
    const match = uri.match(/function:checksops-production-prep-api(?::([^/]+))?\/invocations$/);
    return match ? [{ id: item.IntegrationId || null, uri, qualifier: safeQualifier(match[1] || null) }] : [];
  });
}

async function inspectLambda({ root, env, fetchImpl, awsJson }) {
  const [api, stages, routes, integrations, aliases] = await Promise.all([
    awsJson('apigatewayv2.get-api', {}, env),
    awsJson('apigatewayv2.get-stages', {}, env),
    awsJson('apigatewayv2.get-routes', {}, env),
    awsJson('apigatewayv2.get-integrations', {}, env),
    awsJson('lambda.list-aliases', {}, env),
  ]);
  const integrationRefs = integrationsForFunction(integrations.Items, routes.Items);
  const selected = integrationRefs[0] || null;
  if (!selected || integrationRefs.some((item) => item.qualifier !== selected.qualifier)) {
    throw new Error('Production API routes do not resolve to one expected Lambda version.');
  }
  const alias = selected?.qualifier
    ? (aliases.Aliases || []).find((candidate) => candidate.Name === selected.qualifier)
    : null;
  const qualifier = selected?.qualifier
    ? (alias?.FunctionVersion || selected.qualifier)
    : undefined;
  const [functionResponse, configuration] = await Promise.all([
    awsJson('lambda.get-function', { qualifier }, env),
    awsJson('lambda.get-function-configuration', { qualifier }, env),
  ]);
  const location = functionResponse.Code?.Location;
  if (!location) throw new Error('Production Lambda code location is unavailable.');
  const zipResponse = await fetchImpl(validateLambdaCodeLocation(location), {
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (!zipResponse.ok) throw new Error('Production Lambda package download failed.');
  const zip = Buffer.from(await zipResponse.arrayBuffer());
  if (zip.length > 100 * 1024 * 1024) throw new Error('Production Lambda package exceeds the inspection size limit.');
  const members = readZipMembers(zip);
  const memberHashes = Object.fromEntries(LAMBDA_SOURCE_FILES.map((name) => {
    const contents = members[name] || members[`aws/functions/api/${name}`] || null;
    return [name, contents ? sha256(contents) : null];
  }));
  const sourceHashes = Object.fromEntries(LAMBDA_SOURCE_FILES.map((name) => [
    name,
    sha256(fs.readFileSync(path.join(root, 'aws/functions/api', name))),
  ]));
  const memberMatches = Object.fromEntries(LAMBDA_SOURCE_FILES.map((name) => [
    name,
    memberHashes[name] !== null && memberHashes[name] === sourceHashes[name],
  ]));
  const genericWriteAllowlist = members['write-allowlist.mjs']?.toString('utf8') || '';
  const genericClaimSettlementWritesBlocked = memberMatches['write-allowlist.mjs']
    && !/\bclaim_settlements\b/.test(genericWriteAllowlist);
  const flags = normalizeFlags(configuration.Environment?.Variables || {});
  const requestedStage = (stages.Items || []).find((stage) => stage.StageName === API_STAGE) || null;
  const routeTargets = (routes.Items || []).map((route) => ({
    key: route.RouteKey || null,
    target: route.Target || null,
  }));
  const integrationTargetsAllResolve = integrationRefs.length > 0
    && routeTargets.length > 0
    && routeTargets.every(({ target }) => {
      const id = String(target || '').match(/^integrations\/([A-Za-z0-9_-]+)$/)?.[1];
      return id && integrationRefs.some((item) => item.id === id);
    });
  return {
    status: requestedStage && integrationTargetsAllResolve ? 'verified' : 'incomplete',
    api: {
      id: API_ID,
      name: api.Name || null,
      endpoint: api.ApiEndpoint || null,
      stage: requestedStage ? {
        name: requestedStage.StageName,
        auto_deploy: requestedStage.AutoDeploy ?? null,
        deployment_id: requestedStage.DeploymentId || null,
        last_updated_at: requestedStage.LastUpdatedDate || null,
      } : null,
      route_targets: routeTargets,
      lambda_integrations: integrationRefs.map(({ id, uri }) => ({ id, uri })),
      integration_targets_all_resolve_to_expected_lambda: integrationTargetsAllResolve,
    },
    lambda: {
      function_name: API_FUNCTION,
      version: configuration.Version || null,
      code_sha256: configuration.CodeSha256 || functionResponse.Configuration?.CodeSha256 || null,
      revision_id: configuration.RevisionId || null,
      last_modified: configuration.LastModified || null,
      alias: selected?.qualifier || null,
      alias_version: alias?.FunctionVersion || null,
    },
    flags,
    members: Object.fromEntries(LAMBDA_SOURCE_FILES.map((name) => [
      name,
      { live_sha256: memberHashes[name], main_sha256: sourceHashes[name], matches_main: memberMatches[name] },
    ])),
    repairs: {
      claim_settlement_rpc: memberMatches['claim-settlement-rpc.mjs']
        && memberMatches['data.mjs']
        && memberMatches['workflow-flags.mjs'],
      review_to_endorsing_backend: memberMatches['workflow.mjs']
        && memberMatches['workflow-transitions.mjs'],
      generic_claim_settlements_writes_blocked: genericClaimSettlementWritesBlocked,
    },
  };
}

export function databaseConnectionOptions(connectionString) {
  const url = new URL(connectionString);
  const username = decodeURIComponent(url.username);
  const allowedParams = new Set(['sslmode', 'application_name']);
  const params = [...url.searchParams.keys()];
  if (new Set(params).size !== params.length || url.hash) {
    throw new Error('Production inspector database URI has ambiguous components.');
  }
  for (const key of params) {
    if (!allowedParams.has(key)) throw new Error('Production inspector database URI has unsupported options.');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('Production inspector database URI has an unsupported protocol.');
  }
  if (url.hostname !== DB_HOST || url.port !== '5432' || url.pathname !== '/postgres'
    || username !== DB_USER || !url.password
    || (url.searchParams.has('sslmode') && url.searchParams.get('sslmode') !== 'verify-full')) {
    throw new Error('Production inspector database URI does not match the pinned read-only target.');
  }
  return {
    connectionString,
    ssl: { rejectUnauthorized: true },
    options: '-c default_transaction_read_only=on -c statement_timeout=10000',
    connectionTimeoutMillis: 10000,
  };
}

function migrationSourceState(root) {
  const source = fs.readFileSync(path.join(root, MIGRATION_PATH), 'utf8');
  return {
    body: sqlFunctionBody(source),
    expected_sha256: sqlFunctionBody(source) ? sha256(Buffer.from(sqlFunctionBody(source))) : null,
  };
}

async function defaultCreateClient(options) {
  const { Client } = await import('pg');
  return new Client(options);
}

export async function inspectDatabase({ root = ROOT, env = process.env, createClient = defaultCreateClient }) {
  const connectionString = env[DB_SECRET_ENV];
  if (!connectionString) throw new Error('Production read-only database credential is not configured.');
  const client = await createClient(databaseConnectionOptions(connectionString));
  let transactionStarted = false;
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    transactionStarted = true;
    const [identity, micr, settlement, endorsement, settlementWrites] = await Promise.all([
      client.query(validateReadOnlyInspectionQuery(DATABASE_READ_ONLY_SQL.identity)),
      client.query(validateReadOnlyInspectionQuery(DATABASE_READ_ONLY_SQL.micr)),
      client.query(validateReadOnlyInspectionQuery(DATABASE_READ_ONLY_SQL.settlement)),
      client.query(validateReadOnlyInspectionQuery(DATABASE_READ_ONLY_SQL.endorsement)),
      client.query(validateReadOnlyInspectionQuery(DATABASE_READ_ONLY_SQL.settlement_write_privileges)),
    ]);
    const role = identity.rows[0] || {};
    const readOnlyRole = role.role_name === DB_USER
      && role.transaction_read_only === 'on'
      && !role.rolsuper && !role.rolcreatedb && !role.rolcreaterole && !role.rolreplication
      && !role.rolbypassrls
      && !role.can_create_in_database && !role.can_create_in_public;
    const micrState = micr.rows[0] || {};
    const micrIntended = bool(micrState.checksops_routing_update)
      && bool(micrState.checksops_account_update)
      && bool(micrState.explicit_routing_column_grant)
      && bool(micrState.explicit_account_column_grant)
      && !bool(micrState.authenticated_routing_update)
      && !bool(micrState.authenticated_account_update)
      && !bool(micrState.anon_routing_update)
      && !bool(micrState.anon_account_update);
    const settlementState = settlement.rows[0] || {};
    const expectedSettlementBody = sqlFunctionBody(fs.readFileSync(
      path.join(root, 'aws/workflows/sql/53_claim_settlement_breakdown.sql'),
      'utf8',
    ));
    const settlementBody = sqlFunctionBody(settlementState.definition);
    const settings = Array.isArray(settlementState.settings) ? settlementState.settings : [];
    const settlementIntended = bool(settlementState.exists)
      && bool(settlementState.security_definer)
      && settings.some((setting) => /^search_path=pg_catalog, public$/i.test(setting))
      && settings.some((setting) => /^row_security=off$/i.test(setting))
      && settlementState.owner === 'postgres'
      && !bool(settlementState.public_execute)
      && bool(settlementState.checksops_execute)
      && !bool(settlementState.authenticated_execute)
      && !bool(settlementState.anon_execute)
      && normalizeSqlBody(settlementBody) === normalizeSqlBody(expectedSettlementBody);
    const endorsementState = endorsement.rows[0] || {};
    const expectedEndorsementBody = migrationSourceState(root).body;
    const endorsementIntended = bool(endorsementState.function_exists)
      && bool(endorsementState.enabled_status_update_trigger)
      && bool(endorsementState.security_definer)
      && endorsementState.owner === 'postgres'
      && (Array.isArray(endorsementState.settings)
        && endorsementState.settings.some((setting) => /^search_path=public$/i.test(setting)))
      && normalizeSqlBody(endorsementState.body) === normalizeSqlBody(expectedEndorsementBody);
    const writeState = settlementWrites.rows[0] || {};
    const noGenericSettlementWrites = !bool(writeState.can_insert)
      && !bool(writeState.can_update)
      && !bool(writeState.can_delete)
      && !bool(writeState.can_truncate);
    return {
      status: readOnlyRole ? 'verified' : 'unsafe_read_role',
      connection: { host: DB_HOST, database: role.database_name || null, transaction_read_only: role.transaction_read_only || null },
      inspector_role: {
        name: role.role_name || null,
        read_only: readOnlyRole,
        superuser: bool(role.rolsuper),
        create_database: bool(role.rolcreatedb),
        create_roles: bool(role.rolcreaterole),
        replication: bool(role.rolreplication),
        bypass_rls: bool(role.rolbypassrls),
        create_in_database: bool(role.can_create_in_database),
        create_in_public: bool(role.can_create_in_public),
      },
      sql52: { intended_state: micrIntended, ...micrState },
      sql53: {
        intended_state: settlementIntended,
        exists: bool(settlementState.exists),
        owner: settlementState.owner || null,
        security_definer: bool(settlementState.security_definer),
        settings,
        definition_sha256: settlementState.definition ? sha256(Buffer.from(settlementState.definition)) : null,
        source_body_matches: normalizeSqlBody(settlementBody) === normalizeSqlBody(expectedSettlementBody),
        public_execute: bool(settlementState.public_execute),
        checksops_execute: bool(settlementState.checksops_execute),
        authenticated_execute: bool(settlementState.authenticated_execute),
        anon_execute: bool(settlementState.anon_execute),
      },
      endorsement_trigger: {
        intended_state: endorsementIntended,
        function_exists: bool(endorsementState.function_exists),
        enabled_status_update_trigger: bool(endorsementState.enabled_status_update_trigger),
        status_update_trigger_definition: endorsementState.status_update_trigger_definition || null,
        owner: endorsementState.owner || null,
        security_definer: bool(endorsementState.security_definer),
        definition_sha256: endorsementState.definition ? sha256(Buffer.from(endorsementState.definition)) : null,
        source_body_sha256: migrationSourceState(root).expected_sha256,
        source_body_matches: normalizeSqlBody(endorsementState.body) === normalizeSqlBody(expectedEndorsementBody),
      },
      generic_claim_settlements_writes_blocked: noGenericSettlementWrites,
    };
  } finally {
    if (transactionStarted) {
      try { await client.query('ROLLBACK'); } catch { /* read-only transaction cleanup */ }
    }
    await client.end().catch(() => {});
  }
}

function proofDriftFromLock(lock, proofReference) {
  return {
    entry: proofReference.entry,
    bundle_sha256: proofReference.bundle_sha256,
    matches_lock: proofReference.entry === lock?.artifact?.name
      && proofReference.bundle_sha256 === lock?.deployment_fingerprint?.spa_sha256,
  };
}

export async function inspectProduction({
  root = ROOT,
  env = process.env,
  fetchImpl = fetch,
  awsJson = runAwsJson,
  createClient,
  now = () => new Date(),
} = {}) {
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const fetchedMainSha = execFileSync('git', ['rev-parse', 'FETCH_HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const mainSha = verifyInspectionWorkflowIdentity(env, headSha, fetchedMainSha);
  const targetMetadata = JSON.parse(fs.readFileSync(path.join(root, PRODUCTION_TARGETS_PATH), 'utf8'));
  validateProductionTargetMetadata(targetMetadata);
  const report = {
    generated_at: now().toISOString(),
    current_main_sha: mainSha,
    safety_scope: 'READ_ONLY_INSPECTION_ONLY',
    acceptance_required_before_promotion: ACCEPTANCE_REQUIRED_BEFORE_PROMOTION,
    required_aws_read_permissions: REQUIRED_AWS_READ_PERMISSIONS,
    spa: { status: 'unavailable' },
    api_lambda: { status: 'unavailable' },
    database: { status: 'unavailable' },
    drift: [],
  };
  const [spaResult, lambdaResult, databaseResult] = await Promise.allSettled([
    inspectSpa({ root, env, fetchImpl, awsJson }),
    inspectLambda({ root, env, fetchImpl, awsJson }),
    inspectDatabase({ root, env, createClient }),
  ]);
  if (spaResult.status === 'fulfilled') {
    report.spa = spaResult.value;
    const locked = readSpaLock(root).lock;
    report.drift.push(...report.spa.comparison.drift);
    if (!report.spa.repairs.claim_settlement_rpc_client_present) {
      report.drift.push('Live production SPA does not contain the Claim Settlement RPC client marker.');
    }
    report.spa.proof_drift = proofDriftFromLock(locked, report.spa.proof_reference);
  } else report.spa.error = safeInspectionFailure(spaResult.reason);
  if (lambdaResult.status === 'fulfilled') {
    report.api_lambda = lambdaResult.value;
    if (report.api_lambda.api.lambda_integrations.length === 0) {
      report.drift.push('Production API Gateway does not currently target the expected prep Lambda.');
    }
    if (!report.api_lambda.api.integration_targets_all_resolve_to_expected_lambda) {
      report.drift.push('One or more production API routes do not resolve to the inspected prep Lambda.');
    }
    if (report.api_lambda.status !== 'verified') {
      report.drift.push('Production API stage or route-to-Lambda binding is incomplete.');
    }
    if (!report.api_lambda.repairs.claim_settlement_rpc
      || !report.api_lambda.repairs.review_to_endorsing_backend
      || !report.api_lambda.repairs.generic_claim_settlements_writes_blocked) {
      report.drift.push('Live production Lambda members differ from the current merged repair source.');
    }
    if (report.api_lambda.flags.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED !== 'true') {
      report.drift.push('The application-workflow write gate is not enabled in the live Lambda configuration.');
    }
  } else report.api_lambda.error = safeInspectionFailure(lambdaResult.reason);
  if (databaseResult.status === 'fulfilled') {
    report.database = databaseResult.value;
    for (const [key, label] of [
      ['sql52', 'SQL52 MICR column grant'],
      ['sql53', 'SQL53 settlement function and privileges'],
      ['endorsement_trigger', 'endorsement-stage ledger-trigger behavior'],
    ]) {
      if (report.database[key]?.intended_state !== true) report.drift.push(`Live ${label} differs from the current approved source.`);
    }
    if (!report.database.generic_claim_settlements_writes_blocked) {
      report.drift.push('The checksops application role has generic claim_settlements write privileges.');
    }
    if (report.database.status !== 'verified') {
      report.drift.push('The configured production database inspection role is not verified read-only.');
    }
  } else report.database.error = 'Live production database inspection unavailable.';
  report.minimum_missing_mutations = buildMinimumDelta(report);
  const proofConsistent = report.spa.status === 'verified'
    && report.spa.comparison.proof_matches_lock
    && report.spa.comparison.distribution_matches_host;
  report.safe_to_authorize = report.minimum_missing_mutations.status === 'complete'
    && report.minimum_missing_mutations.mutations.length === 0
    && proofConsistent
    && report.api_lambda.flags?.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED === 'true'
    && report.api_lambda.repairs?.generic_claim_settlements_writes_blocked === true
    && report.api_lambda.api?.integration_targets_all_resolve_to_expected_lambda === true
    && report.database.generic_claim_settlements_writes_blocked === true;
  report['SAFE-TO-AUTHORIZE'] = report.safe_to_authorize ? 'YES' : 'NO';
  return report;
}

export async function main(env = process.env) {
  try {
    const report = await inspectProduction({ env });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      generated_at: new Date().toISOString(),
      safety_scope: 'READ_ONLY_INSPECTION_ONLY',
      status: 'refused',
      current_main_sha: env.GITHUB_SHA || null,
      required_aws_read_permissions: REQUIRED_AWS_READ_PERMISSIONS,
      error: error?.message || 'Production inspection was refused.',
      'SAFE-TO-AUTHORIZE': 'NO',
    }, null, 2)}\n`);
    return 2;
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = await main();
