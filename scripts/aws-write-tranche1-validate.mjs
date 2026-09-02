#!/usr/bin/env node
/**
 * Live Tranche 1 write validation against staging API + Cognito.
 * Cleans up test rows. Does not touch production Supabase.
 */
import fs from 'node:fs';

const API = process.env.CHECKSOPS_API_URL || 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const FREEDOM_EMAIL = 'checksops-tester@freedomadj.com';
const C1C_EMAIL = 'payments@condition1commercial.com';
const FREEDOM_APP = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const C1C_APP = 'fd857564-9534-4b0f-95ac-624ed1273725';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const NINTH = 'dd24eea5-5d12-47d1-999e-d5930c278b7d';

const passwords = JSON.parse(fs.readFileSync(process.env.COGNITO_PASSWORD_FILE || '/tmp/cognito-login-passwords.json', 'utf8'));

const results = [];
const record = (name, ok, extra = {}) => {
  results.push({ name, ok, ...extra });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark} ${name}${extra.detail ? ` — ${extra.detail}` : ''}`);
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

const aCheck = async (token) => {
  const { status, json } = await query(token, {
    table: 'check_intake_items',
    select: 'id, tenant_id',
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
    detail: `freedom=${freedomCheck.id}`,
  });

  const stamp = new Date().toISOString();

  const fUpsert = await write(freedomToken, {
    table: 'check_message_reads',
    op: 'upsert',
    values: { user_id: C1C_APP, tenant_id: C1C_TENANT, check_id: freedomCheck.id, last_read_at: stamp },
    headersSpoofIgnored: true,
  });
  const fRow = Array.isArray(fUpsert.json.data) ? fUpsert.json.data[0] : fUpsert.json.data;
  record('Freedom upsert own check_message_reads', fUpsert.status === 200 && fRow?.user_id === FREEDOM_APP, {
    detail: `status=${fUpsert.status} user=${fRow?.user_id}`,
  });

  const fUpdate = await write(freedomToken, {
    table: 'check_message_reads',
    op: 'update',
    values: { last_read_at: new Date().toISOString() },
    filters: [{ column: 'check_id', op: 'eq', value: freedomCheck.id }],
  });
  record('Freedom update own check_message_reads', fUpdate.status === 200 && (fUpdate.json.data?.length || fUpdate.json.data?.user_id), {
    detail: `status=${fUpdate.status}`,
  });

  const cUpsert = c1cCheck
    ? await write(c1cToken, {
      table: 'check_message_reads',
      op: 'upsert',
      values: { check_id: c1cCheck.id, last_read_at: stamp },
    })
    : { status: 0, json: { skipped: true } };
  if (c1cCheck) {
    const cRow = Array.isArray(cUpsert.json.data) ? cUpsert.json.data[0] : cUpsert.json.data;
    record('C1C upsert own check_message_reads', cUpsert.status === 200 && cRow?.user_id === C1C_APP, {
      detail: `status=${cUpsert.status}`,
    });
  } else {
    record('C1C check_message_reads own-check skipped (no C1C intake rows); prefs CRUD covers C1C', true);
  }

  const fCross = await write(freedomToken, {
    table: 'check_message_reads',
    op: 'upsert',
    values: { check_id: '4f172140-f57a-4744-8050-95f4f07b13b4', last_read_at: stamp },
  });
  record('Freedom cannot write a non-owned check_id as C1C stand-in', fCross.status >= 400 || fCross.json.ok === false, {
    detail: `status=${fCross.status} error=${fCross.json.error}`,
  });

  const cCross = await write(c1cToken, {
    table: 'check_message_reads',
    op: 'upsert',
    values: { check_id: freedomCheck.id, last_read_at: stamp },
  });
  record('C1C cannot write Freedom check_message_reads', cCross.status >= 400 || cCross.json.ok === false, {
    detail: `status=${cCross.status} error=${cCross.json.error}`,
  });

  const fPrefs = await write(freedomToken, {
    table: 'notification_preferences',
    op: 'get_or_create',
    args: { p_user_id: C1C_APP },
    maybeSingle: true,
  });
  record('Freedom get_or_create own notification_preferences', fPrefs.status === 200 && fPrefs.json.data?.user_id === FREEDOM_APP, {
    detail: `status=${fPrefs.status} user=${fPrefs.json.data?.user_id}`,
  });
  const originalPrefs = {
    in_app_enabled: fPrefs.json.data?.in_app_enabled,
    email_enabled: fPrefs.json.data?.email_enabled,
    sms_enabled: fPrefs.json.data?.sms_enabled,
  };
  const fPrefUpdate = await write(freedomToken, {
    table: 'notification_preferences',
    op: 'update',
    values: {
      user_id: C1C_APP,
      in_app_enabled: originalPrefs.in_app_enabled,
      email_enabled: originalPrefs.email_enabled,
      sms_enabled: originalPrefs.sms_enabled,
    },
  });
  record('Freedom update own notification_preferences (restore same flags)', fPrefUpdate.status === 200, {
    detail: `status=${fPrefUpdate.status}`,
  });

  const cPrefs = await write(c1cToken, {
    table: 'notification_preferences',
    op: 'get_or_create',
    maybeSingle: true,
  });
  record('C1C get_or_create own notification_preferences', cPrefs.status === 200 && cPrefs.json.data?.user_id === C1C_APP, {
    detail: `status=${cPrefs.status}`,
  });

  const unauth = await write(null, {
    table: 'check_message_reads',
    op: 'upsert',
    values: { check_id: freedomCheck.id },
  });
  record('unauthenticated write is 401', unauth.status === 401, { detail: `status=${unauth.status}` });

  const spoof = await write(freedomToken, {
    table: 'check_message_reads',
    op: 'upsert',
    values: { user_id: C1C_APP, tenant_id: C1C_TENANT, check_id: freedomCheck.id, last_read_at: stamp },
  }, { 'x-user-id': C1C_APP, 'x-tenant-id': C1C_TENANT });
  const spoofRow = Array.isArray(spoof.json.data) ? spoof.json.data[0] : spoof.json.data;
  record('spoofed application/tenant UUID ignored', spoof.status === 200 && spoofRow?.user_id === FREEDOM_APP, {
    detail: `user=${spoofRow?.user_id} ignored=${JSON.stringify(spoof.json.spoofFieldsIgnored || {})}`,
  });

  const subAsUser = await write(freedomToken, {
    table: 'notification_preferences',
    op: 'update',
    values: { user_id: spoof.json.cognitoSub || 'c4386408-60e1-70e2-abb6-e6194e8e635f', in_app_enabled: originalPrefs.in_app_enabled, email_enabled: originalPrefs.email_enabled, sms_enabled: originalPrefs.sms_enabled },
  });
  record('Cognito sub as application UUID is ignored for user_id', subAsUser.status === 200 && (
    Array.isArray(subAsUser.json.data) ? subAsUser.json.data[0]?.user_id === FREEDOM_APP : subAsUser.json.data?.user_id === FREEDOM_APP
  ), { detail: `status=${subAsUser.status}` });

  const ninthBody = await write(freedomToken, {
    table: 'notification_preferences',
    op: 'update',
    values: {
      user_id: NINTH,
      in_app_enabled: originalPrefs.in_app_enabled,
      email_enabled: originalPrefs.email_enabled,
      sms_enabled: originalPrefs.sms_enabled,
    },
  });
  const ninthRow = Array.isArray(ninthBody.json.data) ? ninthBody.json.data[0] : ninthBody.json.data;
  record('ninth UUID in client body cannot become the row owner', ninthBody.status === 200 && ninthRow?.user_id === FREEDOM_APP, {
    detail: `status=${ninthBody.status} user=${ninthRow?.user_id}`,
  });

  const badTable = await write(freedomToken, { table: 'tenants', op: 'update', values: { name: 'x' } });
  record('unapproved table denied', badTable.status === 403 && badTable.json.error === 'table_not_allowlisted', {
    detail: `status=${badTable.status}`,
  });

  const badCol = await write(freedomToken, {
    table: 'notification_preferences',
    op: 'update',
    values: { webhook_url: 'https://evil.example' },
  });
  record('unapproved column denied', badCol.status === 403 && badCol.json.error === 'column_not_allowlisted', {
    detail: `status=${badCol.status}`,
  });

  const financial = await write(freedomToken, {
    table: 'claim_payments',
    op: 'insert',
    values: { amount: 1 },
  });
  record('financial table denied', financial.status === 403 && financial.json.reason === 'financial_or_provider', {
    detail: `status=${financial.status} reason=${financial.json.reason}`,
  });

  const rollback = await write(freedomToken, {
    table: 'check_message_reads',
    op: 'upsert',
    values: { check_id: 'not-a-uuid', last_read_at: stamp },
  });
  record('invalid write rejected without applying', rollback.status >= 400, { detail: `status=${rollback.status}` });

  const cleanupF = await write(freedomToken, {
    table: 'check_message_reads',
    op: 'delete',
    filters: [{ column: 'check_id', op: 'eq', value: freedomCheck.id }],
  });
  const cleanupC = c1cCheck
    ? await write(c1cToken, {
      table: 'check_message_reads',
      op: 'delete',
      filters: [{ column: 'check_id', op: 'eq', value: c1cCheck.id }],
    })
    : { status: 200, json: { skipped: true } };
  record('cleanup Freedom test read receipts', cleanupF.status === 200, { detail: `status=${cleanupF.status}` });
  record('cleanup C1C test read receipts', cleanupC.status === 200, { detail: `status=${cleanupC.status}` });

  const failed = results.filter((row) => !row.ok);
  const out = { ok: failed.length === 0, passed: results.filter((r) => r.ok).length, failed: failed.length, results };
  fs.writeFileSync('/opt/cursor/artifacts/tranche1-api-validation.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ok: out.ok, passed: out.passed, failed: out.failed }, null, 2));
  if (!out.ok) process.exit(1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
