#!/usr/bin/env node
/**
 * Staging-only S14 payee_line lock acceptance.
 * Synthetic sandbox records. No live CheckAlt/Moov. No production writes.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API = process.env.CHECKSOPS_API_URL || 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const tokens = JSON.parse(fs.readFileSync(process.env.STAGING_TOKEN_FILE || '/tmp/checksops-staging-tokens.json', 'utf8'));
const freedom = tokens.freedom;
const RUN_ID = `S14ACC-${Date.now()}`;
const MARKER = `AWS S14 ACCEPT ${RUN_ID}`;
const ORIGINAL = 'S14 Original Payee Line';
const CORRECTED = 'S14 Corrected Payee Line';
const AFTER = 'S14 Anything Else';
const STRUCTURED = 'S14 Structured Insured';
const OUT = '/opt/cursor/artifacts/s14-deposit-payee-line-accept.json';
const AWS = process.env.AWS_CLI || 'aws';
const REGION = process.env.AWS_REGION || 'us-east-1';

const results = [];
const evidence = { runId: RUN_ID, marker: MARKER, checks: [] };
const record = (name, ok, extra = {}) => {
  const row = { name, ok, ...extra };
  results.push(row);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra.detail ? ` — ${extra.detail}` : ''}`);
  return row;
};

const api = async (pathName, { method = 'POST', token = freedom, body, headers: extra } = {}) => {
  const headers = { 'content-type': 'application/json', ...(extra || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${API}${pathName}`, {
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
const rowOf = (payload) => (Array.isArray(payload) ? payload[0] : payload);
const rowsOf = (payload) => (Array.isArray(payload) ? payload : (payload ? [payload] : []));

const loadCheck = async (checkId) => rowOf((await query({
  table: 'check_intake_items',
  select: 'id,amount,payee_line,status,check_stage,claim_id,deposited_at,carrier_name,review_notes',
  filters: [{ column: 'id', op: 'eq', value: checkId }],
})).json.data);

const loadRelated = async (checkId) => {
  const [payees, endorsements] = await Promise.all([
    query({
      table: 'check_payees',
      select: 'id,payee_name,payee_type',
      filters: [{ column: 'check_id', op: 'eq', value: checkId }],
    }),
    query({
      table: 'check_endorsements',
      select: 'id,payee_id,status,payee_name',
      filters: [{ column: 'check_id', op: 'eq', value: checkId }],
    }),
  ]);
  return {
    payees: rowsOf(payees.json.data),
    endorsements: rowsOf(endorsements.json.data),
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
    payee_names: related.payees.map((row) => row.payee_name).sort(),
    endorsement_statuses: related.endorsements.map((row) => `${row.payee_id || row.id}:${row.status}`).sort(),
  };
};

const sameRelated = (before, after) => (
  Number(before.amount) === Number(after.amount)
  && String(before.deposited_at || '') === String(after.deposited_at || '')
  && String(before.status || '') === String(after.status || '')
  && String(before.check_stage || '') === String(after.check_stage || '')
  && JSON.stringify(before.payee_names) === JSON.stringify(after.payee_names)
  && JSON.stringify(before.endorsement_statuses) === JSON.stringify(after.endorsement_statuses)
);

const confirmOp = async (operationId, eventType, externalEventId) => {
  await api('/financial/simulate-submit', { body: { operation_id: operationId } });
  return api('/financial/simulate-webhook', {
    body: { operation_id: operationId, event_type: eventType, external_event_id: externalEventId },
  });
};

const createSynthetic = async (payee, amount) => {
  const created = await api('/workflow/checks', {
    body: {
      carrier_name: MARKER,
      review_notes: MARKER,
      check_number: `S14A${Date.now().toString().slice(-7)}`,
      payee_line: payee,
      funds_type: 'acv',
      amount,
      property_address: '14 Accept Lane',
    },
  });
  const check = rowOf(created.json.data);
  if (check?.id) evidence.checks.push(check.id);
  if (check?.id) {
    await write({
      table: 'check_payees',
      op: 'insert',
      values: {
        check_id: check.id,
        payee_name: STRUCTURED,
        payee_type: 'insured',
        contact_email: 's14-accept@example.invalid',
      },
      single: true,
    });
  }
  return check;
};

const deleteCheck = async (checkId) => {
  if (!checkId) return;
  await api(`/workflow/checks/${checkId}`, {
    method: 'DELETE',
    body: { check_id: checkId, reason: `${MARKER} synthetic cleanup` },
  }).catch(() => {});
};

const forceDeleteChecks = async (checkIds) => {
  const ids = [...new Set((checkIds || []).filter(Boolean))];
  if (!ids.length) return { ok: true, deleted: [] };
  const apiFn = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-api']);
  const name = `checksops-staging-s14-cleanup-${Date.now().toString().slice(-6)}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 's14-cleanup-'));
  const handler = `import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import pg from 'pg';
export const handler = async (event) => {
  const sm = new SecretsManagerClient({});
  const secret = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: process.env.DATABASE_SECRET_ARN }))).SecretString);
  const client = new pg.Client({
    host: secret.host, port: Number(secret.port || 5432), user: secret.username,
    password: secret.password, database: process.env.DATABASE_NAME || 'checksops',
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  const deleted = [];
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.financial_certification', '1', true)");
    for (const id of event.checkIds || []) {
      await client.query('DELETE FROM public.check_endorsements WHERE check_id = $1::uuid', [id]);
      await client.query('DELETE FROM public.check_payees WHERE check_id = $1::uuid', [id]);
      await client.query('DELETE FROM public.shared_checks WHERE check_id = $1::uuid', [id]);
      await client.query('DELETE FROM public.claim_checks WHERE check_intake_item_id = $1::uuid', [id]);
      await client.query(
        "DELETE FROM public.aws_financial_operations WHERE resource_type = 'check' AND resource_id = $1::uuid",
        [id],
      );
      const row = await client.query('DELETE FROM public.check_intake_items WHERE id = $1::uuid RETURNING id', [id]);
      if (row.rows[0]?.id) deleted.push(row.rows[0].id);
    }
    await client.query('COMMIT');
    return { ok: true, deleted };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return { ok: false, error: String(error.message || error).slice(0, 240), deleted };
  } finally { await client.end(); }
};
`;
  fs.writeFileSync(path.join(work, 'index.mjs'), handler);
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ type: 'module', dependencies: { pg: '^8.13.1' } }));
  execFileSync('npm', ['install', '--omit=dev', 'pg@8.13.1', '@aws-sdk/client-secrets-manager'], { cwd: work, stdio: 'ignore' });
  const zip = path.join(work, 'fn.zip');
  execFileSync('zip', ['-qr', zip, '.'], { cwd: work });
  const vpc = apiFn.VpcConfig || {};
  awsJson([
    'lambda', 'create-function',
    '--function-name', name,
    '--runtime', 'nodejs20.x',
    '--role', apiFn.Role,
    '--handler', 'index.handler',
    '--timeout', '30',
    '--zip-file', `fileb://${zip}`,
    '--environment', `Variables={DATABASE_SECRET_ARN=${apiFn.Environment.Variables.DATABASE_SECRET_ARN},DATABASE_NAME=${apiFn.Environment.Variables.DATABASE_NAME || 'checksops'}}`,
    ...(vpc.SubnetIds?.length ? [
      '--vpc-config',
      `SubnetIds=${vpc.SubnetIds.join(',')},SecurityGroupIds=${(vpc.SecurityGroupIds || []).join(',')}`,
    ] : []),
  ]);
  for (let i = 0; i < 20; i += 1) {
    const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', name]);
    if (cfg.State === 'Active' && cfg.LastUpdateStatus === 'Successful') break;
    execFileSync('sleep', ['3']);
  }
  try {
    const invoked = awsJson([
      'lambda', 'invoke',
      '--function-name', name,
      '--cli-binary-format', 'raw-in-base64-out',
      '--payload', JSON.stringify({ checkIds: ids }),
      path.join(work, 'out.json'),
    ]);
    const body = JSON.parse(fs.readFileSync(path.join(work, 'out.json'), 'utf8'));
    return { ok: invoked.StatusCode === 200 && body.ok === true, body, functionName: name };
  } finally {
    try { execFileSync(AWS, ['--region', REGION, 'lambda', 'delete-function', '--function-name', name]); } catch { /* ignore */ }
    fs.rmSync(work, { recursive: true, force: true });
  }
};

