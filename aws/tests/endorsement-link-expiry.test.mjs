// Finding 22 (security audit 2026-10-29): public endorsement links expire 30 days after they
// were (re)sent; a resend restarts the 30 days for the same token (owner decision 2026-10-31).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ENDORSEMENT_LINK_EXPIRED_CODE,
  ENDORSEMENT_LINK_TTL_DAYS,
  ENDORSEMENT_LINK_TTL_MS,
  endorsementLinkExpiresAt,
  endorsementLinkExpiryMs,
  isEndorsementLinkExpired,
  runAuthenticatedEndorsement,
  runPublicEndorsement,
} from '../functions/api/check-endorsement.mjs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CHECK_ID = '33333333-3333-4333-8333-333333333333';
const ENDORSE_ID = '44444444-4444-4444-8444-444444444444';
const PAYEE_ID = '77777777-7777-4777-8777-777777777777';
const USER_ID = '66666666-6666-4666-8666-666666666666';
const DAY = 24 * 60 * 60 * 1000;
const SENT = Date.parse('2026-10-01T12:00:00.000Z');

const eventOf = (body = {}) => ({
  headers: {},
  body: JSON.stringify(body),
  requestContext: { http: { method: 'POST', path: '/functions/v1/check-endorsement' } },
});

// One endorsement row and its payee, read and written the way check-endorsement.mjs does.
const fakeDb = (row, payee = null) => {
  const captured = [];
  const client = {
    connect: async () => {},
    end: async () => {},
    query: async (rawSql, params = []) => {
      const sql = String(rawSql).replace(/\s+/g, ' ').trim();
      captured.push({ sql, params });
      if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/i.test(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes('aws_public_endorsement_by_token')) {
        if (row.token !== params[0]) return { rows: [{ doc: null }] };
        // The SQL 40 lookup returns token_expires_at but not request_sent_at.
        const { request_sent_at: _omitted, ...doc } = row;
        return { rows: [{ doc: { ...doc, carrier_name: 'Carrier', check_number: 'X-1', amount: 100 } }] };
      }
      if (sql.startsWith('SELECT request_sent_at FROM public.check_endorsements WHERE id')) {
        return { rows: row.id === params[0] ? [{ request_sent_at: row.request_sent_at }] : [] };
      }
      if (sql.includes('FROM public.check_endorsements WHERE id')) return { rows: row.id === params[0] ? [{ ...row }] : [] };
      if (sql.includes('FROM public.check_intake_items')) {
        return { rows: [{ id: CHECK_ID, tenant_id: TENANT, check_number: 'X-1', carrier_name: 'Carrier', amount: 100 }] };
      }
      if (sql.includes('aws_can_write_tenant')) return { rows: [{ ok: true }] };
      if (sql.startsWith('UPDATE public.check_endorsements SET token = $2, token_expires_at = $3::timestamptz')) {
        row.token = params[1];
        row.token_expires_at = params[2];
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE public.check_payees SET endorsement_token = $2, endorsement_token_expires_at = $5::timestamptz')) {
        if (payee) Object.assign(payee, { endorsement_token: params[1], endorsement_token_expires_at: params[4] });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SET status = 'sent'")) {
        row.status = 'sent';
        row.request_sent_at = new Date(client.now).toISOString();
        return { rows: [{ id: row.id, status: 'sent', request_sent_at: row.request_sent_at }], rowCount: 1 };
      }
      if (sql.includes("SET status = 'rejected'")) {
        row.status = 'rejected';
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { client, captured };
};

const getData = (client, token, nowMs) => runPublicEndorsement(
  eventOf({ action: 'get_endorsement_data', token }),
  { client, now: () => nowMs },
);

const sendRequest = (client, nowMs) => {
  client.now = nowMs;
  return runAuthenticatedEndorsement({
    client,
    mapping: { application_user_id: USER_ID },
    body: { action: 'send_endorsement_request', endorsementId: ENDORSE_ID },
    spoof: { ignored: true },
    event: eventOf({}),
    send: async () => undefined,
    now: () => nowMs,
  });
};

const baseRow = (extra = {}) => ({
  id: ENDORSE_ID,
  check_id: CHECK_ID,
  tenant_id: TENANT,
  payee_id: null,
  payee_type: 'insured',
  payee_name: 'Jane Doe',
  contact_email: 'jane@example.com',
  status: 'sent',
  token: 'tok-1',
  token_expires_at: null,
  request_sent_at: null,
  ...extra,
});

test('one shared constant: 30 days, stamped from the send time', () => {
  assert.equal(ENDORSEMENT_LINK_TTL_DAYS, 30);
  assert.equal(ENDORSEMENT_LINK_TTL_MS, 30 * DAY);
  assert.equal(endorsementLinkExpiresAt(SENT), new Date(SENT + 30 * DAY).toISOString());
  const stamped = { token_expires_at: endorsementLinkExpiresAt(SENT) };
  assert.equal(isEndorsementLinkExpired(stamped, SENT + 29 * DAY), false);
  assert.equal(isEndorsementLinkExpired(stamped, SENT + 30 * DAY - 1), false);
  assert.equal(isEndorsementLinkExpired(stamped, SENT + 30 * DAY), true);
  assert.equal(isEndorsementLinkExpired(stamped, SENT + 31 * DAY), true);
  // Sent before expiry was stamped: 30 days from request_sent_at.
  assert.equal(endorsementLinkExpiryMs({ token_expires_at: null, request_sent_at: new Date(SENT).toISOString() }), SENT + 30 * DAY);
  // No issue time at all (never sent): no expiry is invented.
  assert.equal(endorsementLinkExpiryMs({ token_expires_at: null, request_sent_at: null }), null);
  // An unreadable timestamp fails closed.
  assert.equal(isEndorsementLinkExpired({ token_expires_at: 'not-a-date' }, SENT), true);
});

test('a link works at 29 days and is refused at 31 days on every public action', async () => {
  const row = baseRow({ token_expires_at: endorsementLinkExpiresAt(SENT), request_sent_at: new Date(SENT).toISOString() });
  const { client } = fakeDb(row);

  const day29 = await getData(client, 'tok-1', SENT + 29 * DAY);
  assert.equal(day29.statusCode, 200);
  assert.equal(day29.ok, true);
  assert.equal(day29.payee_name, 'Jane Doe');

  const day31 = await getData(client, 'tok-1', SENT + 31 * DAY);
  assert.equal(day31.statusCode, 410);
  assert.equal(day31.ok, false);
  assert.equal(day31.code, ENDORSEMENT_LINK_EXPIRED_CODE);
  assert.match(day31.error, /expired/i);
  assert.equal(day31.payee_name, undefined);
  assert.equal(day31.amount, undefined);

  const before = row.status;
  for (const body of [
    { action: 'submit_endorsement', token: 'tok-1', eSignConsentAccepted: true, signatureData: 'data:image/png;base64,aaa' },
    { action: 'reject_endorsement', token: 'tok-1', reason: 'no' },
  ]) {
    const { client: writeClient, captured } = fakeDb(row);
    const refused = await runPublicEndorsement(eventOf(body), { client: writeClient, now: () => SENT + 31 * DAY });
    assert.equal(refused.statusCode, 410, body.action);
    assert.equal(refused.code, ENDORSEMENT_LINK_EXPIRED_CODE, body.action);
    assert.equal(captured.some(({ sql }) => /^UPDATE/i.test(sql)), false, `${body.action} wrote nothing`);
    assert.equal(captured.some(({ sql }) => sql === 'ROLLBACK'), true, `${body.action} rolled back`);
  }
  assert.equal(row.status, before);
});

test('a link sent before expiry was stamped runs 30 days from request_sent_at', async () => {
  const row = baseRow({ token_expires_at: null, request_sent_at: new Date(SENT).toISOString() });
  const { client } = fakeDb(row);
  assert.equal((await getData(client, 'tok-1', SENT + 29 * DAY)).statusCode, 200);
  const late = await getData(client, 'tok-1', SENT + 31 * DAY);
  assert.equal(late.statusCode, 410);
  assert.equal(late.code, ENDORSEMENT_LINK_EXPIRED_CODE);
});

test('send stamps 30 days on the endorsement and the payee; resend refreshes the same link', async () => {
  const payee = { id: PAYEE_ID, endorsement_token: null, endorsement_token_expires_at: null };
  const row = baseRow({ payee_id: PAYEE_ID, status: 'pending', token: 'tok-1' });
  const { client, captured } = fakeDb(row, payee);

  const first = await sendRequest(client, SENT);
  assert.equal(first.statusCode, 200);
  assert.equal(first.emailSent, true);
  assert.equal(first.endorsementUrl.endsWith('/endorse?token=tok-1'), true);
  assert.equal(first.linkExpiresAt, new Date(SENT + 30 * DAY).toISOString());
  assert.equal(row.token_expires_at, first.linkExpiresAt);
  assert.equal(payee.endorsement_token, 'tok-1');
  assert.equal(payee.endorsement_token_expires_at, first.linkExpiresAt);
  assert.equal(captured.some(({ sql }) => /token_expires_at = NULL/.test(sql)), false);

  assert.equal((await getData(client, 'tok-1', SENT + 29 * DAY)).statusCode, 200);
  assert.equal((await getData(client, 'tok-1', SENT + 31 * DAY)).statusCode, 410);

  // Resend on day 31: same token, 30 new days from the resend.
  const resentAt = SENT + 31 * DAY;
  const resent = await sendRequest(client, resentAt);
  assert.equal(resent.statusCode, 200);
  assert.equal(resent.endorsementUrl, first.endorsementUrl);
  assert.equal(resent.linkExpiresAt, new Date(resentAt + 30 * DAY).toISOString());
  assert.equal(row.token, 'tok-1');
  assert.equal(payee.endorsement_token_expires_at, resent.linkExpiresAt);

  const works = await getData(client, 'tok-1', resentAt + 1);
  assert.equal(works.statusCode, 200);
  assert.equal(works.ok, true);
  assert.equal((await getData(client, 'tok-1', resentAt + 29 * DAY)).statusCode, 200);
  assert.equal((await getData(client, 'tok-1', resentAt + 31 * DAY)).statusCode, 410);
});

test('overlay plan: the link expiry manifest stays as planned; production got its bytes with the fourth full-package rebuild and the row moved on', async () => {
  const { createHash } = await import('node:crypto');
  const fs = await import('node:fs');
  const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url));
  const plan = JSON.parse(read('ops/deployment-guard/production-api-overlay-plan.json'));
  const rel = 'aws/tests/fixtures/production-endorsement-link-expiry-manifest-2026-10-31.json';
  const manifest = JSON.parse(read(rel));
  const release = JSON.parse(read('aws/tests/fixtures/production-release-lock-pin-manifest-2026-10-17.json'));
  const name = 'check-endorsement.mjs';
  // The link expiry bytes are no longer main's (the contractor payee plan of 2026-11-18 changed the file). They are
  // the accepted bytes the fourth production rebuild recorded (apply run 41469896446), which put them live.
  const rebuild = JSON.parse(read('ops/deployment-guard/lambda-rebuild-plan.json')).environments.production.history[3];
  assert.equal(rebuild.applied.run_id, '41469896446');
  const accepted = rebuild.members[name].accepted_sha256;
  let onMain = createHash('sha256').update(read('aws/functions/api/check-endorsement.mjs')).digest('hex');
  assert.equal(manifest.deploy_authorized, false);
  assert.match(manifest.authorization, /^Pending owner review/);
  assert.match(manifest.notes, /finding 22/);
  assert.deepEqual(manifest.members, {
    [name]: {
      live_sha256: release.members[name].live_sha256,
      accepted_sha256: accepted,
      operation: 'replace',
      supersedes_unapplied_manifest: 'aws/tests/fixtures/production-release-lock-pin-manifest-2026-10-17.json',
    },
  });
  assert.notEqual(accepted, release.members[name].accepted_sha256);
  // The contractor payee plan moved the row on from those bytes (its entry names this manifest as the one it starts
  // from); production run 44320098887 applied it (2026-11-18), so the row now expects main's bytes and names the
  // applied record, which chains to that plan.
  // (Since the endorsement copy notice plan of 2026-11-18 the row moves on again, from the contractor payee applied
  // bytes: it is read here as it stood before that plan.)
  let row = plan.members[name];
  // (The endorsement email status plan of 2026-11-19, planning only, moved the row on from the copy notice applied
  // bytes: the row is read as it stood before that plan, and those applied bytes stand for main's.)
  if (row.manifest === 'aws/tests/fixtures/production-endorsement-email-status-api-manifest-2026-11-19.json') {
    const emailStatus = JSON.parse(read(row.manifest)).members[name];
    assert.deepEqual([emailStatus.accepted_sha256, row.accepted_sha256, row.expected_live_sha256], [onMain, onMain, emailStatus.live_sha256]);
    onMain = emailStatus.live_sha256;
    row = { ...row, accepted_sha256: onMain, expected_live_sha256: onMain, manifest: emailStatus.previous_manifest };
  }
  let contractorBytes = onMain;
  // (Applied 2026-11-18, production run 44386297099: the applied record is read back to the plan it applied.)
  if (row.manifest === 'aws/tests/fixtures/production-endorsement-copy-notice-api-applied-manifest-2026-11-18.json') {
    const appliedCopy = JSON.parse(read(row.manifest)).members[name];
    assert.deepEqual([appliedCopy.live_sha256, row.expected_live_sha256], [onMain, onMain]);
    row = { ...row, expected_live_sha256: JSON.parse(read(appliedCopy.previous_manifest)).members[name].live_sha256, manifest: appliedCopy.previous_manifest };
  }
  if (row.manifest === 'aws/tests/fixtures/production-endorsement-copy-notice-api-manifest-2026-11-18.json') {
    const copyNotice = JSON.parse(read(row.manifest)).members[name];
    assert.deepEqual([copyNotice.accepted_sha256, row.accepted_sha256, row.expected_live_sha256], [onMain, onMain, copyNotice.live_sha256]);
    contractorBytes = copyNotice.live_sha256;
    row = { ...row, accepted_sha256: contractorBytes, expected_live_sha256: contractorBytes, manifest: copyNotice.previous_manifest };
  }
  assert.deepEqual(row, {
    operation: 'replace',
    accepted_sha256: contractorBytes,
    expected_live_sha256: contractorBytes,
    sql_before: null,
    manifest: row.manifest,
  });
  assert.notEqual(row.manifest, rel);
  const applied = JSON.parse(read(row.manifest)).members[name];
  assert.deepEqual([applied.live_sha256, applied.accepted_sha256], [contractorBytes, contractorBytes]);
  const next = JSON.parse(read(applied.previous_manifest));
  assert.deepEqual(next.members[name], { live_sha256: accepted, accepted_sha256: contractorBytes, operation: 'replace', previous_manifest: rel });
});
