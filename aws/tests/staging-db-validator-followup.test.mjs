import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { handler, publicDbValidationResponse } from '../functions/api/index.mjs';
import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  DB_VALIDATOR_ROUTE,
  DB_VALIDATOR_UI_PATH,
  detailedDbValidationAuthorized,
  extractDbValidatorHandler,
  handlerEnforcesCognitoDetailsGate,
  handlerUsesAppAdminRole,
  publicBodyIsRedacted,
  selectDbValidationResponse,
} from '../../scripts/deployment-guard/lib/db-validator-auth-contract.mjs';
import {
  PRODUCTION_BUCKET,
  WORKSTREAM_ID,
  evaluateDbValidatorStagingSpaPlan,
} from '../../scripts/deployment-guard/lib/staging-db-validator-spa.mjs';
import {
  evaluateDbValidatorCors,
  evaluateLivePageBundle,
  evaluateProbeCommand,
} from '../../scripts/deployment-guard/db-validator-staging-probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NOW = '2026-10-08T16:00:00.000Z';
const handlerSource = fs.readFileSync(path.join(ROOT, 'aws/functions/api/index.mjs'), 'utf8');
const accessSource = fs.readFileSync(path.join(ROOT, 'aws/functions/api/db-validator-access.mjs'), 'utf8');
const template = fs.readFileSync(path.join(ROOT, 'aws/template.yaml'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'src/App.tsx'), 'utf8');
const pageSource = fs.readFileSync(path.join(ROOT, 'src/pages/admin/AdminDbValidator.tsx'), 'utf8');

const validation = {
  ok: false,
  readOnly: true,
  issues: [{ kind: 'permission', message: 'host=db.internal' }],
  tables: [{ table: 'claims', rowCount: 1 }],
  currentUser: 'checksops',
};

function spaInput(overrides = {}) {
  return {
    workstream_id: WORKSTREAM_ID,
    branch: 'copilot/prepare-guarded-staging-deployment',
    commit: SHA,
    operator: 'copilot',
    target_environment: 'staging',
    deployment_type: 'spa-promote',
    owned_components: ['index.html'],
    build_timestamp: NOW,
    clean_build: true,
    dist: { clean_build: true },
    source_composition_manifest: {
      files: ['src/pages/admin/AdminDbValidator.tsx', 'src/lib/dbValidatorDiagnostics.ts', 'src/App.tsx'],
    },
    frontend_workstreams: [WORKSTREAM_ID],
    preflight: { index_html_sha256: 'idx-live', entry_bundle: '/assets/index-new.js' },
    immediately_before: { index_html_sha256: 'idx-live', entry_bundle: '/assets/index-new.js' },
    ...overrides,
  };
}

test('handler source gates staging details on Cognito plus application admin', () => {
  assert.equal(handlerEnforcesCognitoDetailsGate(handlerSource), true);
  assert.equal(handlerUsesAppAdminRole(handlerSource, accessSource), true);
  assert.match(extractDbValidatorHandler(handlerSource), /authorizeDetails/);
});

test('unauthenticated callers receive only the public redacted body', () => {
  assert.equal(detailedDbValidationAuthorized({ ok: false, reason: 'unauthenticated' }), false);
  assert.equal(detailedDbValidationAuthorized({}), false);
  const publicResult = selectDbValidationResponse(
    validation,
    { ok: false, reason: 'unauthenticated' },
    publicDbValidationResponse,
  );
  assert.equal(publicResult.statusCode, 503);
  assert.deepEqual(publicResult.body, { service: 'checksops-api', status: 'unhealthy', readOnly: true });
  assert.equal(publicBodyIsRedacted(publicResult.body), true);
  assert.equal(Object.hasOwn(publicResult.body, 'issues'), false);
  assert.equal(Object.hasOwn(publicResult.body, 'tables'), false);
  assert.equal(JSON.stringify(publicResult.body).includes('db.internal'), false);
});

test('staging admin callers receive detailed validation fields; non-admins get 403', () => {
  assert.equal(detailedDbValidationAuthorized({ ok: true, reason: 'staging_admin' }), true);
  const detailed = selectDbValidationResponse(
    { ...validation, environment: 'staging' },
    { ok: true, reason: 'staging_admin' },
    publicDbValidationResponse,
  );
  assert.equal(detailed.statusCode, 503);
  assert.equal(detailed.body.ok, false);
  assert.equal(detailed.body.readOnly, true);
  assert.equal(detailed.body.issues.length, 1);
  assert.equal(publicBodyIsRedacted(detailed.body), false);

  const denied = selectDbValidationResponse(
    validation,
    { ok: false, reason: 'not_admin', statusCode: 403 },
    publicDbValidationResponse,
  );
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(denied.body, { error: 'not_authorized' });
  assert.equal(Object.hasOwn(denied.body, 'issues'), false);
});

test('OPTIONS /db-readonly-validate advertises GET and authorization CORS', async () => {
  const response = await handler({
    rawPath: DB_VALIDATOR_ROUTE,
    requestContext: {
      stage: 'staging',
      http: { method: 'OPTIONS', path: DB_VALIDATOR_ROUTE },
    },
  });
  assert.equal(response.statusCode, 204);
  assert.equal(response.headers['access-control-allow-origin'], '*');
  assert.match(response.headers['access-control-allow-headers'], /authorization/);
  assert.match(response.headers['access-control-allow-methods'], /GET/);
});

