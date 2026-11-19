// Endorsement email status (owner 2026-11-19: "Is there anyway for tenants to see if an email has been delivered
// and opened? For this to show up near the payee signature request", then "Yeah build 1 and 2"): the request's
// Resend email id is kept so Resend's signed delivery reports (delivered, bounced, complained) reach the payee's
// row, and the payee opening their endorsement link is recorded. All of it is bookkeeping: none of it may fail or
// change a request, a page load or a signature.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  RESEND_WEBHOOK_EVENTS,
  handleCheckEndorsement,
  handleEndorsementEmailWebhook,
  isResendWebhookEvent,
  recordEndorsementEmailSent,
  recordEndorsementLinkOpened,
  runAuthenticatedEndorsement,
  runPublicEndorsement,
  verifyResendSignature,
} from '../functions/api/check-endorsement.mjs';

const SECRET_BYTES = Buffer.from('checksops-test-webhook-signing-key');
const SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;
const NOW = Date.parse('2026-11-19T04:00:00Z');
const NOW_S = Math.floor(NOW / 1000);
const TENANT = '11111111-1111-4111-8111-111111111111';
const CHECK_ID = '33333333-3333-4333-8333-333333333333';
const ENDORSE_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '66666666-6666-4666-8666-666666666666';

const sign = (body, { id = 'msg_2pZ', timestamp = NOW_S, key = SECRET_BYTES } = {}) => (
  `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`
);

const webhookEvent = (payload, { headers = {}, base64 = false, signWith } = {}) => {
  const body = JSON.stringify(payload);
  return {
    body: base64 ? Buffer.from(body).toString('base64') : body,
    isBase64Encoded: base64,
    headers: {
      'svix-id': 'msg_2pZ',
      'svix-timestamp': String(NOW_S),
      'svix-signature': sign(body, signWith),
      ...headers,
    },
    requestContext: { http: { method: 'POST', path: '/functions/v1/check-endorsement' } },
  };
};

const recordingDb = ({ fail = false } = {}) => {
  const calls = [];
  return {
    calls,
    client: {
      connect: async () => {},
      end: async () => {},
      query: async (sql, params = []) => {
        calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
        if (fail) throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
        return { rows: [{ updated: 1 }], rowCount: 1 };
      },
    },
  };
};

const webhookDeps = (extra = {}) => ({
  now: () => NOW,
  loadProviderSecrets: async () => ({ RESEND_WEBHOOK_SECRET: SECRET }),
  createClient: () => { throw new Error('no database for this request'); },
  loadDatabaseCredentials: async () => { throw new Error('no database for this request'); },
  ...extra,
});

const delivered = {
  type: 'email.delivered',
  created_at: '2026-11-19T03:59:30.000Z',
  data: { email_id: 're_abc123', created_at: '2026-11-19T03:59:00.000Z', to: ['payee@example.com'] },
};

test('a Svix-signed request is a Resend report; ordinary endorsement calls are not', () => {
  assert.equal(isResendWebhookEvent(webhookEvent(delivered)), true);
  assert.equal(isResendWebhookEvent({ headers: { 'Svix-Signature': 'v1,x' } }), true);
  assert.equal(isResendWebhookEvent({ headers: { authorization: 'Bearer x' }, body: '{"action":"get_endorsement_data"}' }), false);
  assert.equal(isResendWebhookEvent({}), false);
});

test('signature: a valid v1 entry passes; wrong secret, stale or future timestamp and missing headers fail', () => {
  const body = JSON.stringify(delivered);
  const headers = { 'svix-id': 'msg_2pZ', 'svix-timestamp': String(NOW_S), 'svix-signature': sign(body) };
  assert.deepEqual(verifyResendSignature({ secret: SECRET, headers, rawBody: body, nowMs: NOW }), { ok: true, id: 'msg_2pZ' });
  // Header names are case-insensitive, and any one of several space-separated entries may match.
  const mixed = { 'Svix-Id': 'msg_2pZ', 'SVIX-TIMESTAMP': String(NOW_S), 'svix-signature': `v1,AAAA ${sign(body)}` };
  assert.equal(verifyResendSignature({ secret: SECRET, headers: mixed, rawBody: body, nowMs: NOW }).ok, true);
  const other = `whsec_${Buffer.from('another-key').toString('base64')}`;
  assert.equal(verifyResendSignature({ secret: other, headers, rawBody: body, nowMs: NOW }).reason, 'signature_mismatch');
  assert.equal(verifyResendSignature({ secret: SECRET, headers, rawBody: `${body} `, nowMs: NOW }).reason, 'signature_mismatch');
  for (const offset of [-301, 301]) {
    const ts = NOW_S + offset;
    const stale = { ...headers, 'svix-timestamp': String(ts), 'svix-signature': sign(body, { timestamp: ts }) };
    assert.equal(verifyResendSignature({ secret: SECRET, headers: stale, rawBody: body, nowMs: NOW }).reason, 'timestamp_out_of_tolerance', String(offset));
  }
  for (const missing of ['svix-id', 'svix-timestamp', 'svix-signature']) {
    const partial = { ...headers };
    delete partial[missing];
    assert.equal(verifyResendSignature({ secret: SECRET, headers: partial, rawBody: body, nowMs: NOW }).reason, 'signature_headers_missing', missing);
  }
  assert.equal(verifyResendSignature({ secret: '', headers, rawBody: body, nowMs: NOW }).reason, 'secret_missing');
  assert.equal(verifyResendSignature({ secret: SECRET, headers: { ...headers, 'svix-signature': sign(body).replace('v1,', 'v2,') }, rawBody: body, nowMs: NOW }).reason, 'signature_mismatch');
});

