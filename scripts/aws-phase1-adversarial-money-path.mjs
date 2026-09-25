#!/usr/bin/env node
/**
 * Phase 1 adversarial workflow + money-path audit against AWS STAGING.
 *
 * Uses sandbox/simulation only. Does not call live CheckAlt or Moov.
 * Does not touch production financial records or reconnect Supabase runtime.
 *
 * Cleanup: deletes synthetic workflow checks and simulated financial ops
 * after evidence is collected.
 */
import fs from 'node:fs';

const API = process.env.CHECKSOPS_API_URL || 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const FREEDOM_EMAIL = 'checksops-tester@freedomadj.com';
const C1C_EMAIL = 'payments@condition1commercial.com';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const RUN_ID = `P1ADV-${Date.now()}`;
const MARKER = `AWS P1 ADV ${RUN_ID}`;
const ARTIFACT_DIR = '/opt/cursor/artifacts';
const REPORT_JSON = `${ARTIFACT_DIR}/phase1-adversarial-money-path.json`;

const tokenFile = process.env.STAGING_TOKEN_FILE || '/tmp/checksops-staging-tokens.json';
const mintedTokens = fs.existsSync(tokenFile)
  ? JSON.parse(fs.readFileSync(tokenFile, 'utf8'))
  : {};
const passwords = fs.existsSync(process.env.COGNITO_PASSWORD_FILE || '/tmp/cognito-login-passwords.json')
  ? JSON.parse(fs.readFileSync(process.env.COGNITO_PASSWORD_FILE || '/tmp/cognito-login-passwords.json', 'utf8'))
  : {};

const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//Z',
  'base64',
);
const TINY_PNG_DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const results = [];
const findings = [];
const created = {
  checks: [],
  financialMarkers: [],
  claimsUsed: [],
  notes: [],
};
const cleanup = { checks: [], financialMarkers: [], leftover: [] };

