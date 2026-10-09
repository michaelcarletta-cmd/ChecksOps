import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/staging-settlement-uat-exec.json'), 'utf8'));

test('UAT execution pin is BLOCKED and records zero mutations', () => {
  assert.equal(PIN.id, 'staging-settlement-uat-exec');
  assert.equal(PIN.verdict, 'BLOCKED');
  assert.equal(PIN.writes_attempted, false);
  assert.equal(PIN.writes_committed, false);
  assert.equal(PIN.production_changes, false);
  assert.equal(PIN.sql_migrations, false);
  assert.equal(PIN.lambda_or_spa_deployments, false);
  assert.equal(PIN.provider_invocations, false);
  assert.equal(PIN.synthetic_claim_id, null);
  assert.equal(PIN.settlement_id, null);
  assert.equal(PIN.check_id, null);
  assert.deepEqual(PIN.mutations, []);
  assert.equal(PIN.expected_writes_observed.homeowner_ledger_events, 0);
  assert.equal(PIN.expected_writes_observed.provider_transactions, 0);
  assert.equal(PIN.expected_writes_observed.claim_settlements, 0);
});

test('live auth differs from password-file plan and OTP did not complete', () => {
  assert.equal(PIN.preflight.password_login.httpStatus, 410);
  assert.equal(PIN.preflight.password_login.error, 'password_auth_disabled');
  assert.equal(PIN.preflight.email_otp.httpStatus, 200);
  assert.equal(PIN.preflight.email_otp.challenge, 'EMAIL_OTP');
  assert.equal(PIN.preflight.email_otp.otp_received_in_connected_mailbox, false);
  assert.equal(PIN.preflight.email_otp.connected_outlook_mailbox, 'claims@freedomadj.com');
  assert.equal(PIN.secrets.master_uat_used, false);
  assert.equal(PIN.secrets.password_file_present, false);
});

test('workflow flags stayed non-financial and identity split is recorded', () => {
  assert.equal(PIN.preflight.workflow_status.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED, true);
  assert.equal(PIN.preflight.workflow_status.AWS_PROVIDER_EXECUTION_ENABLED, false);
  assert.equal(PIN.preflight.workflow_status.AWS_CHECKALT_ENABLED, false);
  assert.equal(PIN.preflight.workflow_status.AWS_MOOV_ENABLED, false);
  assert.equal(PIN.identity_split.live_cognito['checksops-tester@freedomadj.com'].sub_prefix, '04d85458');
  assert.equal(PIN.identity_split.live_cognito['mcarletta@freedomadj.com'].sub_prefix, 'c4386408');
  assert.equal(PIN.identity_split.plan_actor.application_user_id, 'abd3c2a0-6dc0-4680-92dd-a013e1141c91');
  assert.match(PIN.identity_split.stop, /Do not authenticate as claims@ or staging-master/);
});

test('reserved synthetic label is unchanged and no cleanup was required', () => {
  assert.equal(PIN.reserved_claim_number, 'AWS SETTLEMENT UAT');
  assert.equal(PIN.cleanup.synthetic_check_deleted, false);
  assert.equal(PIN.cleanup.claim_preserved, true);
  assert.equal(PIN.cleanup.settlement_preserved, true);
  assert.ok(PIN.remaining_blockers.some((row) => row.includes('abd3c2a0')));
});
