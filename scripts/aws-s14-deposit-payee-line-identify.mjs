#!/usr/bin/env node
/**
 * Staging-only S14 deposit payee_line identification.
 * Synthetic sandbox records. No live CheckAlt/Moov. No production writes.
 * Does not implement a remediation.
 */
import fs from 'node:fs';

const API = process.env.CHECKSOPS_API_URL || 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const tokens = JSON.parse(fs.readFileSync(process.env.STAGING_TOKEN_FILE || '/tmp/checksops-staging-tokens.json', 'utf8'));
const freedom = tokens.freedom;
const RUN_ID = `S14ID-${Date.now()}`;
const MARKER = `AWS S14 IDENTIFY ${RUN_ID}`;
const ORIGINAL_PAYEE = 'S14 Original Payee Line';
const PRE_DEPOSIT_PAYEE = 'S14 Pre-Deposit Rewrite';
const POST_DEPOSIT_PAYEE = 'S14 Rewritten After Deposit';
const OCR_PAYEE = 'S14 OCR Rewrite Attempt';
const CLAIM_MIRROR_PAYEE = 'S14 Claim Checks Mirror';
const STRUCTURED_PAYEE = 'S14 Structured Insured';
const OUT = '/opt/cursor/artifacts/s14-deposit-payee-line-identify.json';

