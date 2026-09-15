import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CHECKALT_DEPOSITS_EMBED,
  checkAltLifecycleLabelForCheck,
  formatCheckAltLifecycleLabel,
  hasAuthoritativeCheckAltSubmission,
  isUncertainCheckAltDeposit,
  normalCheckAltDepositAllowed,
  normalizeCheckAltStatus,
} from '../../src/features/check-command/checkAltLifecycle.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

const CHECK_9562 = '623442f0-a408-4db5-85be-14bae231a722';

const readyCheck = (deposits = []) => ({
  id: CHECK_9562,
  check_number: '9562',
  amount: 9984.11,
  status: 'approved_for_deposit',
  check_stage: 'ready_for_deposit',
  checkalt_deposits: deposits,
});

const deposit9562 = (extra = {}) => ({
  id: 'dep-9562',
  status: 'pending_approval',
  checkalt_reference: '122678838',
  submitted_at: '2026-09-14T00:00:00.000Z',
  approved_at: null,
  updated_at: '2026-09-14T00:00:00.000Z',
  last_status_payload: { status: 40, statusCode: 40 },
  status_unresolved: false,
  ...extra,
});

test('Pending Approval / numeric 40 / hyphenated tokens normalize to pending_approval', () => {
  assert.equal(normalizeCheckAltStatus(40), 'pending_approval');
  assert.equal(normalizeCheckAltStatus('40'), 'pending_approval');
  assert.equal(normalizeCheckAltStatus('Pending Approval'), 'pending_approval');
  assert.equal(normalizeCheckAltStatus('pending-approval'), 'pending_approval');
  assert.equal(normalizeCheckAltStatus('pending_approval'), 'pending_approval');
});

test('#9562 shape hides Deposit, Mark as Deposited, and Ready behavior', () => {
  const check = readyCheck([deposit9562()]);
  assert.equal(hasAuthoritativeCheckAltSubmission(check), true);
  assert.equal(normalCheckAltDepositAllowed(check), false);
  assert.equal(
    checkAltLifecycleLabelForCheck(check),
    'CheckAlt: Pending Approval — Ref #122678838',
  );
  assert.equal(check.status, 'approved_for_deposit');
  assert.equal(check.check_stage, 'ready_for_deposit');
});

test('reload / new session re-derives the same #9562 state from the same RDS fixture', () => {
  const first = readyCheck([deposit9562()]);
  const reloaded = readyCheck([deposit9562()]);
  assert.equal(normalCheckAltDepositAllowed(first), normalCheckAltDepositAllowed(reloaded));
  assert.equal(checkAltLifecycleLabelForCheck(first), checkAltLifecycleLabelForCheck(reloaded));
  assert.equal(hasAuthoritativeCheckAltSubmission(first), hasAuthoritativeCheckAltSubmission(reloaded));
});

test('no deposit row keeps Deposit allowed', () => {
  const check = readyCheck([]);
  assert.equal(hasAuthoritativeCheckAltSubmission(check), false);
  assert.equal(normalCheckAltDepositAllowed(check), true);
  assert.equal(checkAltLifecycleLabelForCheck(check), null);
});

test('submitted / processing / cleared hide Deposit', () => {
  for (const status of ['submitted', 'processing', 'cleared', 'approved']) {
    const check = readyCheck([deposit9562({ status, checkalt_reference: '122678838' })]);
    assert.equal(normalCheckAltDepositAllowed(check), false, status);
  }
});

test('uncertain provider result hides Deposit and shows reconciliation', () => {
  const check = readyCheck([deposit9562({
    status: 'submitting',
    checkalt_reference: null,
    provider_http_attempted_at: '2026-09-14T00:00:00.000Z',
    failure_class: 'db_after_provider',
    last_status_payload: { provider_http_attempted: true, failure_class: 'db_after_provider', uncertain: true },
  })]);
  assert.equal(normalCheckAltDepositAllowed(check), false);
  assert.equal(isUncertainCheckAltDeposit(check.checkalt_deposits[0]), true);
  assert.equal(formatCheckAltLifecycleLabel(check.checkalt_deposits[0]), 'CheckAlt: Reconciliation required');
});

test('rejected with a CheckAlt reference does not restore Deposit', () => {
  const check = readyCheck([deposit9562({ status: 'rejected' })]);
  assert.equal(normalCheckAltDepositAllowed(check), false);
  assert.match(checkAltLifecycleLabelForCheck(check), /Ref #122678838/);
});

test('rejected without reference or HTTP attempt is not treated as submitted', () => {
  const check = readyCheck([deposit9562({
    status: 'rejected',
    checkalt_reference: null,
    provider_http_attempted_at: null,
    last_status_payload: { status: 120 },
  })]);
  assert.equal(hasAuthoritativeCheckAltSubmission(check), false);
  assert.equal(normalCheckAltDepositAllowed(check), true);
});

test('Command Center embed includes authoritative CheckAlt fields and no check-row duplicate state', () => {
  const page = fs.readFileSync(path.join(ROOT, 'src/pages/CheckCommandCenter.tsx'), 'utf8');
  const embed = CHECKALT_DEPOSITS_EMBED;
  assert.match(embed, /checkalt_reference/);
  assert.match(embed, /status_unresolved/);
  assert.match(embed, /last_status_payload/);
  const leftover = page.match(/checkalt_deposits\([^)]+\)/g) || [];
  assert.equal(leftover.length, 0, leftover.join(' | '));
  assert.equal(page.includes(embed) || page.includes('CHECKALT_DEPOSITS_EMBED'), true);
  assert.doesNotMatch(page, /set\(status,\s*['"]deposited['"]\)/);
});

test('ready totals migration excludes authoritative CheckAlt rows without rewriting checks', () => {
  const sql = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations/20260915120000_checkalt_ready_totals_exclude_submitted.sql'),
    'utf8',
  );
  assert.match(sql, /checkalt_deposits/);
  assert.match(sql, /checkalt_submitted THEN 'deposited'/);
  assert.match(sql, /checkalt_reference IS NOT NULL/);
  assert.doesNotMatch(sql, /UPDATE public\.check_intake_items/);
});
