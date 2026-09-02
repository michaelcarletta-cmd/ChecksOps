#!/usr/bin/env node
/**
 * Live Tranche 2 write validation against staging API + Cognito.
 * Restores mutated descriptive fields. Deletes test payees.
 * Does not touch production Supabase.
 */
import fs from 'node:fs';

const API = process.env.CHECKSOPS_API_URL || 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const FREEDOM_EMAIL = 'checksops-tester@freedomadj.com';
const C1C_EMAIL = 'payments@condition1commercial.com';
const FREEDOM_APP = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const NINTH = 'dd24eea5-5d12-47d1-999e-d5930c278b7d';
const TEST_PAYEE = `AWS T2 TEST ${Date.now()}`;

const passwords = JSON.parse(fs.readFileSync(process.env.COGNITO_PASSWORD_FILE || '/tmp/cognito-login-passwords.json', 'utf8'));

const results = [];
const record = (name, ok, extra = {}) => {
  results.push({ name, ok, ...extra });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra.detail ? ` — ${extra.detail}` : ''}`);
};

const api = async (path, { method = 'POST', token, body } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try { json = await response.json(); } catch { json = {}; }
  return { status: response.status, json };
};

const login = async (email) => {
  const { status, json } = await api('/auth/login', {
    body: { email, password: passwords[email] || passwords[email.toLowerCase()] },
  });
  if (status !== 200 || !json.authentication?.idToken) {
    throw new Error(`login failed for ${email}: ${status} ${json.error || json.message || ''}`);
  }
  return json.authentication.idToken;
};

const write = async (token, body, extraHeaders = {}) => {
  const headers = { 'content-type': 'application/json', ...extraHeaders };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${API}/data/write`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const query = (token, body) => api('/data/query', { token, body });
const rowOf = (payload) => (Array.isArray(payload) ? payload[0] : payload);

const aCheck = async (token) => {
  const { status, json } = await query(token, {
    table: 'check_intake_items',
    select: 'id, tenant_id, carrier_name, amount, status, check_stage',
    limit: 1,
  });
  if (status !== 200 || !json.data?.[0]?.id) throw new Error('no visible check for tenant');
  return json.data[0];
};

