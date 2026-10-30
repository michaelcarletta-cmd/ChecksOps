import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// ops/production-sql-one-shot.md: the SQL runner holds production admin database access, so it
// stays stopped between production runs (security audit finding C).
const RUNBOOK = fs.readFileSync(new URL('../../ops/production-sql-one-shot.md', import.meta.url), 'utf8');
const RUNNER = 'i-0c35557c4e5385406';

const section = (heading) => {
  const start = RUNBOOK.indexOf(`## ${heading}`);
  assert.ok(start >= 0, `section ${heading}`);
  const next = RUNBOOK.indexOf('\n## ', start + 3);
  return RUNBOOK.slice(start, next < 0 ? undefined : next);
};

test('the one-shot runbook keeps the runner stopped between runs and starts it only for a run', () => {
  const state = section('Runner state: stopped between runs');
  assert.match(state, /stays \*\*stopped\*\*/);
  assert.ok(state.includes(`aws ec2 start-instances --instance-ids ${RUNNER}`));
  assert.ok(state.includes(`aws ec2 wait instance-running --instance-ids ${RUNNER}`));
  assert.match(state, /PingStatus/);
  assert.ok(state.includes(`aws ec2 stop-instances --instance-ids ${RUNNER}`));
  assert.ok(state.includes(`aws ec2 wait instance-stopped --instance-ids ${RUNNER}`));
  assert.ok(state.indexOf('start-instances') < state.indexOf('stop-instances'));
});

test('the runner state section comes before the single SSM command', () => {
  assert.ok(RUNBOOK.indexOf('## Runner state: stopped between runs') < RUNBOOK.indexOf('## The single SSM command'));
});