test('HTTP API template allows GET and authorization without a gateway change in this follow-up', () => {
  assert.match(template, /AllowOrigins:\s*\n\s*-\s*'\*'/);
  assert.match(template, /-\s*authorization/);
  assert.match(template, /-\s*GET/);
});

test('reviewed source still contains the staging admin page and route', () => {
  assert.match(appSource, /path="\/admin\/db-validator"/);
  assert.match(appSource, /AdminDbValidator/);
  assert.match(pageSource, /isDbValidatorUiEnabled/);
  assert.match(pageSource, /fetchDbValidatorDiagnostics/);
});

test('CORS evaluator accepts staging origin GET preflight and redacted public GET', () => {
  const headers = new Headers({
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
  });
  const result = evaluateDbValidatorCors({
    origin: 'https://staging.checksops.com',
    preflightRequestHeaders: 'authorization',
    preflight: { status: 204, headers },
    publicGet: {
      status: 503,
      body: { service: 'checksops-api', status: 'unhealthy', readOnly: true },
    },
  });
  assert.equal(result.cors_get_and_origin_ok, true);
  assert.equal(result.public_get_redacted, true);
  assert.equal(result.authorization_requested, true);
  assert.equal(result.authenticated_details_not_probed, true);
  assert.equal(result.writes_attempted, false);
});

test('CORS evaluator rejects leaked public details and missing GET', () => {
  const headers = new Headers({
    'access-control-allow-origin': 'https://staging.checksops.com',
    'access-control-allow-methods': 'POST,OPTIONS',
  });
  const result = evaluateDbValidatorCors({
    origin: 'https://staging.checksops.com',
    preflight: { status: 204, headers },
    publicGet: {
      status: 503,
      body: { service: 'checksops-api', status: 'unhealthy', readOnly: true, issues: [{ message: 'secret' }] },
    },
  });
  assert.equal(result.cors_get_and_origin_ok, false);
  assert.equal(result.public_get_redacted, false);
});

test('live bundle evaluator reports missing /admin/db-validator as a blocker', () => {
  const missing = evaluateLivePageBundle({
    html: '<script type="module" src="/assets/index-old.js"></script>',
    javascript: 'function App(){return null}',
  });
  assert.equal(missing.has_db_validator_route, false);
  assert.equal(missing.blocker, 'live_spa_missing_db_validator_route');
  const present = evaluateLivePageBundle({
    html: '<script type="module" src="/assets/index-new.js"></script>',
    javascript: 'path:"/admin/db-validator"',
  });
  assert.equal(present.has_db_validator_route, true);
  assert.equal(present.blocker, null);
});

test('probe CLI refuses --live and never treats evaluation as apply', () => {
  const live = evaluateProbeCommand({ live: true });
  assert.equal(live.ok, false);
  assert.equal(live.code, CODES.GUARD_NO_AWS);
  const evaluated = evaluateProbeCommand({});
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.details.apply_forbidden, true);
  assert.equal(evaluated.details.authenticated_details_not_probed, true);
});

test('SPA plan evaluates promote safety without applying', () => {
  const result = evaluateDbValidatorStagingSpaPlan(spaInput());
  assert.equal(result.ok, true);
  assert.equal(result.details.apply_forbidden, true);
  assert.equal(result.details.production_untouched, true);
  assert.equal(result.details.release_locks_untouched, true);
  assert.equal(result.details.lambda_untouched, true);
  assert.equal(result.details.sql_untouched, true);
  assert.equal(result.details.spa_promote_allowed, true);
});

test('SPA plan refuses apply, production, reclaim, and unrelated components', () => {
  assert.equal(evaluateDbValidatorStagingSpaPlan(spaInput({ apply: true })).code, CODES.DEPLOYMENT_GUARD_REQUIRED);
  assert.equal(evaluateDbValidatorStagingSpaPlan(spaInput({ upload: true })).code, CODES.DEPLOYMENT_GUARD_REQUIRED);
  assert.equal(
    evaluateDbValidatorStagingSpaPlan(spaInput({ target_environment: 'production' })).code,
    CODES.PRODUCTION_APPROVAL_REQUIRED,
  );
  assert.equal(
    evaluateDbValidatorStagingSpaPlan(spaInput({ bucket: PRODUCTION_BUCKET })).code,
    CODES.PRODUCTION_APPROVAL_REQUIRED,
  );
  assert.equal(
    evaluateDbValidatorStagingSpaPlan(spaInput({ reclaim_staging: true })).code,
    CODES.STALE_PACKAGE,
  );
  assert.equal(
    evaluateDbValidatorStagingSpaPlan(spaInput({ owned_components: ['checksops-staging-api'] })).code,
    CODES.UNRELATED_MUTATION,
  );
  assert.equal(
    evaluateDbValidatorStagingSpaPlan(spaInput({ release_lock_mutation: true })).code,
    CODES.UNRELATED_MUTATION,
  );
});

test('SPA plan stops on live index drift and multi-workstream composition', () => {
  const collision = evaluateDbValidatorStagingSpaPlan(spaInput({
    immediately_before: { index_html_sha256: 'idx-other', entry_bundle: '/assets/index-new.js' },
  }));
  assert.equal(collision.ok, false);
  assert.equal(collision.code, CODES.DEPLOYMENT_COLLISION);

  const composition = evaluateDbValidatorStagingSpaPlan(spaInput({
    frontend_workstreams: [WORKSTREAM_ID, 'other-frontend'],
    accepted_composition: false,
  }));
  assert.equal(composition.ok, false);
  assert.equal(composition.code, CODES.SOURCE_COMPOSITION_REQUIRED);
});