test('no signing secret configured: 503 and no database', async () => {
  const saved = process.env.RESEND_WEBHOOK_SECRET;
  delete process.env.RESEND_WEBHOOK_SECRET;
  try {
    const result = await handleCheckEndorsement(webhookEvent(delivered), webhookDeps({ loadProviderSecrets: async () => ({}) }));
    assert.deepEqual(result, { ok: false, statusCode: 503, error: 'webhook_not_configured' });
  } finally {
    if (saved !== undefined) process.env.RESEND_WEBHOOK_SECRET = saved;
  }
});

test('the environment variable is the fallback when the provider secrets lack the key', async () => {
  const saved = process.env.RESEND_WEBHOOK_SECRET;
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  try {
    const db = recordingDb();
    const result = await handleEndorsementEmailWebhook(webhookEvent(delivered), webhookDeps({ loadProviderSecrets: async () => ({}), client: db.client }));
    assert.equal(result.statusCode, 200, JSON.stringify(result));
    assert.equal(db.calls.length, 1);
  } finally {
    if (saved === undefined) delete process.env.RESEND_WEBHOOK_SECRET; else process.env.RESEND_WEBHOOK_SECRET = saved;
  }
});

test('a bad or missing signature is 401 and reaches no database', async () => {
  const forged = webhookEvent(delivered, { signWith: { key: Buffer.from('forged') } });
  const result = await handleCheckEndorsement(forged, webhookDeps());
  assert.deepEqual(result, { ok: false, statusCode: 401, error: 'invalid_signature', reason: 'signature_mismatch' });
  const noSig = webhookEvent(delivered, { headers: { 'svix-signature': '' } });
  assert.equal((await handleCheckEndorsement(noSig, webhookDeps())).statusCode, 401);
  const stale = webhookEvent(delivered, { headers: { 'svix-timestamp': String(NOW_S - 3600) } });
  assert.equal((await handleCheckEndorsement(stale, webhookDeps())).reason, 'timestamp_out_of_tolerance');
});

test('delivered, bounced and complained reach aws_endorsement_email_event with the event time; the reason only for a bounce', async () => {
  assert.deepEqual(RESEND_WEBHOOK_EVENTS, { 'email.delivered': 'delivered', 'email.bounced': 'bounced', 'email.complained': 'complained' });
  const cases = [
    [delivered, ['re_abc123', 'delivered', '2026-11-19T03:59:30.000Z', null]],
    [{ ...delivered, type: 'email.bounced', data: { ...delivered.data, bounce: { message: 'Mailbox does not exist', type: 'Permanent', subType: 'General' } } },
      ['re_abc123', 'bounced', '2026-11-19T03:59:30.000Z', 'Mailbox does not exist']],
    [{ ...delivered, type: 'email.bounced', data: { ...delivered.data, bounce: { type: 'Permanent' } } },
      ['re_abc123', 'bounced', '2026-11-19T03:59:30.000Z', 'Permanent']],
    [{ type: 'email.complained', data: { email_id: 're_abc123', created_at: '2026-11-19T03:59:00.000Z' } },
      ['re_abc123', 'complained', '2026-11-19T03:59:00.000Z', null]],
  ];
  for (const [payload, params] of cases) {
    const db = recordingDb();
    const result = await handleCheckEndorsement(webhookEvent(payload, { base64: true }), webhookDeps({ client: db.client }));
    assert.deepEqual(result, { ok: true, statusCode: 200, received: true, type: payload.type, updated: 1 });
    assert.deepEqual(db.calls, [{ sql: 'SELECT public.aws_endorsement_email_event($1, $2, $3::timestamptz, $4) AS updated', params }]);
  }
});

