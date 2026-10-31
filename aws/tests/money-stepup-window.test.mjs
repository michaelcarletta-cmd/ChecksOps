/**
 * Security audit 2026-10-29 finding 7, owner decision 2026-10-31 ("Money step-up: how fresh
 * the code must be ... - 15 minutes"): every money action needs a financial TOTP step-up
 * verified within the last 15 minutes, not once per login. One constant and one SQL condition
 * (moov-fund-authz.mjs) serve every money gate: Check Alt deposit submit and approve
 * (checkalt-authz.mjs loadSessionCheckAltStepUp), wallet funding, sends and bank-detail changes
 * (moov-fund-authz.mjs loadSessionFundStepUp). A stale step-up answers the same error a missing
 * one does, and the SPA asks for a new code on it. The per-gate 14 / 16 minute cases are in
 * api-checkalt-production, moov-production-wallet-fund, moov-production-send and moov-onboarding.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FINANCIAL_STEPUP_MAX_AGE_SECONDS,
  WALLET_FUND_TOTP_ACTION,
  financialStepUpFreshSql,
  loadSessionFundStepUp,
} from '../functions/api/providers/production/moov-fund-authz.mjs';
import {
  FINANCIAL_CHECKALT_STEPUP_ACTIONS,
  loadSessionCheckAltStepUp,
} from '../functions/api/providers/production/checkalt-authz.mjs';
import { minutesAgo, stepUpWithinWindow } from './helpers/financial-stepup-window.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const USER = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const LOGIN = 'sub-1:jti:origin-1';

const recordingClient = (rowsFor = () => []) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: rowsFor(sql, params) };
    },
  };
};

test('one constant: 15 minutes, in seconds', () => {
  assert.equal(FINANCIAL_STEPUP_MAX_AGE_SECONDS, 900);
  assert.equal(financialStepUpFreshSql(5), 'created_at > now() - make_interval(secs => $5::int)');
  assert.equal(financialStepUpFreshSql(7, 's.created_at'), 's.created_at > now() - make_interval(secs => $7::int)');
});

test('both money step-up lookups carry the window on the server-written created_at and bind the shared constant', async () => {
  const fund = recordingClient();
  await loadSessionFundStepUp(fund, { userId: USER, tenantId: TENANT, loginSession: LOGIN });
  const checkalt = recordingClient();
  await loadSessionCheckAltStepUp(checkalt, { userId: USER, tenantId: TENANT, loginSession: LOGIN });
  for (const [name, client, action] of [
    ['wallet.fund', fund, WALLET_FUND_TOTP_ACTION],
    ['checkalt', checkalt, [...FINANCIAL_CHECKALT_STEPUP_ACTIONS]],
  ]) {
    assert.equal(client.queries.length, 1, name);
    const [{ sql, params }] = client.queries;
    assert.ok(sql.includes(`AND ${financialStepUpFreshSql(5)}`), name);
    assert.deepEqual(params, [USER, TENANT, action, LOGIN, FINANCIAL_STEPUP_MAX_AGE_SECONDS], name);
    // Still bound to the user, tenant, server-written app TOTP rows and this login.
    for (const clause of [
      'user_id = $1::uuid', 'tenant_id = $2::uuid', 'succeeded IS TRUE', "factor_type = 'totp'",
      "(metadata->>'source') = 'app_financial_totp'", "(metadata->>'login_session') = $4", 'ORDER BY created_at DESC',
    ]) assert.ok(sql.includes(clause), `${name}: ${clause}`);
    // The verified-at time is the database row, never the token's issue or auth time.
    assert.doesNotMatch(sql, /\biat\b|auth_time/, name);
  }
});

test('a lookup the database answers with no row (a stale step-up) is null for both gates', async () => {
  const empty = recordingClient(() => []);
  assert.equal(await loadSessionFundStepUp(empty, { userId: USER, tenantId: TENANT, loginSession: LOGIN }), null);
  assert.equal(await loadSessionCheckAltStepUp(empty, { userId: USER, tenantId: TENANT, loginSession: LOGIN }), null);
  // Without a login binding nothing is looked up at all.
  const none = recordingClient();
  assert.equal(await loadSessionFundStepUp(none, { userId: USER, tenantId: TENANT, loginSession: null }), null);
  assert.equal(await loadSessionCheckAltStepUp(none, { userId: USER, tenantId: TENANT, loginSession: null }), null);
  assert.equal(none.queries.length, 0);
});

test('the test fake applies the same window: 14 minutes inside, 16 minutes outside', () => {
  const sql = `SELECT 1 WHERE ${financialStepUpFreshSql(5)}`;
  const params = [USER, TENANT, WALLET_FUND_TOTP_ACTION, LOGIN, FINANCIAL_STEPUP_MAX_AGE_SECONDS];
  assert.equal(stepUpWithinWindow(sql, params, { created_at: minutesAgo(14) }), true);
  assert.equal(stepUpWithinWindow(sql, params, { created_at: minutesAgo(16) }), false);
  assert.throws(() => stepUpWithinWindow(sql, params.slice(0, 4), { created_at: minutesAgo(1) }), /positive integer/);
});

test('every money gate goes through one of the two lookups and answers the error the SPA re-prompts on', () => {
  const api = 'aws/functions/api/providers';
  // Wallet funding, sends and bank-detail changes: loadSessionFundStepUp, then 401 totp_required.
  for (const rel of [`${api}/production/moov-wallet-fund.mjs`, `${api}/production/moov-send.mjs`, `${api}/onboarding/handlers.mjs`]) {
    const source = read(rel);
    assert.match(source, /loadSessionFundStepUp\(client,/, rel);
    assert.match(source, /fail\('totp_required', 401/, rel);
  }
  // Check Alt submit and approve: authorizeCheckAltProduction -> loadSessionCheckAltStepUp, then step_up_required.
  const authz = read(`${api}/production/checkalt-authz.mjs`);
  assert.match(authz, /totpRow = await loadSessionCheckAltStepUp\(client,/);
  assert.match(authz, /!evaluation\.stepUpOk\n\s*\? 'step_up_required'/);
  assert.match(read(`${api}/production/checkalt-submit.mjs`), /authorizeCheckAltProduction\(\{[\s\S]*?requireStepUp: true,/);
  assert.match(read(`${api}/production/checkalt-approve.mjs`), /const denyStepUp = \(authz\) => fail\('step_up_required', 403/);
});

test('the SPA asks for a new code (force) when the server answers the stale step-up error', () => {
  // Check Alt deposit submit (step_up_required).
  assert.match(read('src/lib/financialStepUp.ts'), /return message\.trim\(\) === "step_up_required";/);
  const orchestrator = read('src/lib/checkaltDepositOrchestrator.ts');
  assert.match(orchestrator, /if \(submitted\.error && isStepUpRequiredError\(submitted\.error\)\) \{[\s\S]*?requireStepUp\(built\.request, \{ force: true \}\)[\s\S]*?submitted = await submit\(checkId\);/);
  // Wallet funding, sends and bank-detail changes (totp_required).
  assert.match(read('src/hooks/useWallet.ts'), /error\.code !== "totp_required"\) throw error;\n\s*if \(!\(await requireStepUp\(stepUp, \{ force: true \}\)\)\)/);
  assert.match(read('src/components/disbursement/DisbursementConsole.tsx'), /error\.code !== "totp_required"\) throw error;[\s\S]{0,120}requireStepUp\(/);
  assert.match(read('src/components/disbursement/DisbursementConsole.tsx'), /\{ force: true \},\n\s*\);\n\s*if \(!confirmed\)/);
  assert.match(read('src/lib/bankStepUp.ts'), /!== "totp_required"\) return first;\n\s*if \(!\(await requireStepUp\(\{ \.\.\.BANK_STEP_UP, tenantId \}, \{ force: true \}\)\)\)/);
});
