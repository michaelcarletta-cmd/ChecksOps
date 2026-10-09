import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  AUTHORIZED_SQL53,
  evaluateSqlExecutorAuthorization,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { evaluateSql53StagingApply } from '../../scripts/deployment-guard/lib/sql53-staging-apply.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIN = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'ops/deployment-guard/sql53-staging-execution-auth-preflight.json'),
  'utf8',
));

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('final execution-auth preflight is evaluate-only and matches official SQL 53 pins', () => {
  assert.equal(PIN.authorization, 'source-only');
  assert.equal(PIN.apply_authorized, false);
  assert.equal(PIN.execute, false);
  assert.equal(PIN.invoke_authorized, false);
  assert.equal(PIN.receipt_issued, false);
  assert.equal(PIN.verdict, 'GO');
  assert.equal(PIN.commit, AUTHORIZED_SQL53.commit);
  assert.equal(PIN.source_sha256, AUTHORIZED_SQL53.source_sha256);
  assert.equal(PIN.intended_replacement_sha256, AUTHORIZED_SQL53.intended_replacement_sha256);
  assert.equal(PIN.absent_live_definition_sha256, AUTHORIZED_SQL53.absent_live_definition_sha256);
  assert.equal(PIN.migration_id, AUTHORIZED_SQL53.migration_id);
  assert.equal(sha256File(path.join(ROOT, AUTHORIZED_SQL53.filename)), AUTHORIZED_SQL53.source_sha256);
  assert.equal(PIN.latest_absent_inspect.exists, false);
  assert.equal(PIN.latest_absent_inspect.workflow_run, 37969902795);
  assert.equal(PIN.live_executor.CodeSha256, 'oqbZHB8JUyKpLgsfv96gudtHAZKKZkHUSnPFfDkCz24=');
  assert.equal(PIN.live_executor.RevisionId, '983b80cd-ef8c-43a7-99c4-d3f9a5334a7d');
});

test('sql-apply evaluate path still refuses apply and unguarded invoke fails closed', () => {
  const apply = evaluateSql53StagingApply({
    ...PIN,
    apply: true,
    execute: true,
    target_environment: 'staging',
  }, { root: ROOT });
  assert.equal(apply.ok, false);
  assert.equal(apply.code, CODES.GUARD_APPLY_FORBIDDEN);

  const now = Date.parse('2026-10-09T18:00:00.000Z');
  const auth = evaluateSqlExecutorAuthorization({
    workstream_id: 'staging-sql53-3bc9',
    branch: 'cursor/staging-sql53-execution-auth-3bc9',
    commit: AUTHORIZED_SQL53.commit,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
    owned_components: [AUTHORIZED_SQL53.filename],
    filename: AUTHORIZED_SQL53.filename,
    migration_id: AUTHORIZED_SQL53.migration_id,
    source_sha256: AUTHORIZED_SQL53.source_sha256,
    intended_replacement_sha256: AUTHORIZED_SQL53.intended_replacement_sha256,
    expected_live_definition_sha256: AUTHORIZED_SQL53.absent_live_definition_sha256,
    one_use_id: 'sql53-auth-preflight-0001',
    expiry: '2026-10-09T19:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    action: 'authorize',
    build_timestamp: '2026-10-09T18:00:00.000Z',
    preflight_live_fingerprint: {
      sql: AUTHORIZED_SQL53.absent_live_definition_sha256,
      filename: AUTHORIZED_SQL53.filename,
      migration_id: AUTHORIZED_SQL53.migration_id,
      source_sha256: AUTHORIZED_SQL53.source_sha256,
      intended_replacement_sha256: AUTHORIZED_SQL53.intended_replacement_sha256,
      one_use_id: 'sql53-auth-preflight-0001',
      commit: AUTHORIZED_SQL53.commit,
    },
  }, { now });
  assert.equal(auth.ok, true, auth.message);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-sql53-auth-'));
  const log = path.join(dir, 'aws-calls.log');
  const bin = path.join(dir, 'fake-aws');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit 1\n`);
  fs.chmodSync(bin, 0o755);
  const invoke = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/deployment-guard/sql-executor-invoke.mjs'),
  ], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      AWS_CLI: bin,
      HOME: dir,
      CHECKSOPS_DEPLOYMENT_GUARD_ROOT: dir,
    },
  });
  assert.notEqual(invoke.status, 0);
  assert.match(`${invoke.stderr}${invoke.stdout}`, /DEPLOYMENT_GUARD_REQUIRED/);
  assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', '');
});
