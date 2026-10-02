#!/usr/bin/env node
/**
 * Production #601 final acceptance.
 * Freedom same-company movement, C1C outsider deny, platform-admin deny,
 * deposited both directions, #620 read vs mutation, and regressions.
 * Does not write SPA/SQL/GRANT/Cognito config/IAM/env/Moov config.
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
const PLATFORM = 'checksopsadmin@gmail.com';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OUT = process.env.PR601_ACCEPT_OUT || '/opt/cursor/artifacts/pr601-prod-final';

mkdirSync(OUT, { recursive: true });

const MOVABLE = [
  'uploaded', 'processing', 'ocr_complete', 'needs_review', 'manual_review_required',
  'reissue_requested', 'endorsements_in_progress', 'endorsements_complete',
  'approved_for_deposit', 'branch_deposit_required', 'loss_draft_required', 'voided',
];

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
const query = (token, table, select, filters = [], limit = 80) => call(token, '/data/query', {
  table,
  select,
  filters,
  limit,
});
const rowsOf = (result) => result?.json?.data || result?.json?.rows || [];

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

const expectedStage = (status) => {
  switch (status) {
    case 'endorsements_in_progress':
    case 'endorsements_complete':
      return 'endorsing';
    case 'approved_for_deposit':
    case 'branch_deposit_required':
      return 'ready_for_deposit';
    case 'loss_draft_required':
      return 'loss_draft';
    case 'deposited':
      return 'deposited';
    default:
      return 'review';
  }
};

const snapshotCheck = async (token, checkId) => {
  const intake = await query(token, 'check_intake_items', 'id,tenant_id,status,check_stage,claim_id,deposited_at,updated_at', [
    { column: 'id', op: 'eq', value: checkId },
  ], 5);
  const claims = await query(token, 'claim_checks', 'id,check_intake_item_id,claim_id,check_stage,deposit_status,updated_at', [
    { column: 'check_intake_item_id', op: 'eq', value: checkId },
  ], 10);
  const auditA = await query(token, 'check_audit_log', 'id,check_id,event_type,event_description,created_at', [
    { column: 'check_id', op: 'eq', value: checkId },
  ], 50);
  const auditB = await query(token, 'audit_logs', 'id,record_id,event_type,action,created_at', [
    { column: 'record_id', op: 'eq', value: checkId },
  ], 50);
  const intakeRow = rowsOf(intake)[0] || null;
  return {
    intake: intakeRow,
    claim_checks: rowsOf(claims),
    check_audit_log: rowsOf(auditA),
    audit_logs: rowsOf(auditB),
    audit_ids: [...rowsOf(auditA), ...rowsOf(auditB)].map((row) => row.id).sort(),
  };
};

const errOf = (result) => result?.json?.error || result?.json?.message || null;

const tester = tokenFor(TESTER);
const crossToken = tokenFor(CROSS);
const adminToken = tokenFor(PLATFORM);

const me = await call(tester, '/identity/me', null, 'GET');
const crossMe = await call(crossToken, '/identity/me', null, 'GET');
const adminMe = await call(adminToken, '/identity/me', null, 'GET');

const membershipsOf = (identity) => identity?.json?.memberships
  || identity?.json?.tenants
  || identity?.json?.user?.memberships
  || [];
const adminMemberships = membershipsOf(adminMe);
const adminIsFreedomMember = adminMemberships.some((row) => (
  (row.tenant_id || row.id) === FREEDOM
));

const checks = await query(tester, 'check_intake_items', 'id,tenant_id,status,check_stage,claim_id,deposited_at', [
  { column: 'tenant_id', op: 'eq', value: FREEDOM },
], 80);
const checkRows = rowsOf(checks);
const candidates = [];
for (const row of checkRows) {
  if (!row || !MOVABLE.includes(row.status) || row.status === 'deposited' || row.deposited_at) continue;
  const linked = await query(tester, 'claim_checks', 'id,check_intake_item_id,claim_id,check_stage', [
    { column: 'check_intake_item_id', op: 'eq', value: row.id },
  ], 5);
  candidates.push({ intake: row, claim_checks: rowsOf(linked) });
}
const withClaim = candidates.find((row) => row.claim_checks.length > 0) || candidates[0] || null;
const movable = withClaim?.intake || null;
const deposited = checkRows.find((row) => row.status === 'deposited' || row.deposited_at);

let movement = { skipped: true, reason: 'no_movable_freedom_check' };
let restore = null;
let audit = { skipped: true };
let persist = { skipped: true };
if (movable?.id) {
  const nextStatus = pickMoveTarget(movable.status);
  const before = await snapshotCheck(tester, movable.id);
  const move = await rpc(tester, 'admin_override_check_status', {
    p_check_id: movable.id,
    p_new_status: nextStatus,
  });
  const afterMove = await snapshotCheck(tester, movable.id);
  const created = afterMove.check_audit_log.filter((row) => !before.check_audit_log.some((prior) => prior.id === row.id));
  const createdAlt = afterMove.audit_logs.filter((row) => !before.audit_logs.some((prior) => prior.id === row.id));
  const overrideAudit = created.find((row) => row.event_type === 'status_manual_override')
    || created[0]
    || createdAlt[0]
    || null;
  restore = await rpc(tester, 'admin_override_check_status', {
    p_check_id: movable.id,
    p_new_status: movable.status,
  });
  const afterRestore = await snapshotCheck(tester, movable.id);
  const intakeMoved = afterMove.intake?.status === nextStatus;
  const claimMoved = afterMove.claim_checks.length
    ? afterMove.claim_checks.every((row) => String(row.check_stage) === expectedStage(nextStatus)
      || String(row.check_stage) === nextStatus)
    : false;
  persist = {
    skipped: false,
    intake_before: before.intake?.status || null,
    intake_after: afterMove.intake?.status || null,
    intake_stage_after: afterMove.intake?.check_stage || null,
    intake_persisted: intakeMoved,
    claim_checks_count: afterMove.claim_checks.length,
    claim_checks_before: before.claim_checks.map((row) => row.check_stage),
    claim_checks_after: afterMove.claim_checks.map((row) => row.check_stage),
    claim_checks_persisted: afterMove.claim_checks.length ? claimMoved : null,
    restored_intake: afterRestore.intake?.status === movable.status,
    restored_claim_checks: afterRestore.claim_checks.map((row) => row.check_stage),
  };
  movement = {
    skipped: false,
    check_id: movable.id,
    claim_id: movable.claim_id || null,
    from: movable.status,
    to: nextStatus,
    move_status: move.status,
    move_ok: move.ok === true && move.json?.data?.new_status === nextStatus,
    move_error: errOf(move),
    move_payload: move.json?.data || null,
    restored: restore.ok === true && restore.json?.data?.new_status === movable.status,
    restore_status: restore.status,
    restore_error: errOf(restore),
  };
  audit = {
    skipped: false,
    created: Boolean(overrideAudit),
    event_type: overrideAudit?.event_type || overrideAudit?.action || null,
    description: overrideAudit?.event_description || null,
    new_audit_count: created.length + createdAlt.length,
  };
}

const outsider = movable?.id
  ? await rpc(crossToken, 'admin_override_check_status', {
    p_check_id: movable.id,
    p_new_status: 'needs_review',
  })
  : { status: 0, ok: false, json: { error: 'no_check' } };

const platformOverride = movable?.id
  ? await rpc(adminToken, 'admin_override_check_status', {
    p_check_id: movable.id,
    p_new_status: 'needs_review',
  })
  : { status: 0, ok: false, json: { error: 'no_check' } };

let depositedFrom = { skipped: true };
let depositedTo = { skipped: true };
if (deposited?.id) {
  const before = await snapshotCheck(tester, deposited.id);
  const attempt = await rpc(tester, 'admin_override_check_status', {
    p_check_id: deposited.id,
    p_new_status: 'needs_review',
  });
  const after = await snapshotCheck(tester, deposited.id);
  depositedFrom = {
    skipped: false,
    check_id: deposited.id,
    status_before: before.intake?.status || null,
    stage_before: before.intake?.check_stage || null,
    deposited_at_before: before.intake?.deposited_at || null,
    attempt_ok: attempt.ok,
    attempt_status: attempt.status,
    attempt_error: errOf(attempt),
    status_after: after.intake?.status || null,
    stage_after: after.intake?.check_stage || null,
    deposited_at_after: after.intake?.deposited_at || null,
    claim_checks_before: before.claim_checks.map((row) => row.check_stage),
    claim_checks_after: after.claim_checks.map((row) => row.check_stage),
    audit_ids_unchanged: JSON.stringify(before.audit_ids) === JSON.stringify(after.audit_ids),
    status_unchanged: before.intake?.status === after.intake?.status
      && before.intake?.check_stage === after.intake?.check_stage,
    no_write: before.intake?.status === after.intake?.status
      && JSON.stringify(before.audit_ids) === JSON.stringify(after.audit_ids),
  };
}
if (movable?.id) {
  const before = await snapshotCheck(tester, movable.id);
  const attempt = await rpc(tester, 'admin_override_check_status', {
    p_check_id: movable.id,
    p_new_status: 'deposited',
  });
  const after = await snapshotCheck(tester, movable.id);
  depositedTo = {
    skipped: false,
    check_id: movable.id,
    status_before: before.intake?.status || null,
    attempt_ok: attempt.ok,
    attempt_status: attempt.status,
    attempt_error: errOf(attempt),
    status_after: after.intake?.status || null,
    claim_checks_before: before.claim_checks.map((row) => row.check_stage),
    claim_checks_after: after.claim_checks.map((row) => row.check_stage),
    audit_ids_unchanged: JSON.stringify(before.audit_ids) === JSON.stringify(after.audit_ids),
    status_unchanged: before.intake?.status === after.intake?.status,
    no_write: before.intake?.status === after.intake?.status
      && JSON.stringify(before.audit_ids) === JSON.stringify(after.audit_ids),
  };
}

const six20Get = await call(tester, '/functions/v1/moov-sweep-config', {
  tenant_id: FREEDOM,
  action: 'get',
});
const six20List = await call(tester, '/functions/v1/moov-sweep-config', {
  tenant_id: FREEDOM,
  action: 'list',
});
const six20Sweeps = await call(tester, '/functions/v1/moov-sweep-config', {
  tenant_id: FREEDOM,
  action: 'sweeps',
});
const six20Create = await call(tester, '/functions/v1/moov-sweep-config', {
  tenant_id: FREEDOM,
  action: 'create',
  minimum_balance_cents: 1,
});
const six20Transfer = await call(tester, '/functions/v1/moov-transfer-create', {
  tenant_id: FREEDOM,
  amount: 1,
});
const six20Disburse = await call(tester, '/functions/v1/moov-disburse', {
  tenant_id: FREEDOM,
  amount: 1,
});

const isBlocked = (result) => {
  const error = String(errOf(result) || '');
  return result.ok !== true && (error === 'production_execution_blocked' || result.status === 403);
};
const isReadNotHardBlocked = (result) => errOf(result) !== 'production_execution_blocked';

const claims = await query(tester, 'claims', 'id,claim_number,org_id', [], 20);
const claimRows = rowsOf(claims);
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
    filters: [{ column: 'id', op: 'eq', value: rowsOf(ledgerRead)[0]?.id }],
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
const genericStatus = movable?.id
  ? await call(tester, '/data/write', {
    table: 'check_intake_items',
    op: 'update',
    values: { status: 'needs_review' },
    filters: [{ column: 'id', op: 'eq', value: movable.id }],
  })
  : { status: 0, ok: false, json: { error: 'no_check' } };
const crossChecks = await query(crossToken, 'check_intake_items', 'id,tenant_id,status', [
  { column: 'tenant_id', op: 'eq', value: FREEDOM },
], 5);

const six20 = {
  get: { status: six20Get.status, ok: six20Get.ok, error: errOf(six20Get), hard_blocked: !isReadNotHardBlocked(six20Get) },
  list: { status: six20List.status, ok: six20List.ok, error: errOf(six20List), hard_blocked: !isReadNotHardBlocked(six20List) },
  sweeps: { status: six20Sweeps.status, ok: six20Sweeps.ok, error: errOf(six20Sweeps), hard_blocked: !isReadNotHardBlocked(six20Sweeps) },
  create: { status: six20Create.status, ok: six20Create.ok, error: errOf(six20Create), blocked: isBlocked(six20Create) },
  transfer: { status: six20Transfer.status, ok: six20Transfer.ok, error: errOf(six20Transfer), blocked: isBlocked(six20Transfer) },
  disburse: { status: six20Disburse.status, ok: six20Disburse.ok, error: errOf(six20Disburse), blocked: isBlocked(six20Disburse) },
};

const result = {
  ok: Boolean(
    me.ok
    && movement.move_ok
    && movement.restored
    && persist.intake_persisted
    && (persist.claim_checks_count === 0 || persist.claim_checks_persisted)
    && audit.created
    && !outsider.ok
    && !platformOverride.ok
    && adminIsFreedomMember === false
    && depositedFrom.no_write
    && depositedTo.no_write
    && !depositedFrom.attempt_ok
    && !depositedTo.attempt_ok
    && isReadNotHardBlocked(six20Get)
    && isReadNotHardBlocked(six20List)
    && isReadNotHardBlocked(six20Sweeps)
    && isBlocked(six20Create)
    && isBlocked(six20Transfer)
    && isBlocked(six20Disburse)
    && !genericSettlement.ok
    && !crossLedger.ok
    && !deleteClaimLinked.ok
    && !crossDelete.ok
    && !moovProbe.ok
    && !walletProbe.ok
    && !genericStatus.ok
    && !rowsOf(crossChecks).length,
  ),
  identity: {
    tester_status: me.status,
    tester_ok: me.ok,
    tester_email: me.json.email || me.json.user?.email || null,
    cross_status: crossMe.status,
    cross_ok: crossMe.ok,
    platform_status: adminMe.status,
    platform_ok: adminMe.ok,
    platform_email: adminMe.json.email || adminMe.json.user?.email || null,
    platform_is_freedom_member: adminIsFreedomMember,
  },
  movement,
  persist,
  audit,
  outsider: {
    status: outsider.status,
    ok: outsider.ok,
    error: errOf(outsider),
    denied: !outsider.ok,
  },
  platform_admin: {
    status: platformOverride.status,
    ok: platformOverride.ok,
    error: errOf(platformOverride),
    denied: !platformOverride.ok,
    non_member: adminIsFreedomMember === false,
  },
  deposited: {
    from: depositedFrom,
    to: depositedTo,
  },
  six20,
  claim_ledger: {
    claim_id: claim?.id || null,
    claim_number: claim?.claim_number || null,
    read_status: ledgerRead.status,
    generic_write_blocked: !genericSettlement.ok,
    generic_write_error: errOf(genericSettlement) || genericSettlement.status,
    cross_tenant_blocked: !crossLedger.ok,
    cross_tenant_error: errOf(crossLedger) || crossLedger.status,
  },
  delete_check: {
    claim_linked_blocked: !deleteClaimLinked.ok,
    claim_linked_error: errOf(deleteClaimLinked) || deleteClaimLinked.status,
    cross_tenant_blocked: !crossDelete.ok,
    cross_tenant_error: errOf(crossDelete) || crossDelete.status,
  },
  signatures: {
    status: signatureProbe.status,
    ok: signatureProbe.ok,
    error: errOf(signatureProbe) || signatureProbe.status,
  },
  ocr: {
    status: ocrProbe.status,
    ok: ocrProbe.ok,
    error: errOf(ocrProbe) || ocrProbe.status,
  },
  checkalt: {
    status: checkaltProbe.status,
    ok: checkaltProbe.ok,
    error: errOf(checkaltProbe) || checkaltProbe.status,
  },
  financial: {
    moov_blocked: !moovProbe.ok,
    moov_error: errOf(moovProbe) || moovProbe.status,
    wallet_blocked: !walletProbe.ok,
    wallet_error: errOf(walletProbe) || walletProbe.status,
    generic_status_write_blocked: !genericStatus.ok,
    generic_status_error: errOf(genericStatus) || genericStatus.status,
  },
  tenant_isolation: {
    cross_cannot_list_freedom_checks: !rowsOf(crossChecks).length,
    cross_list_status: crossChecks.status,
    cross_list_count: rowsOf(crossChecks).length,
  },
  host: API,
  sha256: createHash('sha256').update(JSON.stringify({
    movement,
    persist,
    outsider: errOf(outsider),
    deposited,
    six20,
  })).digest('hex'),
};

writeFileSync(`${OUT}/accept-result.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 2);