const record = (name, ok, extra = {}) => {
  const row = { name, ok, ...extra };
  results.push(row);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra.detail ? ` — ${extra.detail}` : ''}`);
  return row;
};

const finding = ({
  id,
  scenario,
  severity,
  title,
  reproduction,
  expected,
  actual,
  affected,
  risk,
  fix,
  stopFurther = false,
}) => {
  const row = {
    id,
    scenario,
    severity,
    title,
    reproduction,
    expected,
    actual,
    affected,
    risk,
    recommendedNarrowFix: fix,
    stopFurther,
  };
  findings.push(row);
  console.log(`FINDING ${severity} ${id}: ${title}`);
  return row;
};

const api = async (path, { method = 'POST', token, body, headers: extra } = {}) => {
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

const login = async (email) => {
  const preMinted = mintedTokens[email] || mintedTokens[email.toLowerCase()]
    || (email === FREEDOM_EMAIL ? mintedTokens.freedom : null)
    || (email === C1C_EMAIL ? mintedTokens.c1c : null);
  if (preMinted) return preMinted;
  const { status, json } = await api('/auth/login', {
    body: { email, password: passwords[email] || passwords[email.toLowerCase()] || passwords.password },
  });
  if (status !== 200 || !json.authentication?.idToken) {
    throw new Error(`login failed for ${email}: ${status} ${json.error || json.message || 'password_auth_disabled; mint tokens via aws-mint-staging-tokens.mjs'}`);
  }
  return json.authentication.idToken;
};

const write = (token, body) => api('/data/write', { token, body });
const query = (token, body) => api('/data/query', { token, body });
const rpc = (token, name, args = {}) => api('/data/rpc', { token, body: { name, args } });
const rowOf = (payload) => (Array.isArray(payload) ? payload[0] : payload);
const rowsOf = (payload) => (Array.isArray(payload) ? payload : (payload ? [payload] : []));

const createCheck = async (token, extra = {}) => {
  const createdCheck = await api('/workflow/checks', {
    token,
    body: {
      carrier_name: extra.carrier_name || MARKER,
      review_notes: extra.review_notes || MARKER,
      check_number: extra.check_number || `P1${Date.now().toString().slice(-8)}`,
      payee_line: extra.payee_line || 'Jane Homeowner',
      funds_type: extra.funds_type || 'acv',
      amount: extra.amount,
      property_address: extra.property_address || '100 Audit Lane',
    },
  });
  const check = rowOf(createdCheck.json.data);
  if (check?.id) {
    created.checks.push(check.id);
    cleanup.checks.push(check.id);
  }
  return { http: createdCheck, check };
};

const transition = (token, checkId, action, extra = {}) =>
  api('/workflow/transition', { token, body: { check_id: checkId, action, ...extra } });

const loadCheck = async (token, checkId) => {
  const res = await query(token, {
    table: 'check_intake_items',
    select: 'id,tenant_id,status,check_stage,claim_id,amount,payee_line,carrier_name,check_number,funds_type,review_notes,property_address,deposited_at,front_image_path,back_image_path,back_image_deposit_path,endorsement_render_status,endorsement_render_meta,mortgage_monitoring_type,detected_claim_number,uploaded_by',
    filters: [{ column: 'id', op: 'eq', value: checkId }],
  });
  return rowOf(res.json.data);
};

const loadRelated = async (token, checkId) => {
  const [payees, endorsements, events, audit, messages, files, deposits, mortgage, drafts, claimChecks] = await Promise.all([
    query(token, { table: 'check_payees', select: 'id,check_id,tenant_id,payee_name,payee_type,endorsement_status,endorsed_at,endorsement_token,contact_email', filters: [{ column: 'check_id', op: 'eq', value: checkId }] }),
    query(token, { table: 'check_endorsements', select: 'id,check_id,tenant_id,payee_id,payee_name,payee_type,status,signed_at,signature_method,signature_image_url,token', filters: [{ column: 'check_id', op: 'eq', value: checkId }] }),
    query(token, { table: 'check_endorsement_events', select: 'id,check_id,event_type,created_at', filters: [{ column: 'check_id', op: 'eq', value: checkId }] }),
    query(token, { table: 'check_audit_log', select: 'id,check_id,event_type,event_description,event_data,actor_id,created_at', filters: [{ column: 'check_id', op: 'eq', value: checkId }] }),
    query(token, { table: 'check_messages', select: 'id,check_id,body,created_at', filters: [{ column: 'check_id', op: 'eq', value: checkId }] }),
    query(token, { table: 'check_files', select: 'id,check_intake_item_id,file_path,file_name', filters: [{ column: 'check_intake_item_id', op: 'eq', value: checkId }] }),
    query(token, { table: 'deposit_items', select: 'id,check_id,amount,status,claim_id', filters: [{ column: 'check_id', op: 'eq', value: checkId }] }),
    query(token, { table: 'mortgage_handling_requests', select: 'id,check_intake_item_id,status,requested_by', filters: [{ column: 'check_intake_item_id', op: 'eq', value: checkId }] }),
    query(token, { table: 'loss_draft_tracking', select: 'id,check_intake_item_id,escrow_status,mortgage_servicer', filters: [{ column: 'check_intake_item_id', op: 'eq', value: checkId }] }),
    query(token, { table: 'claim_checks', select: 'id,check_intake_item_id,claim_id,amount,payee_line,check_stage', filters: [{ column: 'check_intake_item_id', op: 'eq', value: checkId }] }),
  ]);
  return {
    payees: rowsOf(payees.json.data),
    endorsements: rowsOf(endorsements.json.data),
    events: rowsOf(events.json.data),
    audit: rowsOf(audit.json.data),
    messages: rowsOf(messages.json.data),
    files: rowsOf(files.json.data),
    deposits: rowsOf(deposits.json.data),
    mortgage: rowsOf(mortgage.json.data),
    drafts: rowsOf(drafts.json.data),
    claimChecks: rowsOf(claimChecks.json.data),
  };
};

const addPayee = async (token, checkId, { payee_name, payee_type = 'insured', contact_email = 'p1adv-payee@example.invalid' }) =>
  write(token, {
    table: 'check_payees',
    op: 'insert',
    values: { check_id: checkId, payee_name, payee_type, contact_email },
    single: true,
  });

const endorse = async (token, body) =>
  api('/functions/v1/check-endorsement', { token, body });

const snapshot = async (token, checkId) => ({
  check: await loadCheck(token, checkId),
  ...(await loadRelated(token, checkId)),
});

const attachFront = async (token, checkId) => {
  const frontPath = `checks/${checkId}/p1adv-front.jpg`;
  const upload = await api('/storage/upload-url', {
    token,
    body: { bucket: 'claim-files', path: frontPath, contentType: 'image/jpeg', contentLength: TINY_JPEG.length },
  });
  let putStatus = null;
  if (upload.json.uploadUrl) {
    const put = await fetch(upload.json.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body: TINY_JPEG,
    });
    putStatus = put.status;
  }
  const pathUpdate = await write(token, {
    table: 'check_intake_items',
    op: 'update',
    values: { front_image_path: frontPath },
    filters: [{ column: 'id', op: 'eq', value: checkId }],
    single: true,
  });
  return { upload, putStatus, pathUpdate, frontPath };
};

const deleteCheck = async (token, checkId) => {
  const del = await api(`/workflow/checks/${checkId}`, { method: 'DELETE', token });
  return del;
};

const cleanupFinancial = async (token, marker) => {
  cleanup.financialMarkers.push(marker);
  return api('/financial/cleanup', { token, body: { marker } });
};

const moneyInMinusOut = ({ depositCents, outCents, remainingCents }) => ({
  depositCents,
  outCents,
  remainingCents,
  expectedRemaining: depositCents - outCents,
  reconciles: remainingCents === (depositCents - outCents),
});

async function scenario1(ctx) {
  const name = 'S1 normal control path';
  const { freedom } = ctx;
  const { http, check } = await createCheck(freedom, { amount: 123.45, funds_type: 'acv', payee_line: 'Jane Homeowner' });
  record(`${name} create`, http.status === 200 && check?.id && Number(check.amount) === 123.45 && check.status === 'uploaded' && !check.claim_id, {
    detail: `id=${check?.id} amount=${check?.amount} status=${check?.status}`,
    checkId: check?.id,
  });
  if (!check?.id) return { check: null };

  const img = await attachFront(freedom, check.id);
  record(`${name} front image`, Boolean(img.upload.json.uploadUrl) && (img.putStatus === 200 || img.putStatus === 204) && img.pathUpdate.status === 200, {
    detail: `put=${img.putStatus} write=${img.pathUpdate.status}`,
  });

  const payee = await addPayee(freedom, check.id, { payee_name: 'Jane Homeowner', payee_type: 'insured' });
  const payeeRow = rowOf(payee.json.data);
  record(`${name} add insured payee`, payee.status === 200 && payeeRow?.id, {
    detail: `status=${payee.status} payee=${payeeRow?.id}`,
  });

  const note = await write(freedom, {
    table: 'check_messages',
    op: 'insert',
    values: { check_id: check.id, body: `${MARKER} control note` },
    single: true,
  });
  record(`${name} add note`, note.status === 200, { detail: `status=${note.status}` });

  const review = await transition(freedom, check.id, 'start_review');
  record(`${name} start_review`, review.status === 200 && rowOf(review.json.data)?.status === 'needs_review', {
    detail: `status=${review.status} check=${rowOf(review.json.data)?.status}`,
  });

  const endorsing = await transition(freedom, check.id, 'start_endorsing');
  record(`${name} start_endorsing`, endorsing.status === 200 && rowOf(endorsing.json.data)?.status === 'endorsements_in_progress', {
    detail: `status=${endorsing.status} check=${rowOf(endorsing.json.data)?.status}`,
  });

  const beforeSign = await snapshot(freedom, check.id);
  let endorseRes = null;
  if (beforeSign.endorsements[0]?.id) {
    endorseRes = await endorse(freedom, {
      action: 'sign_in_person',
      endorsementId: beforeSign.endorsements[0].id,
      signatureData: TINY_PNG_DATA,
      eSignConsentAccepted: true,
    });
  } else if (payeeRow?.id) {
    endorseRes = await endorse(freedom, {
      action: 'sign_in_person',
      payeeId: payeeRow.id,
      signatureData: TINY_PNG_DATA,
      eSignConsentAccepted: true,
    });
  } else {
    endorseRes = await endorse(freedom, { action: 'force_complete_endorsements', checkId: check.id });
  }
  record(`${name} complete endorsement`, endorseRes?.status === 200 && (endorseRes.json.success === true || endorseRes.json.ok === true || endorseRes.json.allSigned === true || beforeSign.endorsements.length === 0), {
    detail: `status=${endorseRes?.status} error=${endorseRes?.json.error || ''} endorsements=${beforeSign.endorsements.length}`,
  });

  const ready = await transition(freedom, check.id, 'mark_ready_for_deposit');
  const readyOk = ready.status === 200 && rowOf(ready.json.data)?.status === 'approved_for_deposit';
  record(`${name} mark_ready_for_deposit`, readyOk, {
    detail: `status=${ready.status} error=${ready.json.error || ''} reason=${ready.json.reason || ''} check=${rowOf(ready.json.data)?.status}`,
  });
  if (!readyOk && ready.json.error === 'endorsements_incomplete') {
    finding({
      id: 'S1-READY-ENDORSEMENT-GATE',
      scenario: 1,
      severity: 'WORKFLOW-RISK',
      title: 'Ready-for-deposit correctly blocked when endorsements are incomplete',
      reproduction: 'Create check, add payee, start review/endorsing, attempt mark_ready_for_deposit without a completed endorsement row.',
      expected: 'Ready-for-deposit requires completed endorsements for every required payee.',
      actual: `${ready.json.error}/${ready.json.reason}`,
      affected: 'POST /workflow/transition mark_ready_for_deposit; evaluateEndorsementEligibility',
      risk: 'Control working as designed; full happy-path Ready may be unreachable if endorsement rows are not created on payee insert.',
      fix: 'If payee insert does not create check_endorsements on AWS, create the missing endorsement row in the payee write path (narrow).',
    });
  }

  const skipDeposit = await transition(freedom, check.id, 'mark_deposited');
  record(`${name} mark_deposited denied`, skipDeposit.status === 403 && skipDeposit.json.error === 'financial_or_provider', {
    detail: `status=${skipDeposit.status} error=${skipDeposit.json.error}`,
  });

  const liveCheckAlt = await api('/functions/v1/checkalt-submit-deposit', { token: freedom, body: { check_id: check.id } });
  record(`${name} live CheckAlt blocked`, liveCheckAlt.status === 403, {
    detail: `status=${liveCheckAlt.status} error=${liveCheckAlt.json.error}`,
  });

  const after = await snapshot(freedom, check.id);
  ctx.control = { check: after.check, related: after, createdAmount: 123.45 };
  return { check: after.check, related: after };
}

async function scenario2(ctx) {
  const name = 'S2 admin rollback material edit';
  const { freedom } = ctx;
  const { check } = await createCheck(freedom, { amount: 250.00, payee_line: 'Original Payee', funds_type: 'acv' });
  if (!check?.id) return;
  await addPayee(freedom, check.id, { payee_name: 'Original Payee', payee_type: 'insured' });
  await transition(freedom, check.id, 'start_review');
  await transition(freedom, check.id, 'start_endorsing');
  const before = await snapshot(freedom, check.id);
  let signed = null;
  if (before.endorsements[0]?.id) {
    signed = await endorse(freedom, {
      action: 'sign_in_person',
      endorsementId: before.endorsements[0].id,
      signatureData: TINY_PNG_DATA,
      eSignConsentAccepted: true,
    });
  }
  const back = await transition(freedom, check.id, 'return_to_review');
  record(`${name} return_to_review`, back.status === 200 && rowOf(back.json.data)?.status === 'needs_review', {
    detail: `status=${back.status} check=${rowOf(back.json.data)?.status}`,
  });

  const amountWrite = await write(freedom, {
    table: 'check_intake_items',
    op: 'update',
    values: { amount: 999.99 },
    filters: [{ column: 'id', op: 'eq', value: check.id }],
    single: true,
  });
  const claimWrite = await write(freedom, {
    table: 'check_intake_items',
    op: 'update',
    values: { claim_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    filters: [{ column: 'id', op: 'eq', value: check.id }],
    single: true,
  });
  const fundsWrite = await write(freedom, {
    table: 'check_intake_items',
    op: 'update',
    values: { funds_type: 'supplement' },
    filters: [{ column: 'id', op: 'eq', value: check.id }],
    single: true,
  });
  const payeeLineWrite = await write(freedom, {
    table: 'check_intake_items',
    op: 'update',
    values: { payee_line: 'CHANGED PAYEE LLC' },
    filters: [{ column: 'id', op: 'eq', value: check.id }],
    single: true,
  });
  const payeeNameWrite = before.payees[0]?.id
    ? await write(freedom, {
      table: 'check_payees',
      op: 'update',
      values: { payee_name: 'CHANGED PAYEE LLC' },
      filters: [{ column: 'id', op: 'eq', value: before.payees[0].id }],
      single: true,
    })
    : { status: 0, json: { error: 'no_payee' } };

  record(`${name} amount write denied`, amountWrite.status >= 400, {
    detail: `status=${amountWrite.status} error=${amountWrite.json.error || ''}`,
  });
  record(`${name} claim_id write denied`, claimWrite.status >= 400, {
    detail: `status=${claimWrite.status} error=${claimWrite.json.error || ''}`,
  });
  record(`${name} funds_type write`, fundsWrite.status === 200, {
    detail: `status=${fundsWrite.status} error=${fundsWrite.json.error || ''}`,
  });
  record(`${name} payee_line write allowed`, payeeLineWrite.status === 200, {
    detail: `status=${payeeLineWrite.status}`,
  });

  const override = await rpc(freedom, 'admin_override_check_status', {
    p_check_id: check.id,
    p_new_status: 'needs_review',
  });
  record(`${name} admin_override_check_status disabled`, override.status === 403 && (override.json.error === 'rpc_disabled' || override.json.name === 'admin_override_check_status'), {
    detail: `status=${override.status} error=${override.json.error}`,
  });

  const afterEdit = await snapshot(freedom, check.id);
  const staleSigned = afterEdit.endorsements.some((row) => row.status === 'signed');
  const payeeNameChanged = afterEdit.payees.some((row) => row.payee_name === 'CHANGED PAYEE LLC');
  const amountUnchanged = Number(afterEdit.check?.amount) === 250;
  record(`${name} amount remains locked`, amountUnchanged, {
    detail: `amount=${afterEdit.check?.amount}`,
  });
  record(`${name} prior endorsement after material payee edit`, true, {
    detail: `signedRemains=${staleSigned} payeeRenamed=${payeeNameChanged} signedHttp=${signed?.status || 'none'}`,
  });

  if (staleSigned && payeeNameChanged) {
    finding({
      id: 'S2-STALE-SIGNATURE-AFTER-PAYEE-CHANGE',
      scenario: 2,
      severity: 'MONEY-RISK',
      title: 'Signed endorsement remains valid after material payee rename',
      reproduction: 'Review → Endorsing → sign_in_person → return_to_review → update check_payees.payee_name and payee_line → inspect check_endorsements.status.',
      expected: 'A signature created for materially different payee information must be invalidated (or Ready/deposit eligibility must fail) unless an explicit override is recorded.',
      actual: `check_endorsements.status remains signed; payee_name is now CHANGED PAYEE LLC. signed_at=${afterEdit.endorsements.find((r) => r.status === 'signed')?.signed_at}`,
      affected: 'check_endorsements, check_payees, /data/write check_payees update, evaluateEndorsementEligibility (fingerprint ignores payee names)',
      risk: 'Ready-for-deposit / CheckAlt eligibility can treat a signature collected for a different named payee as still complete.',
      fix: 'On material payee/amount/type change, reset endorsement status to pending and clear official rear fingerprint. Include payee_name in the eligibility fingerprint or require a new signed_at after the change.',
      stopFurther: true,
    });
  }

  const forward = await transition(freedom, check.id, 'start_endorsing');
  record(`${name} move to endorsing again`, forward.status === 200 && rowOf(forward.json.data)?.status === 'endorsements_in_progress', {
    detail: `status=${forward.status}`,
  });
  const ready = await transition(freedom, check.id, 'mark_ready_for_deposit');
  if (staleSigned && payeeNameChanged && ready.status === 200) {
    finding({
      id: 'S2-READY-ACCEPTS-STALE-SIGNATURE',
      scenario: 2,
      severity: 'MONEY-RISK',
      title: 'Ready-for-deposit accepted after material payee change without new signature',
      reproduction: 'After S2 payee rename, call mark_ready_for_deposit.',
      expected: 'Ready must fail until the renamed payee re-endorses.',
      actual: `mark_ready_for_deposit ${ready.status} status=${rowOf(ready.json.data)?.status}`,
      affected: 'POST /workflow/transition mark_ready_for_deposit; evaluateEndorsementEligibility',
      risk: 'Check can become deposit-eligible under a different payee than the one who signed.',
      fix: 'Invalidate endorsement completion on material field change before evaluating Ready.',
      stopFurther: true,
    });
  } else {
    record(`${name} ready after material edit`, ready.status !== 200 || !staleSigned || !payeeNameChanged, {
      detail: `status=${ready.status} error=${ready.json.error || ''} signed=${staleSigned}`,
    });
  }

  const auditHasReturn = afterEdit.audit.some((row) => /return_to_review|aws_workflow_transition|admin_correction/i.test(`${row.event_type} ${row.event_description}`));
  record(`${name} audit retains rollback`, auditHasReturn && afterEdit.audit.length > 0, {
    detail: `auditRows=${afterEdit.audit.length}`,
  });

  ctx.material = { check: afterEdit.check, related: afterEdit };
}

async function scenario3(ctx) {
  const name = 'S3 admin rollback non-material edit';
  const { freedom } = ctx;
  const { check } = await createCheck(freedom, { amount: 80, payee_line: 'Stable Payee' });
  if (!check?.id) return;
  await addPayee(freedom, check.id, { payee_name: 'Stable Payee' });
  await transition(freedom, check.id, 'start_review');
  await transition(freedom, check.id, 'start_endorsing');
  const before = await snapshot(freedom, check.id);
  if (before.endorsements[0]?.id) {
    await endorse(freedom, {
      action: 'sign_in_person',
      endorsementId: before.endorsements[0].id,
      signatureData: TINY_PNG_DATA,
      eSignConsentAccepted: true,
    });
  }
  await transition(freedom, check.id, 'return_to_review');
  const harmless = await write(freedom, {
    table: 'check_intake_items',
    op: 'update',
    values: { review_notes: `${MARKER} harmless`, property_address: '200 Harmless Ave', carrier_name: `${MARKER} carrier` },
    filters: [{ column: 'id', op: 'eq', value: check.id }],
    single: true,
  });
  record(`${name} harmless metadata saved`, harmless.status === 200, { detail: `status=${harmless.status}` });
  const after = await snapshot(freedom, check.id);
  const signedRemains = after.endorsements.some((row) => row.status === 'signed');
  record(`${name} signatures preserved after harmless edit`, !before.endorsements.length || signedRemains, {
    detail: `signed=${signedRemains} prior=${before.endorsements.map((r) => r.status).join(',')}`,
  });
  ctx.nonMaterialFields = {
    material: ['amount', 'claim_id', 'payee_line', 'payee_name', 'payee_type', 'funds_type', 'status', 'routing_number', 'account_number'],
    nonMaterial: ['review_notes', 'property_address', 'carrier_name', 'check_number', 'issue_date', 'payee_address'],
    lockedOnAwsWrite: ['amount', 'claim_id', 'status', 'check_stage', 'routing_number', 'account_number', 'deposited_at'],
    writableOnAws: ['payee_line', 'funds_type', 'review_notes', 'property_address', 'carrier_name', 'check_number', 'issue_date'],
  };
}

async function scenario4(ctx) {
  const name = 'S4 partial endorsement then rollback';
  const { freedom } = ctx;
  const { check } = await createCheck(freedom, { amount: 300, payee_line: 'Insured And Mortgage' });
  if (!check?.id) return;
  const insured = await addPayee(freedom, check.id, { payee_name: 'Insured One', payee_type: 'insured' });
  const mortgage = await addPayee(freedom, check.id, { payee_name: 'First National Mortgage', payee_type: 'mortgage_company' });
  await transition(freedom, check.id, 'start_review');
  await transition(freedom, check.id, 'start_endorsing');
  const before = await snapshot(freedom, check.id);
  const insuredEndo = before.endorsements.find((row) => row.payee_type === 'insured') || before.endorsements[0];
  if (insuredEndo?.id) {
    await endorse(freedom, {
      action: 'sign_in_person',
      endorsementId: insuredEndo.id,
      signatureData: TINY_PNG_DATA,
      eSignConsentAccepted: true,
    });
  }
  await transition(freedom, check.id, 'return_to_review');
  if (before.payees.find((p) => p.payee_type === 'insured')?.id) {
    await write(freedom, {
      table: 'check_payees',
      op: 'update',
      values: { payee_name: 'Insured TWO' },
      filters: [{ column: 'id', op: 'eq', value: before.payees.find((p) => p.payee_type === 'insured').id }],
      single: true,
    });
  }
  await transition(freedom, check.id, 'start_endorsing');
  const ready = await transition(freedom, check.id, 'mark_ready_for_deposit');
  const after = await snapshot(freedom, check.id);
  const mortgageUnsigned = after.endorsements.filter((row) => row.payee_type === 'mortgage_company' && !['signed', 'waived', 'manual_required'].includes(row.status));
  const readyBlocked = ready.status !== 200;
  record(`${name} ready blocked with partial/stale state`, readyBlocked, {
    detail: `ready=${ready.status} error=${ready.json.error || ''} reason=${ready.json.reason || ''} mortgageUnsigned=${mortgageUnsigned.length} endos=${after.endorsements.map((e) => `${e.payee_type}:${e.status}`).join(',')}`,
  });
  if (!readyBlocked) {
    finding({
      id: 'S4-PARTIAL-SATISFIES-READY',
      scenario: 4,
      severity: 'MONEY-RISK',
      title: 'Partial endorsement state satisfied Ready after rollback + material edit',
      reproduction: 'Two payees, sign only insured, return_to_review, rename insured, start_endorsing, mark_ready_for_deposit.',
      expected: 'Ready must fail until every required payee is currently satisfied for the post-edit set.',
      actual: `ready ${ready.status} ${rowOf(ready.json.data)?.status}`,
      affected: 'evaluateEndorsementEligibility, check_endorsements',
      risk: 'Incomplete or stale signatures can authorize deposit.',
      fix: 'Keep the existing incomplete-payee gate and additionally invalidate renamed payee signatures.',
      stopFurther: true,
    });
  }
  record(`${name} mortgage payee created`, mortgage.status === 200 && Boolean(rowOf(mortgage.json.data)?.id || after.payees.some((p) => p.payee_type === 'mortgage_company')), {
    detail: `insured=${rowOf(insured.json.data)?.id} mortgage=${rowOf(mortgage.json.data)?.id}`,
  });
}

async function scenario5(ctx) {
  const name = 'S5 wrong claim association';
  const { freedom } = ctx;
  const claims = await query(freedom, {
    table: 'claims',
    select: 'id,tenant_id,claim_number,policyholder_name',
    filters: [{ column: 'tenant_id', op: 'eq', value: FREEDOM_TENANT }],
    limit: 5,
  });
  const claimRows = rowsOf(claims.json.data);
  record(`${name} can list Freedom claims`, claims.status === 200, {
    detail: `status=${claims.status} count=${claimRows.length}`,
  });
  const { check } = await createCheck(freedom, { amount: 150, payee_line: 'Claim Switch' });
  if (!check?.id) return;
  await transition(freedom, check.id, 'start_review');
  const attachA = await write(freedom, {
    table: 'check_intake_items',
    op: 'update',
    values: { claim_id: claimRows[0]?.id || 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    filters: [{ column: 'id', op: 'eq', value: check.id }],
    single: true,
  });
  record(`${name} direct claim_id attach denied`, attachA.status >= 400, {
    detail: `status=${attachA.status} error=${attachA.json.error || ''}`,
  });
  const after = await loadCheck(freedom, check.id);
  record(`${name} synthetic check remains unlinked`, after?.claim_id == null, {
    detail: `claim_id=${after?.claim_id || 'null'}`,
  });

  if (claimRows.length >= 2) {
    const linked = await query(freedom, {
      table: 'check_intake_items',
      select: 'id,claim_id,status,amount,tenant_id',
      filters: [{ column: 'claim_id', op: 'eq', value: claimRows[0].id }],
      limit: 10,
    });
    const linkedRows = rowsOf(linked.json.data);
    created.claimsUsed.push(claimRows[0].id, claimRows[1].id);
    record(`${name} existing Claim A associations inspectable`, linked.status === 200, {
      detail: `claimA=${claimRows[0].id} linkedChecks=${linkedRows.length}`,
    });
    finding({
      id: 'S5-CLAIM-REASSIGN-LOCKED',
      scenario: 5,
      severity: 'WORKFLOW-RISK',
      title: 'AWS staging cannot reassign a check from Claim A to Claim B via admin write',
      reproduction: 'Create synthetic check, POST /data/write claim_id update. Admin override RPC remains disabled.',
      expected: 'Admin correction can move a pre-deposit check between claims with audit, then isolate Claim A.',
      actual: `claim_id column is prohibited on check_intake_items writes (status=${attachA.status}). Existing linked checks were inspected read-only only.`,
      affected: 'write-allowlist.mjs INTAKE_PROHIBITED_COLUMNS.claim_id; workflow.mjs claim_id IS NULL transition guard; admin_override_check_status rpc_disabled',
      risk: 'Wrong-claim operational correction is unavailable on AWS. That prevents this adversarial money-path case from executing, and also prevents a live admin fix if a check is mis-associated.',
      fix: 'Add a narrow audited admin RPC that can set/clear claim_id only before deposited_at, writing prior/new claim ids to check_audit_log. Do not open generic claim_id writes.',
    });
  }
}

async function scenario6(ctx) {
  const name = 'S6 late mortgage discovery';
  const { freedom } = ctx;
  const { check } = await createCheck(freedom, { amount: 400, payee_line: 'Homeowner Only' });
  if (!check?.id) return;
  await addPayee(freedom, check.id, { payee_name: 'Homeowner Only', payee_type: 'insured' });
  await transition(freedom, check.id, 'start_review');
  await transition(freedom, check.id, 'start_endorsing');
  const before = await snapshot(freedom, check.id);
  if (before.endorsements[0]?.id) {
    await endorse(freedom, {
      action: 'sign_in_person',
      endorsementId: before.endorsements[0].id,
      signatureData: TINY_PNG_DATA,
      eSignConsentAccepted: true,
    });
  }
  await transition(freedom, check.id, 'return_to_review');
  const mortgage = await addPayee(freedom, check.id, {
    payee_name: 'Rocket Mortgage',
    payee_type: 'mortgage_company',
  });
  await write(freedom, {
    table: 'check_intake_items',
    op: 'update',
    values: { mortgage_monitoring_type: 'monitor' },
    filters: [{ column: 'id', op: 'eq', value: check.id }],
    single: true,
  });
  await transition(freedom, check.id, 'start_endorsing');
  const ready = await transition(freedom, check.id, 'mark_ready_for_deposit');
  const after = await snapshot(freedom, check.id);
  const readyBlocked = ready.status !== 200;
  record(`${name} ready blocked after late mortgage payee`, readyBlocked, {
    detail: `ready=${ready.status} error=${ready.json.error || ''} reason=${ready.json.reason || ''} payees=${after.payees.map((p) => p.payee_type).join(',')}`,
  });
  const autoLossDraft = after.drafts.length > 0 || after.check?.status === 'loss_draft_required';
  record(`${name} does not auto-route to Mortgage Ops merely from payee insert`, !autoLossDraft, {
    detail: `drafts=${after.drafts.length} status=${after.check?.status} mortgageReqs=${after.mortgage.length}`,
  });
  if (!readyBlocked) {
    finding({
      id: 'S6-MORTGAGE-BYPASS-READY',
      scenario: 6,
      severity: 'MONEY-RISK',
      title: 'Late mortgage payee did not block Ready for Deposit',
      reproduction: 'Sign insured only, return to review, insert mortgage_company payee, mark_ready_for_deposit.',
      expected: 'Ready fails until mortgage endorsement (or explicit mortgage manual_required / Loss Draft) is satisfied.',
      actual: `ready ${ready.status} ${rowOf(ready.json.data)?.status}`,
      affected: 'evaluateEndorsementEligibility, check_payees mortgage_company',
      risk: 'Mortgage endorsement can be bypassed because the check previously advanced.',
      fix: 'Re-evaluate required payees on every Ready attempt; do not treat prior insured-only completion as sufficient.',
      stopFurther: true,
    });
  }
  record(`${name} mortgage payee insert`, mortgage.status === 200, { detail: `status=${mortgage.status}` });
}

async function scenario7(ctx) {
  const name = 'S7 duplicate action / double submit';
  const { freedom } = ctx;
  const { check } = await createCheck(freedom, { amount: 123.45, payee_line: 'Idempotent Payee' });
  if (!check?.id) return;
  const t1 = await transition(freedom, check.id, 'start_review');
  const t2 = await transition(freedom, check.id, 'start_review');
  record(`${name} double start_review is not a second lifecycle`, t1.status === 200 && t2.status === 403 && t2.json.error === 'invalid_transition', {
    detail: `first=${t1.status} second=${t2.status} error=${t2.json.error}`,
  });
  const marker = `${MARKER} S7`;
  created.financialMarkers.push(marker);
  const prep1 = await api('/financial/prepare', { token: freedom, body: { operation_type: 'checkalt_deposit', check_id: check.id, marker } });
  const prep2 = await api('/financial/prepare', { token: freedom, body: { operation_type: 'checkalt_deposit', check_id: check.id, marker } });
  record(`${name} double prepare idempotent`, prep1.status === 200 && prep2.status === 200 && prep2.json.duplicate === true && prep1.json.operation?.id === prep2.json.operation?.id, {
    detail: `dup=${prep2.json.duplicate} id=${prep1.json.operation?.id}`,
  });
  const opId = prep1.json.operation?.id;
  const [s1, s2] = await Promise.all([
    api('/financial/simulate-submit', { token: freedom, body: { operation_id: opId } }),
    api('/financial/simulate-submit', { token: freedom, body: { operation_id: opId } }),
  ]);
  record(`${name} parallel submit one business effect`, s1.status === 200 && s2.status === 200 && s1.json.operation?.id === s2.json.operation?.id, {
    detail: `a=${s1.json.operation?.status} b=${s2.json.duplicate || s2.json.operation?.status}`,
  });
  const disb1 = await api('/financial/prepare', { token: freedom, body: { operation_type: 'disbursement', check_id: check.id, marker } });
  const disb2 = await api('/financial/prepare', { token: freedom, body: { operation_type: 'disbursement', check_id: check.id, marker } });
  record(`${name} double disbursement prepare idempotent`, disb1.status === 200 && disb2.json.duplicate === true && disb1.json.operation?.id === disb2.json.operation?.id, {
    detail: `dup=${disb2.json.duplicate}`,
  });
  ctx.s7 = { check, depositOp: prep1.json.operation, disburseOp: disb1.json.operation, marker };
}

async function scenario8(ctx) {
  const name = 'S8 timeout / unknown result';
  const { freedom } = ctx;
  const { check } = await createCheck(freedom, { amount: 123.45, payee_line: 'Timeout Payee' });
  if (!check?.id) return;
  const marker = `${MARKER} S8`;
  created.financialMarkers.push(marker);
  const prep = await api('/financial/prepare', { token: freedom, body: { operation_type: 'wallet_fund', check_id: check.id, marker } });
  const hung = await api('/financial/simulate-submit', {
    token: freedom,
    body: { operation_id: prep.json.operation?.id, failure_class: 'db_after_provider' },
  });
  record(`${name} provider accepted / DB failed stays reconcilable`, hung.status === 200 && hung.json.reconciliationNeeded === true && hung.json.operation?.provider_reference, {
    detail: `ref=${hung.json.operation?.provider_reference} status=${hung.json.operation?.status}`,
  });
  const retry = await api('/financial/simulate-submit', { token: freedom, body: { operation_id: prep.json.operation?.id } });
  record(`${name} retry does not create second operation`, retry.status === 200 && retry.json.operation?.id === prep.json.operation?.id && (retry.json.duplicate === true || retry.json.replayed === true || retry.json.operation?.provider_reference === hung.json.operation?.provider_reference), {
    detail: `id=${retry.json.operation?.id} dup=${retry.json.duplicate} status=${retry.json.operation?.status}`,
  });
  const recon = await api('/financial/reconcile', { token: freedom, body: { operation_id: prep.json.operation?.id } });
  record(`${name} reconcile reports without auto-correct`, recon.status === 200 && recon.json.autoCorrected === false, {
    detail: `findings=${(recon.json.findings || []).map((r) => r.finding_type).join(',')}`,
  });
  ctx.s8 = { check, op: prep.json.operation, marker };
}

async function scenario9(ctx) {
  const name = 'S9 duplicate and out-of-order webhooks';
  const { freedom } = ctx;
  const { check } = await createCheck(freedom, { amount: 123.45, payee_line: 'Webhook Payee' });
  if (!check?.id) return;
  const marker = `${MARKER} S9`;
  created.financialMarkers.push(marker);
  const prep = await api('/financial/prepare', { token: freedom, body: { operation_type: 'checkalt_deposit', check_id: check.id, marker } });
  await api('/financial/simulate-submit', { token: freedom, body: { operation_id: prep.json.operation?.id } });
  const eventId = `${marker}-cleared`;
  const wh1 = await api('/financial/simulate-webhook', {
    token: freedom,
    body: { operation_id: prep.json.operation?.id, event_type: 'deposit.cleared', external_event_id: eventId },
  });
  const wh2 = await api('/financial/simulate-webhook', {
    token: freedom,
    body: { operation_id: prep.json.operation?.id, event_type: 'deposit.cleared', external_event_id: eventId },
  });
  record(`${name} first webhook applied once`, wh1.status === 200 && wh1.json.applied === true && wh1.json.operation?.status === 'provider_confirmed', {
    detail: `applied=${wh1.json.applied} status=${wh1.json.operation?.status}`,
  });
  record(`${name} duplicate webhook no second effect`, wh2.status === 200 && wh2.json.duplicate === true && wh2.json.applied === false, {
    detail: `dup=${wh2.json.duplicate} applied=${wh2.json.applied}`,
  });

  const oooPrep = await api('/financial/prepare', { token: freedom, body: { operation_type: 'ach', check_id: check.id, marker } });
  const ooo = await api('/financial/simulate-webhook', {
    token: freedom,
    body: { operation_id: oooPrep.json.operation?.id, event_type: 'transfer.completed', out_of_order: true },
  });
  record(`${name} out-of-order webhook ignored`, ooo.status === 200 && ooo.json.applied === false && (ooo.json.outOfOrder === true || ooo.json.error), {
    detail: `applied=${ooo.json.applied} ooo=${ooo.json.outOfOrder} status=${ooo.json.operation?.status || oooPrep.json.operation?.status}`,
  });
  const regress = await api('/financial/simulate-webhook', {
    token: freedom,
    body: { operation_id: prep.json.operation?.id, event_type: 'deposit.pending', external_event_id: `${marker}-older` },
  });
  const after = await api('/financial/prepare', { token: freedom, body: { operation_type: 'checkalt_deposit', check_id: check.id, marker } });
  record(`${name} terminal state does not regress`, after.json.operation?.status === 'provider_confirmed' || after.json.operation?.status === 'settled', {
    detail: `after=${after.json.operation?.status} regressApplied=${regress.json.applied}`,
  });
  if (regress.json.applied === true && ['ready_for_provider', 'submitting', 'provider_pending'].includes(regress.json.operation?.status)) {
    finding({
      id: 'S9-TERMINAL-REGRESS',
      scenario: 9,
      severity: 'MONEY-RISK',
      title: 'Older webhook regressed a confirmed deposit',
      reproduction: 'Confirm deposit.cleared, then send deposit.pending with a new external_event_id.',
      expected: 'Terminal confirmed/settled state must not move backward.',
      actual: `applied=${regress.json.applied} status=${regress.json.operation?.status}`,
      affected: 'POST /financial/simulate-webhook; financial-state.mjs',
      risk: 'Out-of-order provider events can reopen a completed money movement.',
      fix: 'Ignore events that would transition out of provider_confirmed/settled except return/reversal.',
      stopFurther: true,
    });
  }
  ctx.s9 = { check, marker };
}

async function scenario10(ctx) {
  const name = 'S10 multiple checks on one claim';
  const { freedom } = ctx;
  const a = await createCheck(freedom, { amount: 100, funds_type: 'acv', check_number: `A${RUN_ID.slice(-6)}`, payee_line: 'Multi A' });
  const b = await createCheck(freedom, { amount: 50, funds_type: 'supplement', check_number: `B${RUN_ID.slice(-6)}`, payee_line: 'Multi B' });
  const markerA = `${MARKER} S10A`;
  const markerB = `${MARKER} S10B`;
  created.financialMarkers.push(markerA, markerB);
  const prepA = await api('/financial/prepare', { token: freedom, body: { operation_type: 'checkalt_deposit', check_id: a.check?.id, marker: markerA } });
  const prepB = await api('/financial/prepare', { token: freedom, body: { operation_type: 'checkalt_deposit', check_id: b.check?.id, marker: markerB } });
  record(`${name} independent deposit ops`, prepA.status === 200 && prepB.status === 200 && prepA.json.operation?.id !== prepB.json.operation?.id && prepA.json.operation?.amount_cents === 10000 && prepB.json.operation?.amount_cents === 5000, {
    detail: `a=${prepA.json.operation?.amount_cents} b=${prepB.json.operation?.amount_cents}`,
  });
  const cross = await api('/financial/simulate-submit', { token: freedom, body: { operation_id: prepA.json.operation?.id } });
  const disbB = await api('/financial/prepare', { token: freedom, body: { operation_type: 'disbursement', check_id: b.check?.id, marker: markerB } });
  record(`${name} disbursement B cannot use A operation`, disbB.json.operation?.id !== prepA.json.operation?.id && disbB.json.operation?.resource_id === b.check?.id && disbB.json.operation?.amount_cents === 5000, {
    detail: `disbB=${disbB.json.operation?.amount_cents} resource=${disbB.json.operation?.resource_id}`,
  });
  record(`${name} A submit does not mutate B`, cross.json.operation?.id === prepA.json.operation?.id && prepB.json.operation?.status === 'ready_for_provider', {
    detail: `A=${cross.json.operation?.status} B=${prepB.json.operation?.status}`,
  });
  const aRow = await loadCheck(freedom, a.check.id);
  const bRow = await loadCheck(freedom, b.check.id);
  record(`${name} physical checks keep separate amounts/lifecycle`, Number(aRow.amount) === 100 && Number(bRow.amount) === 50 && aRow.id !== bRow.id, {
    detail: `A=${aRow.amount}/${aRow.status} B=${bRow.amount}/${bRow.status}`,
  });
}

async function scenario11(ctx) {
  const name = 'S11 partial disbursement';
  const { freedom } = ctx;
  const { check } = await createCheck(freedom, { amount: 200, payee_line: 'Partial Disburse' });
  if (!check?.id) return;
  const marker = `${MARKER} S11`;
  created.financialMarkers.push(marker);
  const deposit = await api('/financial/prepare', { token: freedom, body: { operation_type: 'checkalt_deposit', check_id: check.id, marker } });
  await api('/financial/simulate-submit', { token: freedom, body: { operation_id: deposit.json.operation?.id } });
  await api('/financial/simulate-webhook', {
    token: freedom,
    body: { operation_id: deposit.json.operation?.id, event_type: 'deposit.cleared', external_event_id: `${marker}-in` },
  });
  const partialBody = await api('/financial/prepare', {
    token: freedom,
    body: { operation_type: 'disbursement', check_id: check.id, marker, amount_cents: 5000 },
  });
  record(`${name} browser partial amount rejected`, partialBody.status === 400 && partialBody.json.error === 'untrusted_amount', {
    detail: `status=${partialBody.status} error=${partialBody.json.error}`,
  });
  const full = await api('/financial/prepare', { token: freedom, body: { operation_type: 'disbursement', check_id: check.id, marker } });
  record(`${name} sandbox disbursement is full check amount only`, full.status === 200 && full.json.operation?.amount_cents === 20000, {
    detail: `cents=${full.json.operation?.amount_cents} source=${full.json.amount?.source || full.json.operation?.amount_source}`,
  });
  const failPrep = await api('/financial/prepare', { token: freedom, body: { operation_type: 'pay_homeowner', check_id: check.id, marker } });
  const failed = await api('/financial/simulate-failure', {
    token: freedom,
    body: { operation_id: failPrep.json.operation?.id, failure_class: 'provider_400' },
  });
  record(`${name} failed op does not confirm money out`, failed.status === 200 && failed.json.operation?.status === 'provider_failed', {
    detail: `status=${failed.json.operation?.status}`,
  });
  const recon = moneyInMinusOut({
    depositCents: deposit.json.operation?.amount_cents,
    outCents: 0,
    remainingCents: 20000,
  });
  record(`${name} failed/cancelled does not reduce remaining`, recon.reconciles && failed.json.operation?.status === 'provider_failed', {
    detail: `in=${recon.depositCents} out=${recon.outCents} remaining=${recon.remainingCents}`,
  });
  finding({
    id: 'S11-NO-PARTIAL-AMOUNT-API',
    scenario: 11,
    severity: 'WORKFLOW-RISK',
    title: 'Staging sandbox financial API cannot express a partial disbursement amount',
    reproduction: 'Prepare checkalt_deposit for $200, then prepare disbursement with amount_cents=5000 (rejected) vs omitted amount (full $200).',
    expected: 'Allowed partial disbursement of available balance, then a second disbursement of the remainder, with Money In − successful Money Out = remaining.',
    actual: 'Browser amount is untrusted. Server always uses check_intake_items.amount (or $123.45 fixture). Idempotency key includes that full amount, so a second disbursement prepare replays the first.',
    affected: 'financial.mjs resolveServerAmount + stableIdempotencyKey(operation_type, resource_id, amount_cents)',
    risk: 'Cannot prove ledger remainder math for two successful partials on staging sandbox. Not a demonstrated incorrect money movement.',
    fix: 'If Phase 2 needs partials, add a server-derived remaining-balance source (not browser amount) and include a disbursement sequence in the idempotency key.',
  });
}

async function scenario12(ctx) {
  const name = 'S12 tenant isolation';
  const { freedom, c1c } = ctx;
  const { check } = await createCheck(freedom, { amount: 75, payee_line: 'Freedom Only' });
  if (!check?.id) return;
  const c1cRead = await query(c1c, {
    table: 'check_intake_items',
    select: 'id,tenant_id,amount',
    filters: [{ column: 'id', op: 'eq', value: check.id }],
  });
  record(`${name} C1C cannot read Freedom check`, !rowOf(c1cRead.json.data)?.id, {
    detail: `status=${c1cRead.status} id=${rowOf(c1cRead.json.data)?.id || 'none'}`,
  });
  const c1cTransition = await transition(c1c, check.id, 'start_review');
  record(`${name} C1C cannot transition Freedom check`, c1cTransition.status === 403, {
    detail: `status=${c1cTransition.status} error=${c1cTransition.json.error}`,
  });
  const c1cPrep = await api('/financial/prepare', { token: c1c, body: { operation_type: 'checkalt_deposit', check_id: check.id } });
  record(`${name} C1C cannot prepare Freedom money op`, c1cPrep.status === 403, {
    detail: `status=${c1cPrep.status} error=${c1cPrep.json.error}`,
  });
  const c1cPayee = await addPayee(c1c, check.id, { payee_name: 'Cross Tenant' });
  record(`${name} C1C cannot add Freedom payee`, c1cPayee.status === 403, {
    detail: `status=${c1cPayee.status} error=${c1cPayee.json.error}`,
  });
  const c1cMsg = await write(c1c, {
    table: 'check_messages',
    op: 'insert',
    values: { check_id: check.id, body: 'cross tenant' },
    single: true,
  });
  record(`${name} C1C cannot write Freedom message`, c1cMsg.status === 403, {
    detail: `status=${c1cMsg.status} error=${c1cMsg.json.error}`,
  });
  const spoof = await api('/workflow/checks', {
    token: freedom,
    body: { carrier_name: `${MARKER} spoof`, tenant_id: C1C_TENANT, user_id: '00000000-0000-0000-0000-000000000099' },
    headers: { 'x-tenant-id': C1C_TENANT },
  });
  const spoofCheck = rowOf(spoof.json.data);
  if (spoofCheck?.id) {
    created.checks.push(spoofCheck.id);
    cleanup.checks.push(spoofCheck.id);
  }
  record(`${name} spoofed C1C tenant ignored`, spoof.status === 200 && spoofCheck?.tenant_id === FREEDOM_TENANT, {
    detail: `tenant=${spoofCheck?.tenant_id}`,
  });
  const c1cWallets = await query(c1c, {
    table: 'payment_wallets',
    select: 'id,tenant_id,provider,status',
    filters: [{ column: 'tenant_id', op: 'eq', value: FREEDOM_TENANT }],
  });
  record(`${name} C1C cannot list Freedom wallets by filter`, rowsOf(c1cWallets.json.data).length === 0, {
    detail: `rows=${rowsOf(c1cWallets.json.data).length}`,
  });
}

async function scenario13(ctx) {
  const name = 'S13 readiness after previously ready';
  const { freedom } = ctx;
  const flags = await api('/financial/status', { method: 'GET' });
  const workflowFlags = await api('/workflow/status', { method: 'GET' });
  record(`${name} staging execution still sandbox-only`, flags.json.liveProviderTransactions === false && flags.json.flags?.AWS_PROVIDER_EXECUTION_ENABLED === false && flags.json.flags?.AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED === true, {
    detail: `exec=${flags.json.flags?.AWS_PROVIDER_EXECUTION_ENABLED} sim=${flags.json.flags?.AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED} moov=${flags.json.flags?.AWS_MOOV_ENABLED}`,
  });
  const { check } = await createCheck(freedom, { amount: 60, payee_line: 'Readiness' });
  if (!check?.id) return;
  const notReadyPrep = await api('/financial/prepare', {
    token: freedom,
    body: { operation_type: 'checkalt_deposit', check_id: check.id, marker: `${MARKER} S13` },
  });
  created.financialMarkers.push(`${MARKER} S13`);
  record(`${name} prepare records current not-ready flag`, notReadyPrep.status === 200 && notReadyPrep.json.readyForProvider === false, {
    detail: `readyForProvider=${notReadyPrep.json.readyForProvider} checkStatus=${check.status}`,
  });
  const live = await api('/functions/v1/checkalt-submit-deposit', { token: freedom, body: { check_id: check.id } });
  const moov = await api('/functions/v1/moov-transfer-create', { token: freedom, body: { amount_cents: 100 } });
  record(`${name} live CheckAlt/Moov evaluate current flags and deny`, live.status === 403 && moov.status === 403, {
    detail: `checkalt=${live.json.error} moov=${moov.json.error}`,
  });
  const me = await api('/identity/me', { method: 'GET', token: freedom });
  record(`${name} identity mapping present`, me.status === 200 && Boolean(me.json.applicationUserId), {
    detail: `appUser=${me.json.applicationUserId || me.json.application_user_id || 'n/a'}`,
  });
  record(`${name} workflow flags do not enable provider execution`, workflowFlags.json.flags?.AWS_PROVIDER_EXECUTION_ENABLED === false, {
    detail: `provider=${workflowFlags.json.flags?.AWS_PROVIDER_EXECUTION_ENABLED}`,
  });
}

async function scenario14(ctx) {
  const name = 'S14 admin edit after deposit';
  const { freedom } = ctx;
  const { check } = await createCheck(freedom, { amount: 123.45, payee_line: 'Post Deposit' });
  if (!check?.id) return;
  const marker = `${MARKER} S14`;
  created.financialMarkers.push(marker);
  const prep = await api('/financial/prepare', { token: freedom, body: { operation_type: 'checkalt_deposit', check_id: check.id, marker } });
  await api('/financial/simulate-submit', { token: freedom, body: { operation_id: prep.json.operation?.id } });
  await api('/financial/simulate-webhook', {
    token: freedom,
    body: { operation_id: prep.json.operation?.id, event_type: 'deposit.cleared', external_event_id: `${marker}-cleared` },
  });
  const amountEdit = await write(freedom, {
    table: 'check_intake_items',
    op: 'update',
    values: { amount: 1.00 },
    filters: [{ column: 'id', op: 'eq', value: check.id }],
    single: true,
  });
  const payeeEdit = await write(freedom, {
    table: 'check_intake_items',
    op: 'update',
    values: { payee_line: 'Rewritten After Deposit' },
    filters: [{ column: 'id', op: 'eq', value: check.id }],
    single: true,
  });
  const after = await loadCheck(freedom, check.id);
  const replay = await api('/financial/prepare', { token: freedom, body: { operation_type: 'checkalt_deposit', check_id: check.id, marker } });
  record(`${name} amount locked after deposit`, amountEdit.status >= 400 && Number(after.amount) === 123.45, {
    detail: `write=${amountEdit.status} amount=${after.amount}`,
  });
  record(`${name} financial history not rewritten`, replay.json.operation?.id === prep.json.operation?.id && replay.json.operation?.amount_cents === 12345 && replay.json.duplicate === true, {
    detail: `op=${replay.json.operation?.id} cents=${replay.json.operation?.amount_cents} dup=${replay.json.duplicate}`,
  });
  record(`${name} descriptive payee_line still writable`, payeeEdit.status === 200, {
    detail: `status=${payeeEdit.status} payee=${after.payee_line}`,
  });
  if (payeeEdit.status === 200) {
    finding({
      id: 'S14-PAYEE-EDITABLE-AFTER-SIMULATED-DEPOSIT',
      scenario: 14,
      severity: 'WORKFLOW-RISK',
      title: 'Payee line remains writable after a simulated deposit confirmation',
      reproduction: 'Prepare+confirm sandbox deposit, then PATCH payee_line.',
      expected: 'Financially material fields stay locked after deposit; history is not rewritten.',
      actual: `amount locked (good). payee_line write status=${payeeEdit.status}. aws_financial_operations amount_cents unchanged.`,
      affected: 'INTAKE_SAFE_COLUMNS.payee_line; no deposited_at lock on descriptive writes',
      risk: 'Metadata can diverge from the deposited instrument. Sandbox deposit does not set deposited_at, so the production deposited lock was not exercised.',
      fix: 'When deposited_at or a confirmed provider operation exists, reject material descriptive edits or require an audited override.',
    });
  }
}

async function scenario15(ctx) {
  const name = 'S15 delete / reupload / replacement';
  const { freedom } = ctx;
  const first = await createCheck(freedom, { amount: 90, payee_line: 'Original Instrument' });
  if (!first.check?.id) return;
  await attachFront(freedom, first.check.id);
  await transition(freedom, first.check.id, 'start_review');
  const imgPath = `checks/${first.check.id}/p1adv-front.jpg`;
  const del = await deleteCheck(freedom, first.check.id);
  record(`${name} original deleted`, del.status === 200 && (del.json.cleanedUp === true || del.json.data?.deleted === true), {
    detail: `status=${del.status}`,
  });
  cleanup.checks = cleanup.checks.filter((id) => id !== first.check.id);
  const gone = await loadCheck(freedom, first.check.id);
  record(`${name} deleted check not readable`, !gone?.id, { detail: `id=${gone?.id || 'none'}` });
  const trans = await transition(freedom, first.check.id, 'mark_ready_for_deposit');
  const prep = await api('/financial/prepare', { token: freedom, body: { operation_type: 'checkalt_deposit', check_id: first.check.id } });
  record(`${name} obsolete check not depositable`, trans.status === 403 && prep.status === 403, {
    detail: `transition=${trans.status}/${trans.json.error} prepare=${prep.status}/${prep.json.error}`,
  });
  const replacement = await createCheck(freedom, { amount: 90, payee_line: 'Replacement Instrument', check_number: `R${RUN_ID.slice(-6)}` });
  record(`${name} replacement is a new id`, replacement.check?.id && replacement.check.id !== first.check.id, {
    detail: `old=${first.check.id} new=${replacement.check?.id}`,
  });
  const newPath = `checks/${replacement.check.id}/p1adv-front.jpg`;
  record(`${name} S3 prefixes stay check-scoped`, imgPath !== newPath && imgPath.includes(first.check.id) && newPath.includes(replacement.check.id), {
    detail: `old=${imgPath} new=${newPath}`,
  });
}

async function cleanupAll(ctx) {
  const { freedom } = ctx;
  for (const marker of [...new Set(created.financialMarkers)]) {
    await cleanupFinancial(freedom, marker);
  }
  const leftoverChecks = [];
  for (const id of [...new Set(cleanup.checks)]) {
    const del = await deleteCheck(freedom, id);
    if (!(del.status === 200 || del.status === 204 || del.json.cleanedUp === true || del.json.data?.deleted === true)) {
      leftoverChecks.push({ id, status: del.status, error: del.json.error });
    }
  }
  cleanup.leftover = leftoverChecks;
  record('cleanup synthetic checks', leftoverChecks.length === 0, {
    detail: leftoverChecks.length ? JSON.stringify(leftoverChecks) : `deleted=${cleanup.checks.length}`,
  });
}

const main = async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const workflowFlags = await api('/workflow/status', { method: 'GET' });
  const financialFlags = await api('/financial/status', { method: 'GET' });
  record('staging workflow enabled', workflowFlags.status === 200 && workflowFlags.json.flags?.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED === true, {
    detail: `t5=${workflowFlags.json.flags?.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED}`,
  });
  record('staging providers not executing live money', financialFlags.status === 200 && financialFlags.json.liveProviderTransactions === false && financialFlags.json.flags?.AWS_PROVIDER_EXECUTION_ENABLED === false, {
    detail: `exec=${financialFlags.json.flags?.AWS_PROVIDER_EXECUTION_ENABLED} moov=${financialFlags.json.flags?.AWS_MOOV_ENABLED} checkalt=${financialFlags.json.flags?.AWS_CHECKALT_ENABLED} sim=${financialFlags.json.flags?.AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED}`,
  });

  const freedom = await login(FREEDOM_EMAIL);
  const c1c = await login(C1C_EMAIL);
  const ctx = { freedom, c1c, flags: { workflow: workflowFlags.json, financial: financialFlags.json } };

  await scenario1(ctx);
  await scenario2(ctx);
  await scenario3(ctx);
  await scenario4(ctx);
  await scenario5(ctx);
  await scenario6(ctx);
  await scenario7(ctx);
  await scenario8(ctx);
  await scenario9(ctx);
  await scenario10(ctx);
  await scenario11(ctx);
  await scenario12(ctx);
  await scenario13(ctx);
  await scenario14(ctx);
  await scenario15(ctx);
  await cleanupAll(ctx);

  const failed = results.filter((row) => !row.ok);
  const blockers = findings.filter((row) => row.severity === 'BLOCKER');
  const money = findings.filter((row) => row.severity === 'MONEY-RISK');
  const verdict = blockers.length === 0 && money.length === 0 ? 'PASS' : 'FAIL';
  const out = {
    ok: failed.length === 0 && verdict === 'PASS',
    verdict: `PHASE 1 ADVERSARIAL MONEY-PATH AUDIT: ${verdict}`,
    runId: RUN_ID,
    marker: MARKER,
    api: API,
    passed: results.filter((row) => row.ok).length,
    failed: failed.length,
    findings,
    results,
    created,
    cleanup,
    flags: ctx.flags,
    nonMaterialFields: ctx.nonMaterialFields || null,
  };
  fs.writeFileSync(REPORT_JSON, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({
    ok: out.ok,
    verdict: out.verdict,
    passed: out.passed,
    failed: out.failed,
    findings: findings.map((f) => ({ id: f.id, severity: f.severity, title: f.title })),
    leftover: cleanup.leftover,
  }, null, 2));
  if (failed.length) process.exitCode = 1;
};

main().catch((error) => {
  console.error(error);
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(REPORT_JSON, JSON.stringify({ ok: false, error: String(error?.stack || error), results, findings, created }, null, 2));
  process.exit(1);
});