const results = [];
const evidence = {
  runId: RUN_ID,
  marker: MARKER,
  originalPayee: ORIGINAL_PAYEE,
  attempts: [],
};
const record = (name, ok, extra = {}) => {
  const row = { name, ok, ...extra };
  results.push(row);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra.detail ? ` — ${extra.detail}` : ''}`);
  return row;
};

const api = async (path, { method = 'POST', token = freedom, body, headers: extra } = {}) => {
  const headers = { 'content-type': 'application/json', ...(extra || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = {};
  try { json = await response.json(); } catch { json = {}; }
  return { status: response.status, json };
};

const write = (body) => api('/data/write', { body });
const query = (body) => api('/data/query', { body });
const rpc = (name, args = {}) => api('/data/rpc', { body: { name, args } });
const rowOf = (payload) => (Array.isArray(payload) ? payload[0] : payload);
const rowsOf = (payload) => (Array.isArray(payload) ? payload : (payload ? [payload] : []));

const loadCheck = async (checkId) => {
  const res = await query({
    table: 'check_intake_items',
    select: 'id,tenant_id,status,check_stage,claim_id,amount,payee_line,carrier_name,check_number,funds_type,review_notes,deposited_at,uploaded_by',
    filters: [{ column: 'id', op: 'eq', value: checkId }],
  });
  return rowOf(res.json.data);
};

const loadRelated = async (checkId) => {
  const [payees, endorsements, audit, claimChecks, ops] = await Promise.all([
    query({
      table: 'check_payees',
      select: 'id,check_id,payee_name,payee_type,endorsement_status',
      filters: [{ column: 'check_id', op: 'eq', value: checkId }],
    }),
    query({
      table: 'check_endorsements',
      select: 'id,check_id,payee_id,payee_name,payee_type,status,signed_at',
      filters: [{ column: 'check_id', op: 'eq', value: checkId }],
    }),
    query({
      table: 'check_audit_log',
      select: 'id,check_id,event_type,event_description,created_at',
      filters: [{ column: 'check_id', op: 'eq', value: checkId }],
    }),
    query({
      table: 'claim_checks',
      select: 'id,check_intake_item_id,claim_id,amount,payee_line,check_stage',
      filters: [{ column: 'check_intake_item_id', op: 'eq', value: checkId }],
    }),
    api('/financial/operations', {
      method: 'GET',
      body: undefined,
    }).catch(() => ({ status: 0, json: {} })),
  ]);
  return {
    payees: rowsOf(payees.json.data),
    endorsements: rowsOf(endorsements.json.data),
    audit: rowsOf(audit.json.data),
    claimChecks: rowsOf(claimChecks.json.data),
    opsProbe: { status: ops.status, error: ops.json?.error || null },
  };
};

const snapshot = async (checkId) => {
  const check = await loadCheck(checkId);
  const related = await loadRelated(checkId);
  return {
    payee_line: check?.payee_line || null,
    amount: check?.amount == null ? null : Number(check.amount),
    deposited_at: check?.deposited_at || null,
    status: check?.status || null,
    check_stage: check?.check_stage || null,
    claim_id: check?.claim_id || null,
    payee_names: (related.payees || []).map((row) => row.payee_name).sort(),
    payee_types: (related.payees || []).map((row) => `${row.id}:${row.payee_type}`).sort(),
    endorsement_statuses: (related.endorsements || []).map((row) => `${row.payee_id || row.id}:${row.status}`).sort(),
    claim_check_payee_lines: (related.claimChecks || []).map((row) => row.payee_line).sort(),
    audit_count: (related.audit || []).length,
    audit_types: (related.audit || []).map((row) => row.event_type).sort(),
  };
};

const sameFinancialRelated = (before, after) => (
  Number(before.amount) === Number(after.amount)
  && String(before.deposited_at || '') === String(after.deposited_at || '')
  && String(before.status || '') === String(after.status || '')
  && String(before.check_stage || '') === String(after.check_stage || '')
  && String(before.claim_id || '') === String(after.claim_id || '')
  && JSON.stringify(before.payee_names) === JSON.stringify(after.payee_names)
  && JSON.stringify(before.endorsement_statuses) === JSON.stringify(after.endorsement_statuses)
);

const noteAttempt = (label, http, before, after) => {
  const row = {
    label,
    status: http.status,
    error: http.json?.error || null,
    message: http.json?.message || null,
    payee_before: before?.payee_line || null,
    payee_after: after?.payee_line || null,
    deposited_at_before: before?.deposited_at || null,
    deposited_at_after: after?.deposited_at || null,
    amount_before: before?.amount ?? null,
    amount_after: after?.amount ?? null,
    related_unchanged: before && after ? sameFinancialRelated(before, after) : null,
    payee_changed: Boolean(before && after && String(before.payee_line || '') !== String(after.payee_line || '')),
  };
  evidence.attempts.push(row);
  return row;
};

const confirmOp = async (operationId, eventType, externalEventId) => {
  await api('/financial/simulate-submit', { body: { operation_id: operationId } });
  return api('/financial/simulate-webhook', {
    body: { operation_id: operationId, event_type: eventType, external_event_id: externalEventId },
  });
};

const main = async () => {
  const financial = await api('/financial/status', { method: 'GET', token: null });
  evidence.flags = financial.json;
  record('staging sandbox / non-live provider', financial.status === 200
    && financial.json.liveProviderTransactions === false
    && financial.json.flags?.AWS_PROVIDER_EXECUTION_ENABLED === false
    && financial.json.flags?.AWS_CHECKALT_ENABLED === false
    && financial.json.flags?.AWS_MOOV_TRANSFER_POST_ENABLED === false
    && financial.json.flags?.AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED === true, {
    detail: `exec=${financial.json.flags?.AWS_PROVIDER_EXECUTION_ENABLED} checkalt=${financial.json.flags?.AWS_CHECKALT_ENABLED} sim=${financial.json.flags?.AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED}`,
  });

  const created = await api('/workflow/checks', {
    body: {
      carrier_name: MARKER,
      review_notes: MARKER,
      check_number: `S14${Date.now().toString().slice(-7)}`,
      payee_line: ORIGINAL_PAYEE,
      funds_type: 'acv',
      amount: 123.45,
      property_address: '14 Payee Line Lane',
    },
  });
  const check = rowOf(created.json.data);
  evidence.checkId = check?.id;
  record('synthetic check with known payee_line', Boolean(check?.id) && check?.payee_line === ORIGINAL_PAYEE && Number(check?.amount) === 123.45, {
    detail: `id=${check?.id} payee=${check?.payee_line}`,
  });
  if (!check?.id) throw new Error('no check');

  const payeeInsert = await write({
    table: 'check_payees',
    op: 'insert',
    values: {
      check_id: check.id,
      payee_name: STRUCTURED_PAYEE,
      payee_type: 'insured',
      contact_email: 's14-payee@example.invalid',
    },
    single: true,
  });
  const structured = rowOf(payeeInsert.json.data);
  evidence.payeeId = structured?.id;
  record('structured payee inserted separately from payee_line', Boolean(structured?.id) && structured?.payee_name === STRUCTURED_PAYEE, {
    detail: `id=${structured?.id} name=${structured?.payee_name}`,
  });

  const baseline = await snapshot(check.id);
  evidence.baseline = baseline;
  record('baseline deposited_at is null', baseline.deposited_at == null, {
    detail: `deposited_at=${baseline.deposited_at || 'null'}`,
  });

  const preWrite = await write({
    table: 'check_intake_items',
    op: 'update',
    values: { payee_line: PRE_DEPOSIT_PAYEE },
    filters: [{ column: 'id', op: 'eq', value: check.id }],
    single: true,
  });
  const afterPre = await snapshot(check.id);
  noteAttempt('1 generic /data/write payee_line before deposit', preWrite, baseline, afterPre);
  record('1 before deposit: generic payee_line write allowed', preWrite.status === 200 && afterPre.payee_line === PRE_DEPOSIT_PAYEE, {
    detail: `status=${preWrite.status} payee=${afterPre.payee_line}`,
  });

  const restore = await write({
    table: 'check_intake_items',
    op: 'update',
    values: { payee_line: ORIGINAL_PAYEE },
    filters: [{ column: 'id', op: 'eq', value: check.id }],
    single: true,
  });
  const restored = await snapshot(check.id);
  noteAttempt('restore original payee_line before deposit', restore, afterPre, restored);
  record('original payee_line restored before deposit', restore.status === 200 && restored.payee_line === ORIGINAL_PAYEE, {
    detail: `status=${restore.status} payee=${restored.payee_line}`,
  });

  const deposit = await api('/financial/prepare', {
    body: { operation_type: 'checkalt_deposit', check_id: check.id, marker: MARKER },
  });
  const depositWh = await confirmOp(deposit.json.operation?.id, 'deposit.cleared', `${MARKER}-cleared`);
  evidence.deposit = {
    id: deposit.json.operation?.id,
    cents: deposit.json.operation?.amount_cents,
    status: depositWh.json.operation?.status,
    live: depositWh.json.liveProviderCalled,
    remaining: depositWh.json.remaining || null,
  };
  const afterDeposit = await snapshot(check.id);
  evidence.afterSandboxConfirm = afterDeposit;
  record('sandbox deposit.cleared confirms without live provider', deposit.json.operation?.amount_cents === 12345
    && depositWh.json.operation?.status === 'provider_confirmed'
    && depositWh.json.liveProviderCalled === false, {
    detail: `op=${deposit.json.operation?.id} status=${depositWh.json.operation?.status} live=${depositWh.json.liveProviderCalled}`,
  });
  record('sandbox confirm does not set deposited_at', afterDeposit.deposited_at == null && afterDeposit.payee_line === ORIGINAL_PAYEE, {
    detail: `deposited_at=${afterDeposit.deposited_at || 'null'} payee=${afterDeposit.payee_line}`,
  });

  const amountEdit = await write({
    table: 'check_intake_items',
    op: 'update',
    values: { amount: 1.00 },
    filters: [{ column: 'id', op: 'eq', value: check.id }],
    single: true,
  });
  const afterAmount = await snapshot(check.id);
  noteAttempt('amount write after sandbox confirm', amountEdit, afterDeposit, afterAmount);
  record('amount remains locked after sandbox confirm', amountEdit.status >= 400 && afterAmount.amount === 123.45, {
    detail: `status=${amountEdit.status} error=${amountEdit.json.error} amount=${afterAmount.amount}`,
  });

  const depositedAtWrite = await write({
    table: 'check_intake_items',
    op: 'update',
    values: { deposited_at: new Date().toISOString() },
    filters: [{ column: 'id', op: 'eq', value: check.id }],
    single: true,
  });
  const afterDepositedWrite = await snapshot(check.id);
  noteAttempt('generic deposited_at write', depositedAtWrite, afterAmount, afterDepositedWrite);
  record('generic deposited_at write denied', depositedAtWrite.status >= 400 && afterDepositedWrite.deposited_at == null, {
    detail: `status=${depositedAtWrite.status} error=${depositedAtWrite.json.error}`,
  });

  const postWrite = await write({
    table: 'check_intake_items',
    op: 'update',
    values: { payee_line: POST_DEPOSIT_PAYEE },
    filters: [{ column: 'id', op: 'eq', value: check.id }],
    single: true,
  });
  const afterPost = await snapshot(check.id);
  const postAttempt = noteAttempt('2 generic /data/write payee_line after sandbox confirm', postWrite, afterDepositedWrite, afterPost);
  evidence.postDepositGenericWrite = postAttempt;
  record('2 after confirmed sandbox deposit: payee_line still writable', postWrite.status === 200 && afterPost.payee_line === POST_DEPOSIT_PAYEE, {
    detail: `status=${postWrite.status} payee=${afterPost.payee_line} deposited_at=${afterPost.deposited_at || 'null'}`,
  });

  const restoreAfter = await write({
    table: 'check_intake_items',
    op: 'update',
    values: { payee_line: ORIGINAL_PAYEE },
    filters: [{ column: 'id', op: 'eq', value: check.id }],
    single: true,
  });
  const lockedOriginal = await snapshot(check.id);
  noteAttempt('restore original after proving post-deposit write', restoreAfter, afterPost, lockedOriginal);

  const markDeposited = await api('/workflow/transition', {
    body: { check_id: check.id, action: 'mark_deposited' },
  });
  const afterMark = await snapshot(check.id);
  noteAttempt('3 mark_deposited transition', markDeposited, lockedOriginal, afterMark);
  record('3 mark_deposited denied and does not set deposited_at', markDeposited.status >= 400
    && afterMark.deposited_at == null
    && afterMark.payee_line === ORIGINAL_PAYEE
    && sameFinancialRelated(lockedOriginal, afterMark), {
    detail: `status=${markDeposited.status} error=${markDeposited.json.error}`,
  });

  const override = await rpc('admin_override_check_status', {
    p_check_id: check.id,
    p_status: 'deposited',
  });
  const afterOverride = await snapshot(check.id);
  noteAttempt('3 admin_override_check_status deposited', override, afterMark, afterOverride);
  record('3 admin_override_check_status remains disabled', override.status >= 400
    && (override.json.error === 'rpc_disabled' || override.json.error === 'rpc_financial_disabled')
    && afterOverride.deposited_at == null
    && afterOverride.payee_line === ORIGINAL_PAYEE, {
    detail: `status=${override.status} error=${override.json.error}`,
  });

  const setClaim = await rpc('admin_set_check_claim', { p_check_id: check.id, p_claim_id: null });
  const afterClaim = await snapshot(check.id);
  noteAttempt('3 admin_set_check_claim', setClaim, afterOverride, afterClaim);
  record('3 admin_set_check_claim does not rewrite payee_line', afterClaim.payee_line === ORIGINAL_PAYEE, {
    detail: `status=${setClaim.status} error=${setClaim.json.error || 'none'} payee=${afterClaim.payee_line}`,
  });

  const depositAction = await rpc('deposit_action', {
    p_action: 'submit_checkalt',
    p_check_id: check.id,
  });
  const afterDepositAction = await snapshot(check.id);
  noteAttempt('3 deposit_action submit_checkalt', depositAction, afterClaim, afterDepositAction);
  record('3 deposit_action money action denied', depositAction.status >= 400
    && afterDepositAction.payee_line === ORIGINAL_PAYEE
    && afterDepositAction.deposited_at == null, {
    detail: `status=${depositAction.status} error=${depositAction.json.error}`,
  });

  const claimWrite = await write({
    table: 'claim_checks',
    op: 'update',
    values: { payee_line: CLAIM_MIRROR_PAYEE },
    filters: [{ column: 'check_intake_item_id', op: 'eq', value: check.id }],
    single: true,
  });
  const afterClaimWrite = await snapshot(check.id);
  noteAttempt('4 claim_checks.payee_line write', claimWrite, afterDepositAction, afterClaimWrite);
  record('4 claim_checks mirror write does not change intake payee_line', afterClaimWrite.payee_line === ORIGINAL_PAYEE, {
    detail: `status=${claimWrite.status} error=${claimWrite.json.error || 'none'} intake=${afterClaimWrite.payee_line} mirrors=${JSON.stringify(afterClaimWrite.claim_check_payee_lines)}`,
  });

  const ocr = await api('/functions/v1/check-ocr-intake', {
    body: { check_id: check.id, checkId: check.id },
  });
  const afterOcr = await snapshot(check.id);
  noteAttempt('5 check-ocr-intake', ocr, afterClaimWrite, afterOcr);
  evidence.ocr = {
    status: ocr.status,
    error: ocr.json?.error || null,
    engine: ocr.json?.engine || ocr.json?.descriptive_engine || null,
    parsed_payee: ocr.json?.descriptive?.payee_line || ocr.json?.parsed?.payee_line || null,
    rpc_success: ocr.json?.rpc_success ?? ocr.json?.rpcSuccess ?? null,
  };
  record('5 OCR path reachable or denied without live provider money', ocr.status !== 0, {
    detail: `status=${ocr.status} error=${ocr.json.error || 'none'} engine=${evidence.ocr.engine || 'none'} payee=${afterOcr.payee_line}`,
  });

  const ingest = await api('/functions/v1/ingest-shared-check', {
    body: {
      source_check_id: check.id,
      check: { payee_line: 'S14 Ingest Rewrite', amount: 123.45 },
    },
  });
  const afterIngest = await snapshot(check.id);
  noteAttempt('5 ingest-shared-check without bridge secret', ingest, afterOcr, afterIngest);
  record('5 ingest-shared-check is not a generic operator bypass', ingest.status >= 400
    && afterIngest.payee_line === afterOcr.payee_line, {
    detail: `status=${ingest.status} error=${ingest.json.error} payee=${afterIngest.payee_line}`,
  });

  const replay = await api('/financial/prepare', {
    body: { operation_type: 'checkalt_deposit', check_id: check.id, marker: MARKER },
  });
  evidence.replay = {
    id: replay.json.operation?.id,
    cents: replay.json.operation?.amount_cents,
    duplicate: replay.json.duplicate,
  };
  record('financial history not rewritten', replay.json.operation?.id === deposit.json.operation?.id
    && replay.json.operation?.amount_cents === 12345
    && replay.json.duplicate === true, {
    detail: `op=${replay.json.operation?.id} cents=${replay.json.operation?.amount_cents} dup=${replay.json.duplicate}`,
  });

  const liveDeposit = await api('/functions/v1/checkalt-submit-deposit', {
    body: { check_id: check.id },
  });
  record('live CheckAlt remains blocked', liveDeposit.status === 403 && /checkalt|blocked|provider/i.test(JSON.stringify(liveDeposit.json)), {
    detail: `status=${liveDeposit.status} error=${liveDeposit.json.error || liveDeposit.json.message}`,
  });

  const finalSnap = await snapshot(check.id);
  evidence.final = finalSnap;
  evidence.writableAfterConfirmedDeposit = evidence.attempts.some((row) => (
    row.label.includes('after sandbox confirm') && row.status === 200 && row.payee_changed
  ));
  evidence.depositedAtEstablished = Boolean(finalSnap.deposited_at);
  evidence.intakePayeeAfterConfirmedOp = finalSnap.payee_line;

  const del = await api(`/workflow/checks/${check.id}`, {
    method: 'DELETE',
    body: { check_id: check.id, reason: `${MARKER} synthetic cleanup` },
  });
  const gone = await loadCheck(check.id);
  evidence.cleanup = { deleteStatus: del.status, readable: Boolean(gone?.id), error: del.json.error || null };
  if (gone?.id) {
    await api(`/workflow/checks/${check.id}`, {
      method: 'DELETE',
      body: { check_id: check.id, reason: `${MARKER} leftover` },
    }).catch(() => {});
  }
  await api('/financial/cleanup', { body: { marker: MARKER } });
  record('synthetic cleanup', !gone?.id || del.json.cleanedUp === true || del.json.data?.deleted === true || del.status === 200, {
    detail: `status=${del.status} readable=${Boolean(gone?.id)}`,
  });

  const report = {
    runId: RUN_ID,
    marker: MARKER,
    api: API,
    productionUntouched: true,
    evidence,
    results,
    passed: results.filter((row) => row.ok).length,
    failed: results.filter((row) => !row.ok).length,
  };
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    ok: results.every((row) => row.ok),
    passed: report.passed,
    failed: report.failed,
    checkId: evidence.checkId,
    writableAfterConfirmedDeposit: evidence.writableAfterConfirmedDeposit,
    depositedAtEstablished: evidence.depositedAtEstablished,
    out: OUT,
  }, null, 2));
};

main().catch((error) => {
  console.error(error);
  try {
    fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ error: String(error?.message || error), results, evidence }, null, 2));
  } catch { /* ignore */ }
  process.exit(1);
});