test('other event types and reports without an email id are acknowledged and ignored', async () => {
  for (const payload of [
    { ...delivered, type: 'email.opened' },
    { ...delivered, type: 'email.clicked' },
    { ...delivered, type: 'email.sent' },
    { ...delivered, type: 'email.delivery_delayed' },
    { type: 'email.delivered', data: {} },
  ]) {
    const result = await handleCheckEndorsement(webhookEvent(payload), webhookDeps());
    assert.deepEqual(result, { ok: true, statusCode: 200, received: true, type: payload.type, ignored: true }, payload.type);
  }
  const notJson = webhookEvent(delivered);
  notJson.body = 'not json';
  notJson.headers['svix-signature'] = sign('not json');
  assert.deepEqual(await handleCheckEndorsement(notJson, webhookDeps()), { ok: false, statusCode: 400, error: 'invalid_json' });
});

test('a database failure answers 500 so Resend retries', async () => {
  const db = recordingDb({ fail: true });
  const result = await handleCheckEndorsement(webhookEvent(delivered), webhookDeps({ client: db.client }));
  assert.equal(result.statusCode, 500);
  assert.equal(result.error, 'webhook_record_failed');
});

test('only a Resend send with an email id is tracked, under a savepoint; a failure is swallowed and rolled back to it', async () => {
  for (const sendResult of [undefined, { mode: 'sink' }, { mode: 'ses', messageId: 'ses-1' }, { mode: 'resend', messageId: '' }]) {
    const db = recordingDb();
    assert.equal(await recordEndorsementEmailSent(db.client, ENDORSE_ID, sendResult), false);
    assert.deepEqual(db.calls, [], JSON.stringify(sendResult));
  }
  const ok = { calls: [] };
  const okClient = { query: async (sql, params) => { ok.calls.push([sql, params]); return { rows: [{ tracked: true }] }; } };
  assert.equal(await recordEndorsementEmailSent(okClient, ENDORSE_ID, { mode: 'resend', messageId: 're_abc123' }), true);
  assert.deepEqual(ok.calls, [
    ['SAVEPOINT endorsement_email_status', undefined],
    ['SELECT public.aws_endorsement_email_sent($1::uuid, $2) AS tracked', [ENDORSE_ID, 're_abc123']],
    ['RELEASE SAVEPOINT endorsement_email_status', undefined],
  ]);
  const bad = { calls: [] };
  const badClient = {
    query: async (sql) => {
      bad.calls.push(sql);
      if (sql.includes('aws_endorsement_email_sent')) throw Object.assign(new Error('function does not exist'), { code: '42883' });
      return { rows: [] };
    },
  };
  assert.equal(await recordEndorsementEmailSent(badClient, ENDORSE_ID, { mode: 'resend', messageId: 're_abc123' }), false);
  assert.deepEqual(bad.calls.slice(-2), ['ROLLBACK TO SAVEPOINT endorsement_email_status', 'RELEASE SAVEPOINT endorsement_email_status']);
});