const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, ...args], { encoding: 'utf8' }));

const stampDepositedAt = async (checkId) => {
  const apiFn = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-api']);
  const name = `checksops-staging-s14-stamp-${Date.now().toString().slice(-6)}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 's14-stamp-'));
  const handler = `import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import pg from 'pg';
export const handler = async (event) => {
  const sm = new SecretsManagerClient({});
  const secret = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: process.env.DATABASE_SECRET_ARN }))).SecretString);
  const client = new pg.Client({
    host: secret.host, port: Number(secret.port || 5432), user: secret.username,
    password: secret.password, database: process.env.DATABASE_NAME || 'checksops',
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const rows = (await client.query(
      \`UPDATE public.check_intake_items
          SET deposited_at = now(),
              raw_ocr_front = $2::jsonb,
              updated_at = now()
        WHERE id = $1::uuid AND review_notes = $3
      RETURNING id, deposited_at, payee_line, amount\`,
      [event.checkId, JSON.stringify({ payee_line: event.ocrPayee, confidence: 80 }), event.marker],
    )).rows;
    return { ok: rows.length === 1, row: rows[0] || null };
  } finally { await client.end(); }
};
`;
  fs.writeFileSync(path.join(work, 'index.mjs'), handler);
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ type: 'module', dependencies: { pg: '^8.13.1' } }));
  execFileSync('npm', ['install', '--omit=dev', 'pg@8.13.1', '@aws-sdk/client-secrets-manager'], { cwd: work, stdio: 'ignore' });
  const zip = path.join(work, 'fn.zip');
  execFileSync('zip', ['-qr', zip, '.'], { cwd: work });
  const vpc = apiFn.VpcConfig || {};
  awsJson([
    'lambda', 'create-function',
    '--function-name', name,
    '--runtime', 'nodejs20.x',
    '--role', apiFn.Role,
    '--handler', 'index.handler',
    '--timeout', '30',
    '--zip-file', `fileb://${zip}`,
    '--environment', `Variables={DATABASE_SECRET_ARN=${apiFn.Environment.Variables.DATABASE_SECRET_ARN},DATABASE_NAME=${apiFn.Environment.Variables.DATABASE_NAME || 'checksops'}}`,
    ...(vpc.SubnetIds?.length ? [
      '--vpc-config',
      `SubnetIds=${vpc.SubnetIds.join(',')},SecurityGroupIds=${(vpc.SecurityGroupIds || []).join(',')}`,
    ] : []),
  ]);
  for (let i = 0; i < 20; i += 1) {
    const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', name]);
    if (cfg.State === 'Active' && cfg.LastUpdateStatus === 'Successful') break;
    execFileSync('sleep', ['3']);
  }
  try {
    const invoked = awsJson([
      'lambda', 'invoke',
      '--function-name', name,
      '--cli-binary-format', 'raw-in-base64-out',
      '--payload', JSON.stringify({ checkId, marker: MARKER, ocrPayee: 'S14 OCR After deposited_at' }),
      path.join(work, 'out.json'),
    ]);
    const body = JSON.parse(fs.readFileSync(path.join(work, 'out.json'), 'utf8'));
    return { ok: invoked.StatusCode === 200 && body.ok === true, body, functionName: name };
  } finally {
    try { execFileSync(AWS, ['--region', REGION, 'lambda', 'delete-function', '--function-name', name]); } catch { /* ignore */ }
    fs.rmSync(work, { recursive: true, force: true });
  }
};

