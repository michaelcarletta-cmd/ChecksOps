#!/usr/bin/env node
/**
 * Live Tranche 5 workflow validation against staging API + Cognito.
 * Creates a synthetic Freedom check, walks internal transitions to
 * READY FOR PROVIDER EXECUTION, then deletes it.
 * Does not call CheckAlt, Moov, or any payment provider.
 * Does not touch production Supabase.
 */
import fs from 'node:fs';

const API = process.env.CHECKSOPS_API_URL || 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const FREEDOM_EMAIL = 'checksops-tester@freedomadj.com';
const C1C_EMAIL = 'payments@condition1commercial.com';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const MARKER = `AWS T5 TEST ${Date.now()}`;

const passwords = JSON.parse(fs.readFileSync(process.env.COGNITO_PASSWORD_FILE || '/tmp/cognito-login-passwords.json', 'utf8'));

const results = [];
const record = (name, ok, extra = {}) => {
  results.push({ name, ok, ...extra });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra.detail ? ` — ${extra.detail}` : ''}`);
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
  const { status, json } = await api('/auth/login', {
    body: { email, password: passwords[email] || passwords[email.toLowerCase()] },
  });
  if (status !== 200 || !json.authentication?.idToken) {
    throw new Error(`login failed for ${email}: ${status} ${json.error || json.message || ''}`);
  }
  return json.authentication.idToken;
};

const write = (token, body, extraHeaders = {}) => api('/data/write', { token, body, headers: extraHeaders });
const query = (token, body) => api('/data/query', { token, body });
const rowOf = (payload) => (Array.isArray(payload) ? payload[0] : payload);

const tinyJpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//Z',
  'base64',
);

const main = async () => {
  const flags = await api('/workflow/status', { method: 'GET' });
  record('workflow/status T5 enabled and providers false', flags.status === 200
    && flags.json.flags?.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED === true
    && flags.json.flags?.AWS_PROVIDER_EXECUTION_ENABLED === false
    && flags.json.flags?.AWS_CHECKALT_ENABLED === false
    && flags.json.productionWebhooksRedirected === false, {
    detail: `status=${flags.status} t5=${flags.json.flags?.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED}`,
  });

  const unauth = await api('/workflow/checks', { body: { carrier_name: MARKER } });
  record('unauthenticated create 401', unauth.status === 401, { detail: `status=${unauth.status} error=${unauth.json.error}` });

  const freedom = await login(FREEDOM_EMAIL);
  const c1c = await login(C1C_EMAIL);

  const created = await api('/workflow/checks', {
    token: freedom,
    body: {
      carrier_name: MARKER,
      review_notes: MARKER,
      tenant_id: C1C_TENANT,
      user_id: '00000000-0000-0000-0000-000000000099',
      uploaded_by: '00000000-0000-0000-0000-000000000099',
      claim_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
    headers: { 'x-user-id': '00000000-0000-0000-0000-000000000099', 'x-tenant-id': C1C_TENANT },
  });
  const check = rowOf(created.json.data);
  record('Freedom create check ignores spoofed tenant/user/claim', created.status === 200
    && check?.id
    && check.tenant_id === FREEDOM_TENANT
    && check.uploaded_by !== '00000000-0000-0000-0000-000000000099'
    && check.claim_id == null
    && check.status === 'uploaded'
    && created.json.ocrInvoked === false
    && created.json.providerSubmitted === false, {
    detail: `id=${check?.id} tenant=${check?.tenant_id} status=${check?.status}`,
  });
  if (!check?.id) {
    console.log(JSON.stringify({ results, created }, null, 2));
    process.exit(1);
  }

  const skip = await api('/workflow/transition', {
    token: freedom,
    body: { check_id: check.id, action: 'mark_ready_for_deposit' },
  });
  record('skip required review denied', skip.status === 403 && skip.json.error === 'invalid_transition', {
    detail: `status=${skip.status} error=${skip.json.error}`,
  });

  const c1cRead = await query(c1c, {
    table: 'check_intake_items',
    select: 'id, tenant_id, carrier_name',
    filters: [{ column: 'id', op: 'eq', value: check.id }],
  });
  const c1cRow = Array.isArray(c1cRead.json.data) ? c1cRead.json.data[0] : c1cRead.json.data;
  record('C1C cannot read Freedom synthetic check', !c1cRow?.id, {
    detail: `status=${c1cRead.status} id=${c1cRow?.id || 'none'}`,
  });

  const c1cTransition = await api('/workflow/transition', {
    token: c1c,
    body: { check_id: check.id, action: 'start_review' },
  });
  record('C1C cannot transition Freedom check', c1cTransition.status === 403, {
    detail: `status=${c1cTransition.status} error=${c1cTransition.json.error}`,
  });

  const frontPath = `checks/${check.id}/aws-t5-test-front.jpg`;
  const upload = await api('/storage/upload-url', {
    token: freedom,
    body: { bucket: 'claim-files', path: frontPath, contentType: 'image/jpeg', contentLength: tinyJpeg.length },
  });
  record('S3 upload-url for new-check image', upload.status === 200 && Boolean(upload.json.signedUrl), {
    detail: `status=${upload.status} error=${upload.json.error || ''}`,
  });
  if (upload.json.signedUrl) {
    const put = await fetch(upload.json.signedUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body: tinyJpeg,
    });
    record('S3 PUT new-check front image', put.ok || put.status === 200, { detail: `status=${put.status}` });
    const pathUpdate = await write(freedom, {
      table: 'check_intake_items',
      op: 'update',
      values: { front_image_path: frontPath, carrier_name: MARKER, review_notes: `${MARKER} descriptive` },
      filters: [{ column: 'id', op: 'eq', value: check.id }],
      single: true,
    });
    record('attach image path + descriptive edit', pathUpdate.status === 200, {
      detail: `status=${pathUpdate.status} error=${pathUpdate.json.error || ''}`,
    });
  } else {
    record('S3 PUT new-check front image', false, { detail: 'no signed url' });
    record('attach image path + descriptive edit', false, { detail: 'skipped' });
  }

  const payee = await write(freedom, {
    table: 'check_payees',
    op: 'insert',
    values: { check_id: check.id, payee_name: `${MARKER} payee`, payee_type: 'homeowner' },
    single: true,
  });
  record('add payee', payee.status === 200 && rowOf(payee.json.data)?.check_id === check.id, {
    detail: `status=${payee.status}`,
  });

  const note = await write(freedom, {
    table: 'check_messages',
    op: 'insert',
    values: { check_id: check.id, body: `${MARKER} note` },
    single: true,
  });
  record('add note', note.status === 200, { detail: `status=${note.status}` });

  const review = await api('/workflow/transition', {
    token: freedom,
    body: { check_id: check.id, action: 'start_review' },
  });
  record('start_review', review.status === 200 && rowOf(review.json.data)?.status === 'needs_review', {
    detail: `status=${review.status} check=${rowOf(review.json.data)?.status}`,
  });

  const endorsing = await api('/workflow/transition', {
    token: freedom,
    body: { check_id: check.id, action: 'start_endorsing' },
  });
  record('start_endorsing', endorsing.status === 200 && rowOf(endorsing.json.data)?.check_stage === 'endorsing', {
    detail: `status=${endorsing.status} stage=${rowOf(endorsing.json.data)?.check_stage}`,
  });

  const back = await api('/workflow/transition', {
    token: freedom,
    body: { check_id: check.id, action: 'return_to_review' },
  });
  record('return_to_review', back.status === 200 && rowOf(back.json.data)?.status === 'needs_review', {
    detail: `status=${back.status}`,
  });

  const mortgageMeta = await write(freedom, {
    table: 'check_intake_items',
    op: 'update',
    values: { mortgage_monitoring_type: 'monitored' },
    filters: [{ column: 'id', op: 'eq', value: check.id }],
    single: true,
  });
  record('mortgage monitoring metadata', mortgageMeta.status === 200, { detail: `status=${mortgageMeta.status}` });

  const desk = await write(freedom, {
    table: 'mortgage_handling_requests',
    op: 'insert',
    values: {
      check_intake_item_id: check.id,
      mortgage_company: `${MARKER} lender`,
      note: MARKER,
    },
    single: true,
  });
  record('mortgage handling request metadata', desk.status === 200 && rowOf(desk.json.data)?.requested_by !== '00000000-0000-0000-0000-000000000099', {
    detail: `status=${desk.status} error=${desk.json.error || ''}`,
  });

  const loss = await api('/workflow/transition', {
    token: freedom,
    body: { check_id: check.id, action: 'route_loss_draft' },
  });
  record('route_loss_draft', loss.status === 200 && rowOf(loss.json.data)?.status === 'loss_draft_required', {
    detail: `status=${loss.status} check=${rowOf(loss.json.data)?.status}`,
  });

  const draftQuery = await query(freedom, {
    table: 'loss_draft_tracking',
    select: 'id, notes, mortgage_servicer, check_intake_item_id',
    filters: [{ column: 'check_intake_item_id', op: 'eq', value: check.id }],
  });
  const draft = Array.isArray(draftQuery.json.data) ? draftQuery.json.data[0] : draftQuery.json.data;
  record('loss-draft tracking auto-created', Boolean(draft?.id), {
    detail: `status=${draftQuery.status} id=${draft?.id || 'none'}`,
  });
  if (draft?.id) {
    const draftUpdate = await write(freedom, {
      table: 'loss_draft_tracking',
      op: 'update',
      values: { notes: `${MARKER} ld notes`, loan_number: 'T5-LOAN' },
      filters: [{ column: 'id', op: 'eq', value: draft.id }],
      single: true,
    });
    record('loss-draft metadata update', draftUpdate.status === 200, { detail: `status=${draftUpdate.status}` });
  } else {
    record('loss-draft metadata update', false, { detail: 'no tracking row' });
  }

  const signed = await write(freedom, {
    table: 'check_endorsements',
    op: 'update',
    values: { status: 'signed', signed_at: new Date().toISOString() },
    filters: [{ column: 'check_id', op: 'eq', value: check.id }],
  });
  record('browser signed_at denied', signed.status === 403, {
    detail: `status=${signed.status} error=${signed.json.error}`,
  });

  const ready = await api('/workflow/transition', {
    token: freedom,
    body: { check_id: check.id, action: 'mark_ready_for_deposit' },
  });
  record('READY FOR PROVIDER EXECUTION', ready.status === 200
    && rowOf(ready.json.data)?.status === 'approved_for_deposit'
    && rowOf(ready.json.data)?.check_stage === 'ready_for_deposit'
    && ready.json.readyForProviderExecution === true
    && ready.json.providerExecution === false, {
    detail: `status=${ready.status} check=${rowOf(ready.json.data)?.status}/${rowOf(ready.json.data)?.check_stage}`,
  });

  const deposited = await api('/workflow/transition', {
    token: freedom,
    body: { check_id: check.id, action: 'mark_deposited' },
  });
  record('deposited transition denied', deposited.status === 403 && deposited.json.error === 'financial_or_provider', {
    detail: `status=${deposited.status}`,
  });

  const provider = await api('/functions/v1/checkalt-submit-deposit', {
    token: freedom,
    body: { checkId: check.id },
  });
  record('CheckAlt submit denied', provider.status === 403 && provider.json.error === 'provider_disabled', {
    detail: `status=${provider.status}`,
  });

  const existing = await query(freedom, {
    table: 'check_intake_items',
    select: 'id, claim_id, status',
    filters: [{ column: 'claim_id', op: 'neq', value: null }],
    limit: 1,
  });
  const claimed = Array.isArray(existing.json.data) ? existing.json.data[0] : existing.json.data;
  if (claimed?.id) {
    const claimedTransition = await api('/workflow/transition', {
      token: freedom,
      body: { check_id: claimed.id, action: 'start_review' },
    });
    record('claim-linked existing check transition denied', claimedTransition.status === 403, {
      detail: `status=${claimedTransition.status} error=${claimedTransition.json.error}`,
    });
  } else {
    record('claim-linked existing check transition denied', true, { detail: 'no claimed check visible; skipped' });
  }

  const cleanup = await api(`/workflow/checks/${check.id}`, { method: 'DELETE', token: freedom, body: {} });
  record('synthetic check cleanup', cleanup.status === 200 && cleanup.json.cleanedUp === true, {
    detail: `status=${cleanup.status} error=${cleanup.json.error || ''}`,
  });

  const gone = await query(freedom, {
    table: 'check_intake_items',
    select: 'id',
    filters: [{ column: 'id', op: 'eq', value: check.id }],
  });
  const leftover = Array.isArray(gone.json.data) ? gone.json.data[0] : gone.json.data;
  record('synthetic check no longer visible', !leftover?.id, { detail: leftover?.id || 'deleted' });

  const failed = results.filter((row) => !row.ok);
  console.log(JSON.stringify({
    passed: results.filter((row) => row.ok).length,
    failed: failed.length,
    results,
    checkId: check.id,
    marker: MARKER,
  }, null, 2));
  if (failed.length) process.exit(1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