const sendDb = ({ trackingFails = false } = {}) => {
  const calls = [];
  return {
    calls,
    client: {
      connect: async () => {},
      end: async () => {},
      query: async (rawSql, params = []) => {
        const sql = String(rawSql).replace(/\s+/g, ' ').trim();
        calls.push({ sql, params });
        if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION|SAVEPOINT|RELEASE)/i.test(sql)) return { rows: [], rowCount: 0 };
        if (sql.includes('aws_endorsement_email_sent')) {
          if (trackingFails) throw Object.assign(new Error('function public.aws_endorsement_email_sent does not exist'), { code: '42883' });
          return { rows: [{ tracked: true }] };
        }
        if (sql.includes('FROM public.check_endorsements WHERE id')) {
          return { rows: [{ id: ENDORSE_ID, check_id: CHECK_ID, tenant_id: TENANT, payee_type: 'insured', payee_name: 'Natalie Hernandez', contact_email: 'natalie@example.com', status: 'pending', token: 'tok-1' }] };
        }
        if (sql.includes('FROM public.check_intake_items')) return { rows: [{ id: CHECK_ID, tenant_id: TENANT, check_number: '2000348108', carrier_name: 'Pennsylvania National', amount: 14636.33 }] };
        if (sql.includes('aws_can_write_tenant')) return { rows: [{ ok: true }] };
        if (sql.startsWith('SELECT contact_email FROM public.check_payees')) return { rows: [] };
        if (sql.includes("SET status = 'sent'")) return { rows: [{ id: ENDORSE_ID, status: 'sent', request_sent_at: new Date().toISOString() }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
    },
  };
};

const sendRequest = (client, sendResult) => runAuthenticatedEndorsement({
  client,
  mapping: { application_user_id: USER_ID },
  body: { action: 'send_endorsement_request', endorsementId: ENDORSE_ID },
  spoof: { ignored: true },
  event: { headers: {}, body: '{}', requestContext: { http: { method: 'POST', path: '/functions/v1/check-endorsement' } } },
  send: async () => sendResult,
});

test('a Resend request send keeps its email id; a sink send is not tracked; a tracking failure never fails the send', async () => {
  const tracked = sendDb();
  const ok = await sendRequest(tracked.client, { mode: 'resend', provider: 'resend', messageId: 're_abc123', deliveredCount: 1, results: [] });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.emailStatusTracking, true);
  assert.deepEqual(tracked.calls.find((c) => c.sql.includes('aws_endorsement_email_sent')).params, [ENDORSE_ID, 're_abc123']);
  const audit = tracked.calls.find((c) => /INSERT INTO public\.endorsement_audit_log/.test(c.sql));
  assert.match(JSON.stringify(audit.params), /email_status_tracking\\":true/);

  const sunk = sendDb();
  const sinkResult = await sendRequest(sunk.client, { mode: 'sink' });
  assert.equal(sinkResult.ok, true);
  assert.equal(sinkResult.emailStatusTracking, false);
  assert.equal(sunk.calls.some((c) => c.sql.includes('aws_endorsement_email_sent')), false);

  const failing = sendDb({ trackingFails: true });
  const failed = await sendRequest(failing.client, { mode: 'resend', messageId: 're_abc123', deliveredCount: 1, results: [] });
  assert.equal(failed.ok, true, JSON.stringify(failed));
  assert.equal(failed.statusCode, 200);
  assert.equal(failed.emailStatusTracking, false);
  const rolledBack = failing.calls.findIndex((c) => c.sql === 'ROLLBACK TO SAVEPOINT endorsement_email_status');
  assert.ok(rolledBack > failing.calls.findIndex((c) => c.sql.includes('aws_endorsement_email_sent')));
  // Everything after the failed call still ran (the audit event), so the transaction was not left aborted.
  assert.ok(failing.calls.findIndex((c) => /INSERT INTO public\.endorsement_audit_log/.test(c.sql)) > rolledBack);
});

const pageDb = ({ openFails = false, tokenExpiresAt = '2026-12-01T00:00:00Z' } = {}) => {
  const calls = [];
  return {
    calls,
    client: {
      connect: async () => {},
      end: async () => {},
      query: async (rawSql, params = []) => {
        const sql = String(rawSql).replace(/\s+/g, ' ').trim();
        calls.push({ sql, params });
        if (sql.includes('aws_public_endorsement_by_token')) {
          return { rows: [{ doc: { id: ENDORSE_ID, payee_name: 'Natalie Hernandez', status: 'sent', check_number: '2000348108', carrier_name: 'Pennsylvania National', amount: 14636.33, token: params[0], token_expires_at: tokenExpiresAt } }] };
        }
        if (sql.includes('aws_endorsement_link_opened')) {
          if (openFails) throw Object.assign(new Error('function public.aws_endorsement_link_opened does not exist'), { code: '42883' });
          return { rows: [{ opens: 1 }] };
        }
        return { rows: [], rowCount: 0 };
      },
    },
  };
};

const pageEvent = (action = 'get_endorsement_data') => ({
  headers: {},
  body: JSON.stringify({ action, token: 'tok-1' }),
  requestContext: { http: { method: 'POST', path: '/public/endorsement' } },
});

test('the payee opening a valid link is recorded; the page answer is the same whether or not that works', async () => {
  const now = () => Date.parse('2026-11-19T04:00:00Z');
  const recorded = pageDb();
  const okResult = await runPublicEndorsement(pageEvent(), { client: recorded.client, now });
  assert.equal(okResult.ok, true, JSON.stringify(okResult));
  assert.deepEqual(recorded.calls.find((c) => c.sql.includes('aws_endorsement_link_opened')).params, [ENDORSE_ID]);

  const failing = pageDb({ openFails: true });
  const failResult = await runPublicEndorsement(pageEvent(), { client: failing.client, now });
  assert.deepEqual(failResult, okResult);

  // An expired link answers link_expired and records nothing.
  const expired = pageDb({ tokenExpiresAt: '2026-11-01T00:00:00Z' });
  const expiredResult = await runPublicEndorsement(pageEvent(), { client: expired.client, now });
  assert.equal(expiredResult.ok, false);
  assert.equal(expired.calls.some((c) => c.sql.includes('aws_endorsement_link_opened')), false);
});

test('recordEndorsementLinkOpened is best effort and needs an id', async () => {
  const db = recordingDb({ fail: true });
  assert.equal(await recordEndorsementLinkOpened(db.client, ENDORSE_ID), false);
  assert.equal(await recordEndorsementLinkOpened(db.client, null), false);
});

test('only the page load records an open: signing and declining do not', () => {
  const source = fs.readFileSync(new URL('../functions/api/check-endorsement.mjs', import.meta.url), 'utf8');
  const calls = source.match(/await recordLinkOpenedFromPage\(/g) || [];
  assert.equal(calls.length, 1, 'one call site');
  assert.match(source, /runGetEndorsementData\(client, String\(body\.token \|\| ''\)\.trim\(\), spoof, deps\);\n {6}\/\/ A valid, unexpired link was opened by the payee: record it \(best effort; the response is unchanged\)\.\n {6}if \(result\.ok && result\.id\) await recordLinkOpenedFromPage\(result\.id, deps\);/);
  // The webhook branch comes before the public and signed-in actions.
  const handler = source.slice(source.indexOf('export const handleCheckEndorsement'));
  assert.ok(handler.indexOf('isResendWebhookEvent(event)') < handler.indexOf('PUBLIC_ENDORSEMENT_ACTIONS.has'));
});

test('overlay plan (2026-11-19, planning only): check-endorsement.mjs moves on from the copy notice applied bytes', async () => {
  const { createHash } = await import('node:crypto');
  const path = await import('node:path');
  const { resolvePlannedMember, localImports } = await import('../../scripts/deployment-guard/github-production-lambda-overlay.mjs');
  const root = path.resolve(new URL('../..', import.meta.url).pathname);
  const read = (rel) => fs.readFileSync(path.join(root, rel));
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const name = 'check-endorsement.mjs';
  const rel = 'aws/tests/fixtures/production-endorsement-email-status-api-manifest-2026-11-19.json';
  const appliedRel = 'aws/tests/fixtures/production-endorsement-copy-notice-api-applied-manifest-2026-11-18.json';
  const plan = JSON.parse(read('ops/deployment-guard/production-api-overlay-plan.json'));
  const manifest = JSON.parse(read(rel));
  const onMain = sha(read(`aws/functions/api/${name}`));
  const applied = JSON.parse(read(appliedRel)).members[name];
  assert.equal(manifest.deploy_authorized, false);
  assert.match(manifest.authorization, /^Pending owner review \(2026-11-19\)\. Planning only/);
  assert.match(manifest.notes, /Is there anyway for tenants to see if an email has been delivered and opened\?/);
  assert.match(manifest.notes, /Yeah build 1 and 2/);
  assert.deepEqual(manifest.members, { [name]: { live_sha256: applied.accepted_sha256, accepted_sha256: onMain, operation: 'replace', previous_manifest: appliedRel } });
  assert.notEqual(onMain, applied.accepted_sha256);
  assert.deepEqual(plan.members[name], { operation: 'replace', accepted_sha256: onMain, expected_live_sha256: applied.accepted_sha256, sql_before: null, manifest: rel });
  assert.equal(resolvePlannedMember(name, { root, plan }).ok, true);
  assert.ok(plan.notes.includes(`Manifest ${rel}. Nothing deployed.`));
  assert.match(plan.notes, /check-endorsement\.mjs REPLACE 3bb1ae2b -> c3a6e218/);
  // The one new import is provider-secrets.mjs, which the live package carries: the second production rebuild
  // accepted it, and main's bytes are those bytes.
  assert.ok(localImports(read(`aws/functions/api/${name}`).toString('utf8'), name).includes('provider-secrets.mjs'));
  const rebuild = JSON.parse(read('ops/deployment-guard/lambda-rebuild-plan.json')).environments.production.history;
  assert.equal(rebuild[1].members['provider-secrets.mjs'].accepted_sha256, sha(read('aws/functions/api/provider-secrets.mjs')));
  // The routing files stay as they are: the webhook is reached through the check-endorsement function.
  const appServices = read('aws/functions/api/app-services.mjs').toString('utf8');
  assert.match(appServices, /\n {2}'check-endorsement',\n/);
  assert.match(appServices, /case 'check-endorsement':/);
});
