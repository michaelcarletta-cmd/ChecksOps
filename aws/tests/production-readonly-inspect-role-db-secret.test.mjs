/**
 * Finding 12 (2026-10-29): the production read-only inspect role must not read the production
 * application database password. The target policy is the live one with
 * secretsmanager:GetSecretValue removed; every other statement is unchanged, and the routine
 * inspect workflow's session policy never asks for it.
 * Runbook: ops/deployment-guard/production-readonly-inspect-role/README.md.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const DIR = 'ops/deployment-guard/production-readonly-inspect-role';
const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const LIVE = JSON.parse(read(`${DIR}/ChecksOpsProductionReadOnlyInspect.live-2026-10-29.json`));
const TARGET = JSON.parse(read(`${DIR}/ChecksOpsProductionReadOnlyInspect.json`));
const SECRET = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-production/checksops/1790081257144-A2Z4bw';
const arr = (value) => (Array.isArray(value) ? value : [value]);

test('the target allows no secret value read and keeps DescribeSecret on the exact secret', () => {
  for (const statement of TARGET.Statement) {
    assert.equal(statement.Effect, 'Allow');
    for (const action of arr(statement.Action)) {
      assert.ok(!['secretsmanager:GetSecretValue', 'secretsmanager:*', '*'].includes(action), action);
    }
  }
  const secret = TARGET.Statement.filter((s) => arr(s.Resource).includes(SECRET));
  assert.equal(secret.length, 1);
  assert.deepEqual(arr(secret[0].Action), ['secretsmanager:DescribeSecret']);
  assert.deepEqual(arr(secret[0].Resource), [SECRET]);
});

test('the target is the live policy with only GetSecretValue removed', () => {
  assert.equal(TARGET.Version, LIVE.Version);
  assert.equal(TARGET.Statement.length, LIVE.Statement.length);
  LIVE.Statement.forEach((live, i) => {
    const target = TARGET.Statement[i];
    const kept = arr(live.Action).filter((a) => a !== 'secretsmanager:GetSecretValue');
    assert.deepEqual(arr(target.Action), kept, `statement ${i}`);
    assert.deepEqual({ ...target, Action: null }, { ...live, Action: null }, `statement ${i}`);
  });
  // The live document is the evidence: it did grant the read.
  assert.ok(LIVE.Statement.some((s) => arr(s.Action).includes('secretsmanager:GetSecretValue') && arr(s.Resource).includes(SECRET)));
});

test('the routine inspect workflow never asks for GetSecretValue in its session', () => {
  const workflow = read('.github/workflows/inspect-production-readonly.yml');
  assert.match(workflow, /environment: production-readonly/);
  assert.match(workflow, /inline-session-policy:/);
  assert.doesNotMatch(workflow, /GetSecretValue/);
});

test('the runbook applies the target, verifies by simulation and rolls back to the live snapshot', () => {
  const readme = read(`${DIR}/README.md`);
  assert.match(readme, /put-role-policy --role-name ChecksOpsGitHubProductionReadOnlyInspect[\s\S]*ChecksOpsProductionReadOnlyInspect\.json/);
  assert.match(readme, /## Rollback[\s\S]*ChecksOpsProductionReadOnlyInspect\.live-2026-10-29\.json/);
  assert.match(readme, /SimulatePrincipalPolicy/);
  assert.match(read('ops/production-secret-host-compare.md'), /Withdrawn 2026-10-29/);
});
