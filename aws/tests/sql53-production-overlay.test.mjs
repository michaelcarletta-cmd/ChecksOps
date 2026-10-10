import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateLambdaOverlay } from '../../scripts/deployment-guard/lib/lambda-overlay.mjs';
import {
  SQL53_OVERLAY_ADD_MEMBERS,
  SQL53_OVERLAY_INSPECT_MEMBER,
  SQL53_OVERLAY_LIVE_CODE_SHA256,
  SQL53_OVERLAY_LIVE_DB_HEALTH_SHA256,
  SQL53_OVERLAY_LIVE_INDEX_SHA256,
  SQL53_OVERLAY_LIVE_REVISION_ID,
  SQL53_OVERLAY_LIVE_SECRETS_SHA256,
  SQL53_OVERLAY_LIVE_VALIDATOR_SHA256,
  evaluateSql53ProductionOverlay,
  patchLiveProductionIndex,
  repoSql53InspectSha256,
  sha256Text,
} from '../../scripts/deployment-guard/lib/sql53-production-overlay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = path.join(ROOT, 'aws/tests/fixtures/live-production-index-24f13aa5.mjs');
const PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/production-sql53-overlay.json'), 'utf8'));
const MAPS = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/production-sql53-overlay-members.json'), 'utf8'));
const EVAL = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/production-sql53-overlay-eval.json'), 'utf8'));
const MAIN_INDEX = fs.readFileSync(path.join(ROOT, 'aws/functions/api/index.mjs'), 'utf8');

test('live production index fixture is the pinned member and is not origin/main', () => {
  const live = fs.readFileSync(FIXTURE, 'utf8');
  assert.equal(sha256Text(live), SQL53_OVERLAY_LIVE_INDEX_SHA256);
  assert.equal(sha256Text(live), PIN.live.index_sha256);
  assert.notEqual(sha256Text(MAIN_INDEX), SQL53_OVERLAY_LIVE_INDEX_SHA256);
  assert.doesNotMatch(live, /sql53-production-readonly-inspect/);
  assert.doesNotMatch(live, /GET \/sql53-production-readonly-inspect/);
});

test('surgical patch adds only the direct-invoke hook', () => {
  const live = fs.readFileSync(FIXTURE, 'utf8');
  const patched = patchLiveProductionIndex(live);
  assert.equal(sha256Text(patched), MAPS.patched_index_sha256);
  assert.match(patched, /isSql53ProductionReadonlyInspectEvent\(event\)/);
  assert.match(patched, /handleSql53ProductionReadonlyInspect\(event\)/);
  assert.doesNotMatch(patched, /SQL53_READONLY_INSPECT_PATH/);
  assert.doesNotMatch(patched, /GET \/sql53-production-readonly-inspect/);
  assert.doesNotMatch(patched, /READ_ONLY_PATHS[\s\S]*sql53/);
  assert.equal(patched.includes("import { handleSandboxRequest } from './sandbox.mjs';"), true);
  assert.throws(() => patchLiveProductionIndex(patched), /already contains/);
  assert.throws(() => patchLiveProductionIndex(`${live}\n`), /drifted/);
  assert.throws(() => patchLiveProductionIndex(MAIN_INDEX), /already contains|drifted/);
});