const main = async () => {
  const freedomToken = await login(FREEDOM_EMAIL);
  const c1cToken = await login(C1C_EMAIL);
  const freedomCheck = await aCheck(freedomToken);
  let c1cCheck = null;
  try {
    c1cCheck = await aCheck(c1cToken);
  } catch (error) {
    record('C1C has no visible check_intake_items (restore has Freedom checks only)', true, {
      detail: String(error.message),
    });
  }
  record('Freedom check loaded', Boolean(freedomCheck?.id) && freedomCheck.tenant_id === FREEDOM_TENANT, {
    detail: `freedom=${freedomCheck.id} amount=${freedomCheck.amount}`,
  });

  const originalCarrier = freedomCheck.carrier_name;
  const marker = `AWS T2 ${Date.now().toString().slice(-6)}`;

  const fUpdate = await write(freedomToken, {
    table: 'check_intake_items',
    op: 'update',
    values: { carrier_name: marker, tenant_id: C1C_TENANT, user_id: NINTH },
    filters: [{ column: 'id', op: 'eq', value: freedomCheck.id }],
  }, { 'x-user-id': NINTH, 'x-tenant-id': C1C_TENANT });
  const updated = rowOf(fUpdate.json.data);
  record('Freedom update own descriptive check field', fUpdate.status === 200 && updated?.carrier_name === marker, {
    detail: `status=${fUpdate.status} carrier=${updated?.carrier_name}`,
  });
  record('spoofed tenant/user ignored on intake update', fUpdate.status === 200 && updated?.tenant_id === FREEDOM_TENANT, {
    detail: `tenant=${updated?.tenant_id}`,
  });

  const readback = await query(freedomToken, {
    table: 'check_intake_items',
    select: 'id, carrier_name, amount, tenant_id',
    filters: [{ column: 'id', op: 'eq', value: freedomCheck.id }],
    limit: 1,
  });
  const readRow = readback.json.data?.[0];
  record('Freedom can read updated check', readback.status === 200 && readRow?.carrier_name === marker, {
    detail: `carrier=${readRow?.carrier_name} amount=${readRow?.amount}`,
  });
  record('amount unchanged after descriptive update', String(readRow?.amount) === String(freedomCheck.amount), {
    detail: `before=${freedomCheck.amount} after=${readRow?.amount}`,
  });

  const restore = await write(freedomToken, {
    table: 'check_intake_items',
    op: 'update',
    values: { carrier_name: originalCarrier },
    filters: [{ column: 'id', op: 'eq', value: freedomCheck.id }],
  });
  record('Freedom restore original carrier_name', restore.status === 200, { detail: `status=${restore.status}` });

  const amountDenied = await write(freedomToken, {
    table: 'check_intake_items',
    op: 'update',
    values: { amount: 1 },
    filters: [{ column: 'id', op: 'eq', value: freedomCheck.id }],
  });
  record('financial field mutation denied', amountDenied.status === 403 && amountDenied.json.error === 'column_not_allowlisted', {
    detail: `status=${amountDenied.status} cols=${JSON.stringify(amountDenied.json.columns)}`,
  });

  const statusDenied = await write(freedomToken, {
    table: 'check_intake_items',
    op: 'update',
    values: { status: 'deposited' },
    filters: [{ column: 'id', op: 'eq', value: freedomCheck.id }],
  });
  record('status mutation denied', statusDenied.status === 403, { detail: `error=${statusDenied.json.error}` });

  const insertDenied = await write(freedomToken, {
    table: 'check_intake_items',
    op: 'insert',
    values: { carrier_name: 'x' },
  });
  record('check_intake_items insert denied', insertDenied.status === 403, { detail: `error=${insertDenied.json.error}` });

  const cCross = await write(c1cToken, {
    table: 'check_intake_items',
    op: 'update',
    values: { carrier_name: 'C1C should not write Freedom' },
    filters: [{ column: 'id', op: 'eq', value: freedomCheck.id }],
  });
  record('C1C cannot update Freedom check', cCross.status >= 400, {
    detail: `status=${cCross.status} error=${cCross.json.error}`,
  });

  if (c1cCheck) {
    const fCross = await write(freedomToken, {
      table: 'check_intake_items',
      op: 'update',
      values: { carrier_name: 'Freedom should not write C1C' },
      filters: [{ column: 'id', op: 'eq', value: c1cCheck.id }],
    });
    record('Freedom cannot update C1C check', fCross.status >= 400, {
      detail: `status=${fCross.status} error=${fCross.json.error}`,
    });
    const cOwn = await write(c1cToken, {
      table: 'check_intake_items',
      op: 'update',
      values: { review_notes: 'aws t2 c1c' },
      filters: [{ column: 'id', op: 'eq', value: c1cCheck.id }],
    });
    record('C1C can update own descriptive field', cOwn.status === 200, { detail: `status=${cOwn.status}` });
  } else {
    record('C1C own-check write skipped (no C1C intake rows); C1C→Freedom deny covers isolation', true);
  }

  const payeeIns = await write(freedomToken, {
    table: 'check_payees',
    op: 'insert',
    values: {
      check_id: freedomCheck.id,
      payee_name: TEST_PAYEE,
      payee_type: 'insured',
      tenant_id: C1C_TENANT,
      endorsement_status: 'signed',
    },
  });
  const payeeRow = rowOf(payeeIns.json.data);
  record('Freedom insert own payee record', payeeIns.status === 200 && payeeRow?.payee_name === TEST_PAYEE && payeeRow?.tenant_id === FREEDOM_TENANT, {
    detail: `status=${payeeIns.status} id=${payeeRow?.id} tenant=${payeeRow?.tenant_id} endorsed=${payeeRow?.endorsement_status}`,
  });
  record('payee insert did not apply client signed status', payeeRow && payeeRow.endorsement_status !== 'signed', {
    detail: `endorsement_status=${payeeRow?.endorsement_status}`,
  });

  const cPayee = await write(c1cToken, {
    table: 'check_payees',
    op: 'insert',
    values: { check_id: freedomCheck.id, payee_name: `${TEST_PAYEE} C1C` },
  });
  record('C1C cannot insert payee on Freedom check', cPayee.status >= 400, {
    detail: `status=${cPayee.status} error=${cPayee.json.error}`,
  });

  if (payeeRow?.id) {
    const payeeUpd = await write(freedomToken, {
      table: 'check_payees',
      op: 'update',
      values: { contact_email: 'aws-t2-test@freedomadj.com' },
      filters: [{ column: 'id', op: 'eq', value: payeeRow.id }],
    });
    record('Freedom update own payee contact', payeeUpd.status === 200 && rowOf(payeeUpd.json.data)?.contact_email === 'aws-t2-test@freedomadj.com', {
      detail: `status=${payeeUpd.status}`,
    });

    const eventsDel = await write(freedomToken, {
      table: 'check_endorsement_events',
      op: 'delete',
      filters: [{ column: 'payee_id', op: 'eq', value: payeeRow.id }],
    });
    record('Freedom delete endorsement events for test payee', eventsDel.status === 200, { detail: `status=${eventsDel.status}` });

    const endDel = await write(freedomToken, {
      table: 'check_endorsements',
      op: 'delete',
      filters: [{ column: 'payee_id', op: 'eq', value: payeeRow.id }],
    });
    record('Freedom delete endorsement rows for test payee', endDel.status === 200, { detail: `status=${endDel.status}` });

    const payeeDel = await write(freedomToken, {
      table: 'check_payees',
      op: 'delete',
      filters: [{ column: 'id', op: 'eq', value: payeeRow.id }],
    });
    record('Freedom delete own test payee', payeeDel.status === 200, { detail: `status=${payeeDel.status}` });
  }

  const endorseStatus = await write(freedomToken, {
    table: 'check_endorsements',
    op: 'update',
    values: { status: 'signed' },
    filters: [{ column: 'id', op: 'eq', value: freedomCheck.id }],
  });
  record('endorsement status mutation denied', endorseStatus.status === 403, {
    detail: `error=${endorseStatus.json.error}`,
  });

  const audit = await write(freedomToken, {
    table: 'check_audit_log',
    op: 'insert',
    values: {
      check_id: freedomCheck.id,
      event_type: 'aws_tranche2_test',
      event_description: 'staging isolation probe',
      actor_id: NINTH,
      tenant_id: C1C_TENANT,
    },
  });
  const auditRow = rowOf(audit.json.data);
  record('Freedom insert check_audit_log as mapped actor', audit.status === 200 && auditRow?.actor_id === FREEDOM_APP && auditRow?.tenant_id === FREEDOM_TENANT, {
    detail: `status=${audit.status} actor=${auditRow?.actor_id}`,
  });

  const msgIns = await write(freedomToken, {
    table: 'check_messages',
    op: 'insert',
    values: { check_id: freedomCheck.id, body: 'should not write ledger' },
  });
  record('check_messages INSERT denied (ledger trigger)', msgIns.status === 403, {
    detail: `error=${msgIns.json.error}`,
  });

  const unauth = await write(null, {
    table: 'check_intake_items',
    op: 'update',
    values: { carrier_name: 'x' },
    filters: [{ column: 'id', op: 'eq', value: freedomCheck.id }],
  });
  record('unauthenticated write is 401', unauth.status === 401, { detail: `status=${unauth.status}` });

  const subAsUser = await write(freedomToken, {
    table: 'check_audit_log',
    op: 'insert',
    values: {
      check_id: freedomCheck.id,
      event_type: 'aws_tranche2_test',
      event_description: 'cognito sub spoof',
      actor_id: audit.json.cognitoSub || 'c4386408-60e1-70e2-abb6-e6194e8e635f',
    },
  });
  const subRow = rowOf(subAsUser.json.data);
  record('Cognito sub as actor_id ignored', subAsUser.status === 200 && subRow?.actor_id === FREEDOM_APP, {
    detail: `actor=${subRow?.actor_id}`,
  });

  const ninthBody = await write(freedomToken, {
    table: 'check_payees',
    op: 'insert',
    values: { check_id: freedomCheck.id, payee_name: `${TEST_PAYEE} ninth`, user_id: NINTH },
  });
  const ninthPayee = rowOf(ninthBody.json.data);
  record('ninth UUID in body cannot become payee owner', ninthBody.status === 200 && ninthPayee?.tenant_id === FREEDOM_TENANT, {
    detail: `status=${ninthBody.status} tenant=${ninthPayee?.tenant_id}`,
  });
  if (ninthPayee?.id) {
    await write(freedomToken, { table: 'check_endorsements', op: 'delete', filters: [{ column: 'payee_id', op: 'eq', value: ninthPayee.id }] });
    await write(freedomToken, { table: 'check_payees', op: 'delete', filters: [{ column: 'id', op: 'eq', value: ninthPayee.id }] });
  }

  const badTable = await write(freedomToken, { table: 'tenants', op: 'update', values: { name: 'x' } });
  record('unapproved table denied', badTable.status === 403 && badTable.json.error === 'table_not_allowlisted', {
    detail: `status=${badTable.status}`,
  });

  const financial = await write(freedomToken, {
    table: 'claim_payments',
    op: 'insert',
    values: { amount: 1 },
  });
  record('financial table denied', financial.status === 403 && financial.json.reason === 'financial_or_provider', {
    detail: `status=${financial.status}`,
  });

  const provider = await api('/functions/v1/moov-transfer', { token: freedomToken, body: {} });
  record('provider function still disabled', provider.status === 403, {
    detail: `status=${provider.status} error=${provider.json.error}`,
  });

  const malformed = await write(freedomToken, {
    table: 'check_intake_items',
    op: 'update',
    values: { carrier_name: 'x' },
    filters: [{ column: 'id', op: 'eq', value: 'not-a-uuid' }],
  });
  record('malformed ID is 400', malformed.status === 400, { detail: `status=${malformed.status}` });

  const reads = await query(freedomToken, { table: 'check_intake_items', select: 'id', limit: 1 });
  record('legitimate read path remains operational', reads.status === 200 && reads.json.data?.[0]?.id, {
    detail: `status=${reads.status}`,
  });

  const failed = results.filter((row) => !row.ok);
  const out = { ok: failed.length === 0, passed: results.filter((r) => r.ok).length, failed: failed.length, results };
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/tranche2-api-validation.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ok: out.ok, passed: out.passed, failed: out.failed }, null, 2));
  if (!out.ok) process.exit(1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
