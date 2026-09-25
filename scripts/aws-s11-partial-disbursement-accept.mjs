#!/usr/bin/env node
/**
 * Staging-only S11 remaining-balance acceptance.
 * Synthetic sandbox records. No live Moov/CheckAlt. No production writes.
 */
import fs from 'node:fs';

const API = process.env.CHECKSOPS_API_URL || 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const tokens = JSON.parse(fs.readFileSync(process.env.STAGING_TOKEN_FILE || '/tmp/checksops-staging-tokens.json', 'utf8'));
const freedom = tokens.freedom;
const RUN_ID = `S11ACC-${Date.now()}`;
const MARKER = `AWS S11 ACCEPT ${RUN_ID}`;
const OUT = '/opt/cursor/artifacts/s11-partial-disbursement-accept.json';

const results = [];
const evidence = { ops: [] };
const record = (name, ok, extra = {}) => {
  const row = { name, ok, ...extra };
  results.push(row);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra.detail ? ` — ${extra.detail}` : ''}`);
  return row;
};

const api = async (path, { method = 'POST', token = freedom, body } = {}) => {
  const headers = { 'content-type': 'application/json' };
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

const confirmOp = async (operationId, eventType, externalEventId) => {
  await api('/financial/simulate-submit', { body: { operation_id: operationId } });
  return api('/financial/simulate-webhook', {
    body: { operation_id: operationId, event_type: eventType, external_event_id: externalEventId },
  });
};

const main = async () => {
  const financial = await api('/financial/status', { method: 'GET', token: null });
  evidence.flags = financial.json;
  record('15 staging sandbox / non-live provider', financial.status === 200
    && financial.json.liveProviderTransactions === false
    && financial.json.flags?.AWS_PROVIDER_EXECUTION_ENABLED === false
    && financial.json.flags?.AWS_MOOV_TRANSFER_POST_ENABLED === false
    && financial.json.flags?.AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED === true, {
    detail: `exec=${financial.json.flags?.AWS_PROVIDER_EXECUTION_ENABLED} sim=${financial.json.flags?.AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED}`,
  });

  const created = await api('/workflow/checks', {
    body: {
      carrier_name: MARKER,
      review_notes: MARKER,
      check_number: `S11A${Date.now().toString().slice(-7)}`,
      payee_line: 'S11 Accept Partial',
      funds_type: 'acv',
      amount: 200,
      property_address: '11 Accept Lane',
    },
  });
  const check = Array.isArray(created.json.data) ? created.json.data[0] : created.json.data;
  evidence.checkId = check?.id;
  record('synthetic $200 check', Boolean(check?.id) && Number(check?.amount) === 200, {
    detail: `id=${check?.id}`,
  });
  if (!check?.id) throw new Error('no check');

  const deposit = await api('/financial/prepare', {
    body: { operation_type: 'checkalt_deposit', check_id: check.id, marker: MARKER },
  });
  const depositWh = await confirmOp(deposit.json.operation?.id, 'deposit.cleared', `${MARKER}-in`);
  evidence.deposit = {
    cents: deposit.json.operation?.amount_cents,
    status: depositWh.json.operation?.status,
    remaining: depositWh.json.remaining,
    live: depositWh.json.liveProviderCalled,
  };
  record('1 confirmed money in = $200', deposit.json.operation?.amount_cents === 20000
    && depositWh.json.operation?.status === 'provider_confirmed'
    && depositWh.json.remaining?.confirmed_in_cents === 20000
    && depositWh.json.remaining?.remaining_cents === 20000, {
    detail: `in=${depositWh.json.remaining?.confirmed_in_cents} remaining=${depositWh.json.remaining?.remaining_cents}`,
  });

  const untrusted = await api('/financial/prepare', {
    body: { operation_type: 'disbursement', check_id: check.id, marker: MARKER, amount_cents: 5000 },
  });
  record('14 client amount_cents still untrusted', untrusted.status === 400 && untrusted.json.error === 'untrusted_amount', {
    detail: `status=${untrusted.status} error=${untrusted.json.error}`,
  });

  const zero = await api('/financial/prepare', {
    body: {
      operation_type: 'disbursement', check_id: check.id, marker: MARKER,
      requested_partial_cents: 0, disbursement_sequence: 99,
    },
  });
  const negative = await api('/financial/prepare', {
    body: {
      operation_type: 'disbursement', check_id: check.id, marker: MARKER,
      requested_partial_cents: -50, disbursement_sequence: 99,
    },
  });
  const malformed = await api('/financial/prepare', {
    body: {
      operation_type: 'disbursement', check_id: check.id, marker: MARKER,
      requested_partial_cents: '50.5', disbursement_sequence: 99,
    },
  });
  record('11 zero/negative/malformed partials denied', zero.status === 400
    && negative.status === 400
    && malformed.status === 400
    && [zero.json.error, negative.json.error, malformed.json.error].every((error) => error === 'invalid_partial_amount'), {
    detail: `zero=${zero.json.error} neg=${negative.json.error} bad=${malformed.json.error}`,
  });

  const first = await api('/financial/prepare', {
    body: {
      operation_type: 'disbursement',
      check_id: check.id,
      marker: MARKER,
      requested_partial_cents: 5000,
      disbursement_sequence: 1,
    },
  });
  const firstWh = await confirmOp(first.json.operation?.id, 'transfer.completed', `${MARKER}-out-1`);
  evidence.ops.push({
    id: first.json.operation?.id,
    seq: first.json.operation?.disbursement_sequence,
    cents: first.json.operation?.amount_cents,
    after: firstWh.json.remaining,
  });
  record('2 first authorized partial = $50', first.status === 200
    && first.json.operation?.amount_cents === 5000
    && first.json.operation?.disbursement_sequence === 1
    && first.json.liveProviderCalled === false, {
    detail: `id=${first.json.operation?.id} cents=${first.json.operation?.amount_cents}`,
  });
  record('3 successful first partial leaves $150', firstWh.json.remaining?.remaining_cents === 15000
    && firstWh.json.remaining?.confirmed_out_cents === 5000
    && firstWh.json.remaining?.fully_disbursed === false, {
    detail: `remaining=${firstWh.json.remaining?.remaining_cents} out=${firstWh.json.remaining?.confirmed_out_cents}`,
  });

  const retry = await api('/financial/prepare', {
    body: {
      operation_type: 'disbursement',
      check_id: check.id,
      marker: MARKER,
      requested_partial_cents: 5000,
      disbursement_sequence: 1,
    },
  });
  record('4 retry same $50 logical op is idempotent', retry.status === 200
    && retry.json.duplicate === true
    && retry.json.operation?.id === first.json.operation?.id
    && retry.json.remaining?.remaining_cents === 15000, {
    detail: `id=${retry.json.operation?.id} dup=${retry.json.duplicate} remaining=${retry.json.remaining?.remaining_cents}`,
  });

  const second = await api('/financial/prepare', {
    body: {
      operation_type: 'disbursement',
      check_id: check.id,
      marker: MARKER,
      requested_partial_cents: 5000,
      disbursement_sequence: 2,
    },
  });
  const secondWh = await confirmOp(second.json.operation?.id, 'transfer.completed', `${MARKER}-out-2`);
  evidence.ops.push({
    id: second.json.operation?.id,
    seq: 2,
    cents: second.json.operation?.amount_cents,
    after: secondWh.json.remaining,
  });
  record('5 second legitimate $50 is independent and leaves $100', second.status === 200
    && second.json.duplicate !== true
    && second.json.operation?.id !== first.json.operation?.id
    && second.json.operation?.amount_cents === 5000
    && secondWh.json.remaining?.remaining_cents === 10000
    && secondWh.json.remaining?.successful_out?.length === 2, {
    detail: `id=${second.json.operation?.id} remaining=${secondWh.json.remaining?.remaining_cents} history=${secondWh.json.remaining?.successful_out?.length}`,
  });

  const failPrep = await api('/financial/prepare', {
    body: {
      operation_type: 'pay_homeowner',
      check_id: check.id,
      marker: MARKER,
      requested_partial_cents: 4000,
      disbursement_sequence: 1,
    },
  });
  const failed = await api('/financial/simulate-failure', {
    body: { operation_id: failPrep.json.operation?.id, failure_class: 'provider_400' },
  });
  const afterFail = await api('/financial/prepare', {
    body: {
      operation_type: 'disbursement',
      check_id: check.id,
      marker: MARKER,
      requested_partial_cents: 10001,
      disbursement_sequence: 80,
    },
  });
  record('6 failed/cancelled attempt does not reduce $100', failed.status === 200
    && failed.json.operation?.status === 'provider_failed'
    && afterFail.status === 409
    && afterFail.json.error === 'exceeds_remaining'
    && afterFail.json.remaining?.remaining_cents === 10000
    && afterFail.json.remaining?.confirmed_out_cents === 10000, {
    detail: `fail=${failed.json.operation?.status} remaining=${afterFail.json.remaining?.remaining_cents}`,
  });

  const over = await api('/financial/prepare', {
    body: {
      operation_type: 'disbursement',
      check_id: check.id,
      marker: MARKER,
      requested_partial_cents: 10001,
      disbursement_sequence: 81,
    },
  });
  record('10 $100.01 when $100 remains is denied', over.status === 409
    && over.json.error === 'exceeds_remaining'
    && over.json.remaining?.remaining_cents === 10000
    && over.json.liveProviderCalled !== true, {
    detail: `status=${over.status} remaining=${over.json.remaining?.remaining_cents}`,
  });

  const remainder = await api('/financial/prepare', {
    body: {
      operation_type: 'disbursement',
      check_id: check.id,
      marker: MARKER,
      requested_partial_cents: 10000,
      disbursement_sequence: 3,
    },
  });
  const remWh = await confirmOp(remainder.json.operation?.id, 'transfer.completed', `${MARKER}-out-3`);
  evidence.ops.push({
    id: remainder.json.operation?.id,
    seq: 3,
    cents: remainder.json.operation?.amount_cents,
    after: remWh.json.remaining,
  });
  record('7 final $100 remainder leaves $0', remainder.status === 200
    && remainder.json.operation?.amount_cents === 10000
    && remWh.json.remaining?.remaining_cents === 0
    && remWh.json.remaining?.confirmed_out_cents === 20000, {
    detail: `remaining=${remWh.json.remaining?.remaining_cents} out=${remWh.json.remaining?.confirmed_out_cents}`,
  });
  record('8 all successful partials remain in history', remWh.json.remaining?.successful_out?.length === 3
    && remWh.json.remaining?.successful_out?.every((row) => row.id)
    && [first.json.operation.id, second.json.operation.id, remainder.json.operation.id]
      .every((id) => remWh.json.remaining.successful_out.some((row) => row.id === id)), {
    detail: `history=${JSON.stringify(remWh.json.remaining?.successful_out?.map((row) => ({ id: row.id, cents: row.amount_cents })))}`,
  });
  record('9 fully disbursed only when remaining is zero', remWh.json.remaining?.fully_disbursed === true
    && firstWh.json.remaining?.fully_disbursed === false
    && secondWh.json.remaining?.fully_disbursed === false, {
    detail: `after50=${firstWh.json.remaining?.fully_disbursed} after100=${secondWh.json.remaining?.fully_disbursed} after200=${remWh.json.remaining?.fully_disbursed}`,
  });

  const writeSplit = await api('/data/write', {
    body: { table: 'disbursement_splits', op: 'insert', values: { check_id: check.id, amount: 50 }, single: true },
  });
  const writeBatch = await api('/data/write', {
    body: { table: 'disbursement_batches', op: 'insert', values: { check_intake_item_id: check.id, check_amount: 200 }, single: true },
  });
  record('13 generic /data/write financial tables still denied', writeSplit.status === 403
    && writeBatch.status === 403
    && writeSplit.json.reason === 'financial_or_provider'
    && writeBatch.json.reason === 'financial_or_provider', {
    detail: `splits=${writeSplit.json.error} batches=${writeBatch.json.error}`,
  });

  const raceCheck = await api('/workflow/checks', {
    body: {
      carrier_name: MARKER,
      review_notes: `${MARKER} race`,
      check_number: `S11R${Date.now().toString().slice(-7)}`,
      payee_line: 'S11 Race',
      funds_type: 'acv',
      amount: 50,
      property_address: '11 Race Lane',
    },
  });
  const race = Array.isArray(raceCheck.json.data) ? raceCheck.json.data[0] : raceCheck.json.data;
  const raceDeposit = await api('/financial/prepare', {
    body: { operation_type: 'checkalt_deposit', check_id: race.id, marker: MARKER },
  });
  await confirmOp(raceDeposit.json.operation?.id, 'deposit.cleared', `${MARKER}-race-in`);
  const [left, right] = await Promise.all([
    api('/financial/prepare', {
      body: {
        operation_type: 'disbursement',
        check_id: race.id,
        marker: MARKER,
        requested_partial_cents: 5000,
        disbursement_sequence: 1,
      },
    }),
    api('/financial/prepare', {
      body: {
        operation_type: 'disbursement',
        check_id: race.id,
        marker: MARKER,
        requested_partial_cents: 5000,
        disbursement_sequence: 2,
      },
    }),
  ]);
  const createdOps = [left, right].filter((row) => row.status === 200 && row.json.duplicate !== true && row.json.operation?.id);
  const denied = [left, right].filter((row) => row.status === 409 && row.json.error === 'exceeds_remaining');
  const replayed = [left, right].filter((row) => row.json.duplicate === true);
  evidence.race = {
    left: { status: left.status, error: left.json.error, id: left.json.operation?.id, dup: left.json.duplicate },
    right: { status: right.status, error: right.json.error, id: right.json.operation?.id, dup: right.json.duplicate },
  };
  record('12 concurrent $50 against $50 remaining cannot over-disburse', createdOps.length === 1
    && (denied.length + replayed.length) >= 1
    && createdOps[0].json.operation?.amount_cents === 5000, {
    detail: `created=${createdOps.length} denied=${denied.length} replayed=${replayed.length} left=${left.status}/${left.json.error || 'ok'} right=${right.status}/${right.json.error || 'ok'}`,
  });

  const checkAfter = await api('/data/query', {
    body: {
      table: 'check_intake_items',
      select: 'id,amount,status,check_stage,deposited_at',
      filters: [{ column: 'id', op: 'eq', value: check.id }],
    },
  });
  const checkRow = Array.isArray(checkAfter.json.data) ? checkAfter.json.data[0] : checkAfter.json.data;
  evidence.checkAfter = checkRow;
  record('check amount unchanged and not prematurely rewritten', Number(checkRow?.amount) === 200, {
    detail: `amount=${checkRow?.amount} status=${checkRow?.status}`,
  });

  const cleanupFin = await api('/financial/cleanup', { body: { marker: MARKER } });
  const delMain = await api(`/workflow/checks/${check.id}`, {
    method: 'DELETE',
    body: { check_id: check.id, reason: `${MARKER} synthetic cleanup` },
  });
  const delRace = await api(`/workflow/checks/${race.id}`, {
    method: 'DELETE',
    body: { check_id: race.id, reason: `${MARKER} synthetic cleanup` },
  });
  evidence.cleanup = {
    financial: cleanupFin.json,
    main: { status: delMain.status, cleanedUp: delMain.json.cleanedUp, error: delMain.json.error },
    race: { status: delRace.status, cleanedUp: delRace.json.cleanedUp, error: delRace.json.error },
  };
  record('cleanup synthetic records', cleanupFin.status === 200
    && (delMain.status === 200 || delMain.json.cleanedUp === true)
    && (delRace.status === 200 || delRace.json.cleanedUp === true), {
    detail: `deletedOps=${cleanupFin.json.deleted} main=${delMain.status} race=${delRace.status}`,
  });

  const failedRows = results.filter((row) => !row.ok);
  const out = {
    ok: failedRows.length === 0,
    runId: RUN_ID,
    marker: MARKER,
    passed: results.filter((row) => row.ok).length,
    failed: failedRows.length,
    results,
    evidence,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ok: out.ok, passed: out.passed, failed: out.failed, failedRows: failedRows.map((row) => row.name) }, null, 2));
  if (failedRows.length) process.exitCode = 1;
};

main().catch((error) => {
  console.error(error);
  fs.writeFileSync(OUT, JSON.stringify({ ok: false, error: String(error?.stack || error), results, evidence }, null, 2));
  process.exit(1);
});