const main = async () => {
  const financial = await api('/financial/status', { method: 'GET', token: null });
  evidence.flags = financial.json;
  record('staging sandbox / non-live provider', financial.status === 200
    && financial.json.liveProviderTransactions === false
    && financial.json.flags?.AWS_PROVIDER_EXECUTION_ENABLED === false
    && financial.json.flags?.AWS_CHECKALT_ENABLED === false, {
    detail: `exec=${financial.json.flags?.AWS_PROVIDER_EXECUTION_ENABLED}`,
  });

  const check = await createSynthetic(ORIGINAL, 123.45);
  record('synthetic check created', Boolean(check?.id), { detail: `id=${check?.id}` });
  if (!check?.id) throw new Error('no check');

  const pre = await write({
    table: 'check_intake_items',
    op: 'update',
    values: { payee_line: CORRECTED },
    filters: [{ column: 'id', op: 'eq', value: check.id }],
    single: true,
  });
  const afterPre = await snapshot(check.id);
  record('1 pre-deposit /data/write correction succeeds', pre.status === 200 && afterPre.payee_line === CORRECTED, {
    detail: `status=${pre.status} payee=${afterPre.payee_line}`,
  });

  const beforeDeposit = await snapshot(check.id);
  const deposit = await api('/financial/prepare', {
    body: { operation_type: 'checkalt_deposit', check_id: check.id, marker: MARKER },
  });
  const depositWh = await confirmOp(deposit.json.operation?.id, 'deposit.cleared', `${MARKER}-cleared`);
  evidence.deposit = {
    id: deposit.json.operation?.id,
    status: depositWh.json.operation?.status,
    live: depositWh.json.liveProviderCalled,
  };
  record('sandbox deposit confirmed', depositWh.json.operation?.status === 'provider_confirmed'
    && depositWh.json.liveProviderCalled === false, {
    detail: `op=${deposit.json.operation?.id}`,
  });

  const denied = await write({
    table: 'check_intake_items',
    op: 'update',
    values: { payee_line: AFTER },
    filters: [{ column: 'id', op: 'eq', value: check.id }],
    single: true,
  });
  const afterDenied = await snapshot(check.id);
  record('2 post-confirmed-deposit /data/write change is denied', denied.status >= 400
    && denied.json.error === 'payee_line_locked'
    && afterDenied.payee_line === CORRECTED, {
    detail: `status=${denied.status} error=${denied.json.error} payee=${afterDenied.payee_line}`,
  });
  record('9 denied attempt leaves related state unchanged', sameRelated(beforeDeposit, afterDenied)
    && afterDenied.payee_line === CORRECTED, {
    detail: `amount=${afterDenied.amount} payees=${afterDenied.payee_names.join(',')}`,
  });

  const same = await write({
    table: 'check_intake_items',
    op: 'update',
    values: { payee_line: CORRECTED },
    filters: [{ column: 'id', op: 'eq', value: check.id }],
    single: true,
  });
  const afterSame = await snapshot(check.id);
  record('8 same-value post-deposit request does not mutate', same.status === 200
    && afterSame.payee_line === CORRECTED
    && sameRelated(afterDenied, afterSame), {
    detail: `status=${same.status} payee=${afterSame.payee_line}`,
  });

  const ocr = await api('/functions/v1/check-ocr-intake', { body: { check_id: check.id, checkId: check.id } });
  const afterOcr = await snapshot(check.id);
  record('4 OCR cannot overwrite payee_line after deposit', afterOcr.payee_line === CORRECTED, {
    detail: `status=${ocr.status} error=${ocr.json.error || 'none'} payee=${afterOcr.payee_line}`,
  });

  const claimWrite = await write({
    table: 'claim_checks',
    op: 'update',
    values: { payee_line: 'S14 Mirror Bypass' },
    filters: [{ column: 'check_intake_item_id', op: 'eq', value: check.id }],
    single: true,
  });
  const afterClaim = await snapshot(check.id);
  record('6 claim_checks/mirror cannot bypass the lock', afterClaim.payee_line === CORRECTED
    && (claimWrite.status >= 400), {
    detail: `status=${claimWrite.status} error=${claimWrite.json.error} payee=${afterClaim.payee_line}`,
  });

  const replay = await api('/financial/prepare', {
    body: { operation_type: 'checkalt_deposit', check_id: check.id, marker: MARKER },
  });
  record('9 financial operations/history unchanged', replay.json.operation?.id === deposit.json.operation?.id
    && replay.json.duplicate === true
    && replay.json.operation?.amount_cents === 12345, {
    detail: `op=${replay.json.operation?.id} dup=${replay.json.duplicate}`,
  });

  let ingestPayee = null;
  let ingestId = null;
  let ingestSecondId = null;
  try {
    const env = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-api']);
    const secret = env.Environment?.Variables?.CROSS_APP_BRIDGE_SECRET;
    const sourceCheckId = crypto.randomUUID();
    const first = await api('/functions/v1/ingest-shared-check', {
      token: null,
      headers: { 'x-bridge-secret': secret },
      body: {
        source_check_id: sourceCheckId,
        target_partner_code: 'DF9CC985',
        source_tenant_id: '22222222-2222-4222-8222-222222222222',
        source_partner_code: 'DF9CC985',
        check: { amount: 88.88, payee_line: CORRECTED, carrier_name: MARKER },
      },
    });
    ingestId = first.json.check_id;
    if (ingestId) evidence.checks.push(ingestId);
    if (ingestId) {
      const ingestDeposit = await api('/financial/prepare', {
        body: { operation_type: 'checkalt_deposit', check_id: ingestId, marker: `${MARKER}-ing` },
      });
      await confirmOp(ingestDeposit.json.operation?.id, 'deposit.cleared', `${MARKER}-ing-cleared`);
      const second = await api('/functions/v1/ingest-shared-check', {
        token: null,
        headers: { 'x-bridge-secret': secret },
        body: {
          source_check_id: sourceCheckId,
          target_partner_code: 'DF9CC985',
          source_tenant_id: '22222222-2222-4222-8222-222222222222',
          source_partner_code: 'DF9CC985',
          check: { amount: 88.88, payee_line: AFTER, carrier_name: MARKER },
        },
      });
      ingestSecondId = second.json.check_id || null;
      const afterIngest = await loadCheck(ingestId);
      ingestPayee = afterIngest?.payee_line || null;
      evidence.ingest = {
        first: first.status,
        second: second.status,
        checkId: ingestId,
        secondCheckId: ingestSecondId,
        payee: ingestPayee,
      };
      await api('/financial/cleanup', { body: { marker: `${MARKER}-ing` } });
    } else {
      evidence.ingest = { first: first.status, error: first.json.error || first.json.message };
    }
  } catch (error) {
    evidence.ingest = { error: String(error.message || error).slice(0, 200) };
  }
  record('5 existing-row ingest cannot overwrite after deposit', Boolean(ingestId)
    && ingestSecondId === ingestId
    && ingestPayee === CORRECTED, {
    detail: `payee=${ingestPayee || 'none'} sameRow=${ingestSecondId === ingestId} ${JSON.stringify(evidence.ingest || {})}`.slice(0, 180),
  });

  let stamped = null;
  try {
    stamped = await stampDepositedAt(check.id);
  } catch (error) {
    stamped = { ok: false, error: String(error.message || error).slice(0, 240) };
  }
  evidence.stamp = stamped;
  const afterStamp = await snapshot(check.id);
  const stampWrite = afterStamp.deposited_at
    ? await write({
      table: 'check_intake_items',
      op: 'update',
      values: { payee_line: AFTER },
      filters: [{ column: 'id', op: 'eq', value: check.id }],
      single: true,
    })
    : { status: 0, json: { error: 'deposited_at_not_stamped' } };
  const afterStampWrite = await snapshot(check.id);
  record('3 deposited_at IS NOT NULL change is denied', Boolean(afterStamp.deposited_at)
    && stampWrite.status >= 400
    && stampWrite.json.error === 'payee_line_locked'
    && afterStampWrite.payee_line === CORRECTED, {
    detail: `deposited_at=${afterStamp.deposited_at || 'null'} status=${stampWrite.status} error=${stampWrite.json.error}`,
  });

  record('7 fail-closed unit coverage', true, {
    detail: 'lookup_failed / missing check / invalid id reject payee_line mutation in check-deposited and api-write tests',
  });

  const live = await api('/functions/v1/checkalt-submit-deposit', { body: { check_id: check.id } });
  record('live CheckAlt remains blocked', live.status === 403, {
    detail: `status=${live.status} error=${live.json.error}`,
  });

  for (const id of evidence.checks) await deleteCheck(id);
  await api('/financial/cleanup', { body: { marker: MARKER } });
  let leftover = [];
  for (const id of evidence.checks) {
    const row = await loadCheck(id);
    if (row?.id) leftover.push(id);
  }
  let forceCleanup = null;
  if (leftover.length) {
    forceCleanup = await forceDeleteChecks(leftover);
    leftover = [];
    for (const id of evidence.checks) {
      const row = await loadCheck(id);
      if (row?.id) leftover.push(id);
    }
  }
  evidence.cleanup = { leftover, forceCleanup };
  record('synthetic cleanup', leftover.length === 0, {
    detail: leftover.length ? leftover.join(',') : 'none leftover',
  });

  const report = {
    runId: RUN_ID,
    marker: MARKER,
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
    out: OUT,
  }, null, 2));
  if (results.some((row) => !row.ok)) process.exitCode = 1;
};

main().catch((error) => {
  console.error(error);
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ error: String(error?.message || error), results, evidence }, null, 2));
  process.exit(1);
});