test('official overlay evaluation allows only the inspect add and live index patch', () => {
  const inspectSha = repoSql53InspectSha256(ROOT);
  assert.equal(inspectSha, MAPS.inspect_sha256);
  assert.equal(inspectSha, PIN.proposed.inspect_sha256);
  const liveMembers = {
    ...MAPS.root_mjs,
    'node_modules/pg/package.json': 'live-pg-keep',
    'providers/webhooks.mjs': 'live-provider-keep',
  };
  assert.equal(liveMembers['index.mjs'], SQL53_OVERLAY_LIVE_INDEX_SHA256);
  assert.equal(liveMembers['db-readonly-validate.mjs'], SQL53_OVERLAY_LIVE_VALIDATOR_SHA256);
  assert.equal(liveMembers['secrets.mjs'], SQL53_OVERLAY_LIVE_SECRETS_SHA256);
  assert.equal(liveMembers['db-health.mjs'], SQL53_OVERLAY_LIVE_DB_HEALTH_SHA256);
  const { evaluation, diff } = evaluateSql53ProductionOverlay({
    liveMembers,
    inspectSha256: inspectSha,
    patchedIndexSha256: MAPS.patched_index_sha256,
    commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    branch: 'cursor/prod-sql53-overlay-prep-3bc9',
    buildTimestamp: '2026-10-10T18:10:00.000Z',
    downloadedAt: '2026-10-10T18:10:00.000Z',
  });
  assert.equal(evaluation.ok, true);
  assert.equal(evaluation.details.overlay_allowed, true);
  assert.deepEqual(diff.added, [SQL53_OVERLAY_INSPECT_MEMBER]);
  assert.deepEqual(diff.changed, ['index.mjs']);
  assert.deepEqual(diff.deleted, []);
  assert.deepEqual(SQL53_OVERLAY_ADD_MEMBERS, [SQL53_OVERLAY_INSPECT_MEMBER]);
});

test('overlay fails closed if unrelated live members would change', () => {
  const liveMembers = {
    ...MAPS.root_mjs,
    'node_modules/pg/package.json': 'live-pg-keep',
  };
  assert.throws(() => evaluateSql53ProductionOverlay({
    liveMembers: { ...liveMembers, 'db-readonly-validate.mjs': 'not-the-live-validator' },
    inspectSha256: MAPS.inspect_sha256,
    patchedIndexSha256: MAPS.patched_index_sha256,
    commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    branch: 'cursor/prod-sql53-overlay-prep-3bc9',
    buildTimestamp: '2026-10-10T18:10:00.000Z',
  }), /db-readonly-validate\.mjs drifted/);

  const replaceValidator = evaluateLambdaOverlay({
    ...EVAL,
    candidate_members: {
      ...EVAL.candidate_members,
      'db-readonly-validate.mjs': 'origin-main-validator',
    },
  });
  assert.equal(replaceValidator.ok, false);

  const replaceWithMainIndex = evaluateLambdaOverlay({
    ...EVAL,
    candidate_members: {
      ...EVAL.candidate_members,
      'index.mjs': sha256Text(MAIN_INDEX),
    },
  });
  assert.equal(replaceWithMainIndex.ok, true);
  assert.notEqual(sha256Text(MAIN_INDEX), MAPS.patched_index_sha256);
  assert.notEqual(EVAL.candidate_members['index.mjs'], sha256Text(MAIN_INDEX));
});

test('official lambda-overlay CLI stays evaluate-only and records the applied live pin', () => {
  assert.equal(PIN.authorization, 'owner-authorized-guarded-lambda-overlay');
  assert.equal(PIN.apply_authorized, true);
  assert.equal(PIN.verdict, 'OVERLAY_DEPLOYED');
  assert.equal(PIN.live.code_sha256, SQL53_OVERLAY_LIVE_CODE_SHA256);
  assert.equal(PIN.live.revision_id, SQL53_OVERLAY_LIVE_REVISION_ID);
  assert.equal(PIN.live.sql53_authorization_env_present, false);
  assert.equal(PIN.live.sql53_expires_at_env_present, false);
  assert.equal(PIN.applied.code_sha256, 'oQDCIRFyreTPe781aeSFLdXNfU3M2ZUQo5Wcgi0EqWI=');
  assert.equal(PIN.applied.revision_id, '534d4e36-0e62-461e-948e-e2bf00d3920e');
  assert.equal(PIN.applied.index_sha256, MAPS.patched_index_sha256);
  assert.equal(PIN.applied.inspect_sha256, MAPS.inspect_sha256);
  assert.equal(PIN.applied.sql53_authorization_env_present, false);
  assert.equal(PIN.applied.sql53_expires_at_env_present, false);
  assert.equal(PIN.http_route, null);
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/deployment-guard/lambda-overlay.mjs'),
    '--input',
    path.join(ROOT, 'ops/deployment-guard/production-sql53-overlay-eval.json'),
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.details.apply, false);
  assert.equal(parsed.details.overlay_allowed, true);
  assert.match(parsed.details.note, /evaluate-only/);
});
