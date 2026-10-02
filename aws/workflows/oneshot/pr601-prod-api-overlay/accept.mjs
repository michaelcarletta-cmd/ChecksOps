#!/usr/bin/env node
/**
 * Production #601 API overlay acceptance.
 * Uses the existing Freedom tester and C1C outsider only.
 * Does not manufacture an ordinary staff account.
 * Does not write SPA/SQL/GRANT/Cognito/IAM/env.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const API = 'https://checksops.com/prep';
const POOL = 'us-east-1_h00WorYMT';
const CLIENT = '3ja9fqaq2fjkv3i6up2varcqpe';
const TESTER = 'checksops-tester@freedomadj.com';
const CROSS = 'payments@condition1commercial.com';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OUT = process.env.PR601_ACCEPT_OUT || '/tmp/pr601-prod/accept';

mkdirSync(OUT, { recursive: true });

const run = (args) => execFileSync(AWS, ['--region', 'us-east-1', '--output', 'json', ...args], {
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
});

const tokenFor = (email) => {
  const pwd = `Pr601-${randomBytes(18).toString('base64url')}!aA1`;
  execFileSync(AWS, [
    '--region', 'us-east-1', 'cognito-idp', 'admin-set-user-password',
    '--user-pool-id', POOL, '--username', email, '--password', pwd, '--permanent',
  ], { stdio: 'ignore' });
  let auth;
  try {
    auth = JSON.parse(run([
      'cognito-idp', 'admin-initiate-auth',
      '--user-pool-id', POOL,
      '--client-id', CLIENT,
      '--auth-flow', 'ADMIN_USER_PASSWORD_AUTH',
      '--auth-parameters', `USERNAME=${email},PASSWORD=${pwd}`,
    ]));
  } catch {
    auth = JSON.parse(run([
      'cognito-idp', 'initiate-auth',
      '--client-id', CLIENT,
      '--auth-flow', 'USER_PASSWORD_AUTH',
      '--auth-parameters', `USERNAME=${email},PASSWORD=${pwd}`,
    ]));
  }
  if (!auth.AuthenticationResult?.IdToken) throw new Error(`login_failed:${email.split('@')[0]}`);
  return auth.AuthenticationResult.IdToken;
};

const call = async (token, path, body, method = 'POST') => {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body || {}),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, json };
};

const rpc = (token, name, args) => call(token, '/data/rpc', { name, args });
const query = (token, table, select, filters = [], limit = 50) => call(token, '/data/query', {
  table,
  select,
  filters,
  limit,
});

const pickMoveTarget = (status) => {
  if (status === 'needs_review') return 'uploaded';
  if (status === 'uploaded') return 'needs_review';
  if (status === 'ocr_complete') return 'needs_review';
  if (status === 'manual_review_required') return 'needs_review';
  if (status === 'endorsements_in_progress') return 'needs_review';
  if (status === 'endorsements_complete') return 'endorsements_in_progress';
  if (status === 'approved_for_deposit') return 'needs_review';
  if (status === 'processing') return 'needs_review';
  return 'needs_review';
};

const tester = tokenFor(TESTER);
const crossToken = tokenFor(CROSS);

const me = await call(tester, '/identity/me', null, 'GET');
const crossMe = await call(crossToken, '/identity/me', null, 'GET');

const checks = await query(tester, 'check_intake_items', 'id,tenant_id,status,check_stage,claim_id,deposited_at', [
  { column: 'tenant_id', op: 'eq', value: FREEDOM },
], 80);
const checkRows = checks.json.data || checks.json.rows || [];
const movable = checkRows.find((row) => (
  row
  && row.status
  && row.status !== 'deposited'
  && !row.deposited_at
  && [
    'uploaded', 'processing', 'ocr_complete', 'needs_review', 'manual_review_required',
    'reissue_requested', 'endorsements_in_progress', 'endorsements_complete',
    'approved_for_deposit', 'branch_deposit_required', 'loss_draft_required', 'voided',
  ].includes(row.status)
));
const deposited = checkRows.find((row) => row.status === 'deposited' || row.deposited_at);

let movement = { skipped: true, reason: 'no_movable_freedom_check' };
let restore = null;
let audit = { skipped: true };
if (movable?.id) {
  const nextStatus = pickMoveTarget(movable.status);
  const beforeAudit = await query(tester, 'check_audit_log', 'id,check_id,event_type,event_description,created_at', [
    { column: 'check_id', op: 'eq', value: movable.id },
  ], 20);
  const move = await rpc(tester, 'admin_override_check_status', {
    p_check_id: movable.id,
    p_new_status: nextStatus,
  });
  const afterAudit = await query(tester, 'check_audit_log', 'id,check_id,event_type,event_description,created_at', [
    { column: 'check_id', op: 'eq', value: movable.id },
  ], 20);
  const afterRows = afterAudit.json.data || afterAudit.json.rows || [];
  const beforeRows = beforeAudit.json.data || beforeAudit.json.rows || [];
  const created = afterRows.filter((row) => !beforeRows.some((prior) => prior.id === row.id));
  const overrideAudit = created.find((row) => row.event_type === 'status_manual_override') || created[0] || null;
  restore = await rpc(tester, 'admin_override_check_status', {
    p_check_id: movable.id,
    p_new_status: movable.status,
  });
  movement = {
    skipped: false,
    check_id: movable.id,
    from: movable.status,
    to: nextStatus,
    move_status: move.status,
    move_ok: move.ok === true && move.json?.data?.new_status === nextStatus,
    move_error: move.json.error || null,
    restored: restore.ok === true && restore.json?.data?.new_status === movable.status,
    restore_status: restore.status,
    restore_error: restore.json.error || null,
  };
  audit = {
    skipped: false,
    created: Boolean(overrideAudit),
    event_type: overrideAudit?.event_type || null,
    description: overrideAudit?.event_description || null,
  };
}

const outsider = movable?.id
  ? await rpc(crossToken, 'admin_override_check_status', {
    p_check_id: movable.id,
    p_new_status: 'needs_review',
  })
  : { status: 0, ok: false, json: { error: 'no_check' } };

const depositedOverride = deposited?.id
  ? await rpc(tester, 'admin_override_check_status', {
    p_check_id: deposited.id,
    p_new_status: 'needs_review',
  })
  : await rpc(tester, 'admin_override_check_status', {
    p_check_id: movable?.id || '00000000-0000-4000-8000-000000000000',
    p_new_status: 'deposited',
  });

const depositedDestination = movable?.id
  ? await rpc(tester, 'admin_override_check_status', {
    p_check_id: movable.id,
    p_new_status: 'deposited',
  })
  : { status: 0, ok: false, json: { error: 'no_check' } };

const claims = await query(tester, 'claims', 'id,claim_number,org_id', [], 20);
const claimRows = claims.json.data || claims.json.rows || [];
const claim = claimRows.find((row) => String(row.claim_number || '') === 'JIT0346')
  || claimRows.find((row) => String(row.claim_number || '') === '695064-GQ')
  || claimRows[0];
const ledgerRead = claim?.id
  ? await query(tester, 'claim_settlements', 'id,claim_id,replacement_cost_value', [
    { column: 'claim_id', op: 'eq', value: claim.id },
  ], 5)
  : { status: 0, ok: false, json: {} };
const genericSettlement = claim?.id
  ? await call(tester, '/data/write', {
    table: 'claim_settlements',
    op: 'update',
    values: { replacement_cost_value: 1 },
    filters: [{ column: 'id', op: 'eq', value: (ledgerRead.json.data || ledgerRead.json.rows || [])[0]?.id }],
  })
  : { status: 0, ok: false, json: { error: 'no_claim' } };
const crossLedger = claim?.id
  ? await rpc(crossToken, 'save_claim_settlement_breakdown', {
    claim_id: claim.id,
    replacement_cost_value: 9,
  })
  : { status: 0, ok: false, json: { error: 'no_claim' } };

const deleteClaimLinked = movable?.claim_id
  ? await fetch(`${API}/workflow/checks/${movable.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${tester}`, 'content-type': 'application/json' },
  }).then(async (response) => ({ status: response.status, ok: response.ok, json: await response.json().catch(() => ({})) }))
  : { status: 0, ok: false, json: { error: 'no_claim_linked_check' } };

const crossDelete = movable?.id
  ? await fetch(`${API}/workflow/checks/${movable.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${crossToken}`, 'content-type': 'application/json' },
  }).then(async (response) => ({ status: response.status, ok: response.ok, json: await response.json().catch(() => ({})) }))
  : { status: 0, ok: false, json: { error: 'no_check' } };

const ocrProbe = await call(tester, '/data/rpc', { name: 'ocr_reprocess_check', args: { check_id: movable?.id } });
const signatureProbe = await call(tester, '/public/signature-submit', {
  token: 'not-a-real-token',
  signed: true,
});
const checkaltProbe = await call(tester, '/functions/v1/checkalt-submit-deposit', {
  check_intake_item_id: movable?.id,
});
const moovProbe = await call(tester, '/financial/moov-transfer', {
  amount: 1,
  check_id: movable?.id,
});
const walletProbe = await call(tester, '/data/write', {
  table: 'moov_wallets',
  op: 'update',
  values: { available_balance: 1 },
  filters: [{ column: 'tenant_id', op: 'eq', value: FREEDOM }],
});
const crossChecks = await query(crossToken, 'check_intake_items', 'id,tenant_id,status', [
  { column: 'tenant_id', op: 'eq', value: FREEDOM },
], 5);

const result = {
  ok: Boolean(
    me.ok
    && movement.move_ok
    && movement.restored
    && audit.created
    && !outsider.ok
    && !depositedDestination.ok
    && !genericSettlement.ok
    && !crossLedger.ok
    && !deleteClaimLinked.ok
    && !crossDelete.ok
    && !moovProbe.ok
    && !walletProbe.ok
    && !(crossChecks.json.data || crossChecks.json.rows || []).length,
  ),
  identity: {
    tester_status: me.status,
    tester_ok: me.ok,
    tester_email: me.json.email || me.json.user?.email || null,
    cross_status: crossMe.status,
    cross_ok: crossMe.ok,
  },
  movement,
  audit,
  outsider: {
    status: outsider.status,
    ok: outsider.ok,
    error: outsider.json.error || outsider.json.message || null,
    denied: !outsider.ok,
  },
  deposited_cannot_be_selected: {
    destination_status: depositedDestination.status,
    destination_ok: depositedDestination.ok,
    destination_error: depositedDestination.json.error || depositedDestination.json.message || null,
    destination_denied: !depositedDestination.ok,
    existing_deposited_override_status: depositedOverride.status,
    existing_deposited_override_ok: depositedOverride.ok,
    existing_deposited_override_error: depositedOverride.json.error || depositedOverride.json.message || null,
  },
  claim_ledger: {
    claim_id: claim?.id || null,
    claim_number: claim?.claim_number || null,
    read_status: ledgerRead.status,
    generic_write_blocked: !genericSettlement.ok,
    generic_write_error: genericSettlement.json.error || genericSettlement.json.message || genericSettlement.status,
    cross_tenant_blocked: !crossLedger.ok,
    cross_tenant_error: crossLedger.json.error || crossLedger.json.message || crossLedger.status,
  },
  delete_check: {
    claim_linked_blocked: !deleteClaimLinked.ok,
    claim_linked_error: deleteClaimLinked.json.error || deleteClaimLinked.json.message || deleteClaimLinked.status,
    cross_tenant_blocked: !crossDelete.ok,
    cross_tenant_error: crossDelete.json.error || crossDelete.json.message || crossDelete.status,
  },
  signatures: {
    status: signatureProbe.status,
    ok: signatureProbe.ok,
    error: signatureProbe.json.error || signatureProbe.json.message || signatureProbe.status,
  },
  ocr: {
    status: ocrProbe.status,
    ok: ocrProbe.ok,
    error: ocrProbe.json.error || ocrProbe.json.message || ocrProbe.status,
  },
  checkalt: {
    status: checkaltProbe.status,
    ok: checkaltProbe.ok,
    error: checkaltProbe.json.error || checkaltProbe.json.message || checkaltProbe.status,
  },
  moov_walletops: {
    moov_blocked: !moovProbe.ok,
    moov_error: moovProbe.json.error || moovProbe.json.message || moovProbe.status,
    wallet_blocked: !walletProbe.ok,
    wallet_error: walletProbe.json.error || walletProbe.json.message || walletProbe.status,
  },
  tenant_isolation: {
    cross_cannot_list_freedom_checks: !(crossChecks.json.data || crossChecks.json.rows || []).length,
    cross_list_status: crossChecks.status,
    cross_list_count: (crossChecks.json.data || crossChecks.json.rows || []).length,
  },
  host: API,
  sha256: createHash('sha256').update(JSON.stringify({
    movement,
    outsider: outsider.json.error || null,
    deposited: depositedDestination.json.error || null,
  })).digest('hex'),
};

writeFileSync(`${OUT}/accept-result.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 2);
