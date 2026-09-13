/**
 * Check Command Center / public Endorse workflow (Class A).
 * Ports Lovable check-endorsement actions onto Cognito + SES/sink.
 * Does NOT advance deposit stage or trigger payment-direction disbursement.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { parseBody, ignoredSpoof, withIdentityWrite } from './data.mjs';
import { loadDatabaseCredentials } from './secrets.mjs';
import { buildClientConfig, buildWriteClientConfig, sanitizePublicError } from './db-health.mjs';
import { deliverAuditedEmail, peekAuditedEmail, replayIdempotentSend, stableEmailIdempotencyKey, validatedMailReplyTo, withDurableAuditClient } from './email.mjs';
import { defaultFromAddress } from './email-policy.mjs';
import { renderTransactionalTemplate } from './email-templates.mjs';
import { resolveEmailBranding } from './email-branding.mjs';

const { Client } = pg;

export const PUBLIC_ENDORSEMENT_ACTIONS = new Set([
  'get_endorsement_data',
  'submit_endorsement',
  'reject_endorsement',
]);

export const AUTH_ENDORSEMENT_ACTIONS = new Set([
  'send_endorsement_request',
  'sign_in_person',
  'mark_internal_signed',
  'waive_endorsement',
]);

export const DEFAULT_CONSENT_TEXT = 'I agree to use electronic records and electronic signatures for this endorsement. I confirm my identity as the named payee, intend my electronic signature to be legally binding, and authorize the electronic endorsement of this insurance check payment. I understand I may decline to sign electronically and request another process.';

export const RATE_LIMIT_MS = 5 * 60 * 1000;

export const denyDepositAdvance = () => ({
  depositAdvanceDenied: true,
  advance_check_on_endorsement_complete: 'denied',
  newStatus: null,
  readyForDeposit: false,
  approvedForDeposit: false,
  paymentDirectionTriggered: false,
});

export const evaluateEndorsementCompletion = (rows = []) => {
  if (!rows.length) return { allSigned: false, anyRejected: false, ...denyDepositAdvance() };
  const anyRejected = rows.some((row) => row.status === 'rejected');
  const allDone = rows.every((row) => (
    row.status === 'signed'
    || row.status === 'waived'
    || (row.payee_type === 'mortgage_company' && row.status === 'manual_required')
  ));
  return {
    allSigned: allDone && !anyRejected,
    anyRejected,
    ...denyDepositAdvance(),
  };
};

export const isContractorPayee = (payeeType) => String(payeeType || '').toLowerCase() === 'contractor';

export const endorsementRateLimited = (requestSentAt, now = Date.now()) => {
  if (!requestSentAt) return false;
  const last = new Date(requestSentAt).getTime();
  if (Number.isNaN(last)) return false;
  return (now - last) < RATE_LIMIT_MS;
};

export const clientIpFromEvent = (event) => {
  const headers = event?.headers || {};
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), v]));
  const forwarded = String(lower['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || lower['cf-connecting-ip'] || null;
};

export const userAgentFromEvent = (event) => {
  const headers = event?.headers || {};
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), v]));
  return lower['user-agent'] || null;
};

const appUrl = () => String(
  process.env.APP_PUBLIC_URL || process.env.SIGN_BASE_URL || 'https://staging.checksops.com',
).replace(/\/$/, '');

const execPublicWriteRpc = async (requestClient, sql, params, deps = {}) => {
  const run = async (client, commit) => {
    if (commit) {
      await client.query("SELECT set_config('default_transaction_read_only', 'off', false)");
      await client.query('BEGIN');
      await client.query('SET TRANSACTION READ WRITE');
    }
    try {
      const result = await client.query(sql, params);
      if (commit) await client.query('COMMIT');
      return result;
    } catch (error) {
      if (commit) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      }
      throw error;
    }
  };
  if (deps.client) return run(requestClient, false);
  const opened = await publicDb(true, {});
  try {
    return await run(opened.client, true);
  } finally {
    if (opened.owned) {
      try { await opened.client.end(); } catch { /* ignore */ }
    }
  }
};

const publicDb = async (write, deps = {}) => {
  if (deps.client) return { client: deps.client, owned: false };
  const loadCredentials = deps.loadDatabaseCredentials || loadDatabaseCredentials;
  const createClient = deps.createClient || ((config) => new Client(config));
  const credentials = await loadCredentials();
  const config = write
    ? buildWriteClientConfig(credentials, { queryTimeoutMillis: 12000 })
    : buildClientConfig(credentials, { queryTimeoutMillis: 8000 });
  const client = createClient(config);
  await client.connect();
  if (write) {
    await client.query("SELECT set_config('default_transaction_read_only', 'off', false)");
  }
  return { client, owned: true };
};

let safeQuerySp = 0;

const safeQuery = async (client, sql, params = []) => {
  const sp = `sq_${(safeQuerySp += 1)}`;
  try {
    await client.query(`SAVEPOINT ${sp}`);
    const result = await client.query(sql, params);
    try { await client.query(`RELEASE SAVEPOINT ${sp}`); } catch { /* ignore */ }
    return result;
  } catch {
    try { await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); } catch { /* ignore */ }
    return { rows: [], rowCount: 0 };
  }
};

const readRpcDoc = (result) => {
  const raw = result?.rows?.[0]?.doc;
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
};

const canWriteTenant = async (client, tenantId) => {
  if (!tenantId) return false;
  const ok = (await client.query(
    'SELECT public.aws_can_write_tenant($1::uuid) AS ok',
    [tenantId],
  )).rows[0]?.ok;
  return ok === true;
};

const markEndorsementRequestSent = async (requestClient, {
  endorsementId, email, token, durableAudit = false, openAuditClient = null,
}) => withDurableAuditClient(requestClient, async (auditClient, { independent } = {}) => {
  const exec = async () => {
    const result = await auditClient.query(
      'SELECT public.aws_mark_endorsement_request_sent($1::uuid, $2, $3) AS doc',
      [endorsementId, email || null, token || null],
    );
    const doc = readRpcDoc(result);
    if (!doc || doc.ok === false) {
      return {
        ok: false,
        error: doc?.error || 'endorsement_update_failed',
        statusCode: doc?.statusCode || 503,
      };
    }
    return { ok: true, doc };
  };
  if (!independent) return exec();
  await auditClient.query('BEGIN');
  await auditClient.query('SET TRANSACTION READ WRITE');
  try {
    const result = await exec();
    if (result.ok === false) {
      await auditClient.query('ROLLBACK');
      return result;
    }
    await auditClient.query('COMMIT');
    return result;
  } catch (error) {
    try { await auditClient.query('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }
}, { durableAudit, openAuditClient });

const loadCheckForEndorsement = async (client, endorsement) => {
  if (!endorsement?.check_id) return {};
  return (await safeQuery(
    client,
    `SELECT id, tenant_id, claim_id, carrier_name, check_number, amount, status,
            deposit_recommendation, check_stage
     FROM public.check_intake_items WHERE id = $1::uuid LIMIT 1`,
    [endorsement.check_id],
  )).rows[0] || {};
};

const loadEndorsementById = async (client, id) => (
  (await client.query(
    `SELECT * FROM public.check_endorsements WHERE id = $1::uuid LIMIT 1`,
    [id],
  )).rows[0] || null
);

const loadEndorsementByPayee = async (client, payeeId) => (
  (await safeQuery(
    client,
    `SELECT * FROM public.check_endorsements
     WHERE payee_id = $1::uuid
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 1`,
    [payeeId],
  )).rows[0] || null
);

const createEndorsementFromPayee = async (client, payee, extras = {}) => {
  const created = (await client.query(
    `INSERT INTO public.check_endorsements (
       check_id, tenant_id, payee_id, payee_name, payee_type,
       status, signature_method, contact_email, contact_phone
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9
     )
     RETURNING *`,
    [
      payee.check_id,
      payee.tenant_id || extras.tenant_id || null,
      payee.id,
      payee.payee_name,
      payee.payee_type || 'other',
      extras.status || 'pending',
      extras.signature_method || 'portal',
      payee.contact_email || extras.email || null,
      payee.contact_phone || extras.phone || null,
    ],
  )).rows[0];
  return created;
};

const resolveEndorsementId = async (client, body) => {
  let endorsementId = body.endorsementId || body.endorsement_id;
  const payeeId = body.payeeId || body.payee_id;
  if (endorsementId) return endorsementId;
  if (!payeeId) return null;
  const existing = await loadEndorsementByPayee(client, payeeId);
  if (existing) return existing.id;
  const payee = (await safeQuery(
    client,
    `SELECT * FROM public.check_payees WHERE id = $1::uuid LIMIT 1`,
    [payeeId],
  )).rows[0];
  if (!payee) return null;
  const created = await createEndorsementFromPayee(client, payee, body);
  return created?.id || null;
};

const rotateToken = () => randomUUID();

const COMPLETE_ENDORSEMENT = new Set(['signed', 'waived']);

/**
 * Durable payee endorsement write. Does not swallow errors.
 * Token columns are only mutated when rotateToken is true so a failed
 * companion endorsement write can roll back without consuming the public token.
 */
export const persistPayeeEndorsementState = async (client, endorsement, {
  status,
  token = null,
  image = null,
  signedAt = null,
  rotateToken: shouldRotate = false,
} = {}) => {
  const nextStatus = String(status || '').trim();
  if (!nextStatus) {
    return { ok: false, error: 'payee_persist_failed', message: 'Payee endorsement status is required' };
  }
  let result;
  if (endorsement.payee_id) {
    result = shouldRotate
      ? await client.query(
        `UPDATE public.check_payees
         SET endorsement_status = $2,
             endorsed_at = COALESCE($3::timestamptz, endorsed_at, now()),
             endorsement_image_path = COALESCE($4, endorsement_image_path),
             endorsement_token = COALESCE($5, endorsement_token),
             endorsement_token_expires_at = NULL,
             updated_at = now()
         WHERE id = $1::uuid
         RETURNING id, endorsement_status, endorsement_token`,
        [endorsement.payee_id, nextStatus, signedAt, image, token],
      )
      : await client.query(
        `UPDATE public.check_payees
         SET endorsement_status = $2,
             endorsed_at = COALESCE($3::timestamptz, endorsed_at, now()),
             endorsement_image_path = COALESCE($4, endorsement_image_path),
             updated_at = now()
         WHERE id = $1::uuid
         RETURNING id, endorsement_status, endorsement_token`,
        [endorsement.payee_id, nextStatus, signedAt, image],
      );
  } else if (endorsement.check_id && endorsement.payee_name) {
    result = shouldRotate
      ? await client.query(
        `UPDATE public.check_payees
         SET endorsement_status = $3,
             endorsed_at = COALESCE($4::timestamptz, endorsed_at, now()),
             endorsement_image_path = COALESCE($5, endorsement_image_path),
             endorsement_token = COALESCE($6, endorsement_token),
             endorsement_token_expires_at = NULL,
             updated_at = now()
         WHERE check_id = $1::uuid AND payee_name = $2
         RETURNING id, endorsement_status, endorsement_token`,
        [endorsement.check_id, endorsement.payee_name, nextStatus, signedAt, image, token],
      )
      : await client.query(
        `UPDATE public.check_payees
         SET endorsement_status = $3,
             endorsed_at = COALESCE($4::timestamptz, endorsed_at, now()),
             endorsement_image_path = COALESCE($5, endorsement_image_path),
             updated_at = now()
         WHERE check_id = $1::uuid AND payee_name = $2
         RETURNING id, endorsement_status, endorsement_token`,
        [endorsement.check_id, endorsement.payee_name, nextStatus, signedAt, image],
      );
  } else {
    return { ok: false, error: 'payee_persist_failed', message: 'Payee endorsement target is missing' };
  }
  if (!result.rowCount) {
    if (!endorsement.payee_id) {
      return { ok: true, skipped: true, rowCount: 0 };
    }
    return {
      ok: false,
      error: 'payee_persist_failed',
      message: 'Payee endorsement state was not updated',
    };
  }
  return { ok: true, data: result.rows[0], rowCount: result.rowCount };
};

const updatePayeeSigned = async (client, endorsement, fields) => persistPayeeEndorsementState(client, endorsement, {
  ...fields,
  rotateToken: Boolean(fields?.token),
});

export const persistPhysicalEndorsementOnCheck = async (client, {
  endorsement,
  mapping,
  notes,
  spoof,
  previousCheck = {},
} = {}) => {
  const note = notes || 'Physical endorsement confirmed on check';
  const signedAt = new Date().toISOString();
  let endorsementRow = endorsement;

  if (!COMPLETE_ENDORSEMENT.has(String(endorsement?.status))) {
    // Staging/prod check_endorsements_signature_method_check allows
    // portal/sms/email/internal/manual (and later in_person). `physical_check`
    // is used by some UI copy but is not a legal column value.
    const updated = await client.query(
      `UPDATE public.check_endorsements
       SET status = 'signed',
           signed_at = now(),
           signature_method = 'manual',
           notes = COALESCE($2, notes),
           updated_at = now()
       WHERE id = $1::uuid
         AND status IS DISTINCT FROM 'signed'
         AND status IS DISTINCT FROM 'waived'
       RETURNING *`,
      [endorsement.id, note],
    );
    if (!updated.rowCount) {
      endorsementRow = await loadEndorsementById(client, endorsement.id);
      if (!endorsementRow || !COMPLETE_ENDORSEMENT.has(String(endorsementRow.status))) {
        return {
          ok: false,
          statusCode: 409,
          error: 'endorsement_persist_failed',
          message: 'Endorsement row was not updated',
          spoofFieldsIgnored: spoof,
        };
      }
    } else {
      endorsementRow = updated.rows[0];
    }
  }

  const payee = await persistPayeeEndorsementState(client, endorsementRow, {
    status: 'signed',
    signedAt,
    rotateToken: false,
  });
  if (!payee.ok || payee.skipped) {
    return {
      ok: false,
      statusCode: 409,
      error: payee.error || 'payee_persist_failed',
      message: payee.message || 'Payee endorsement state was not updated',
      spoofFieldsIgnored: spoof,
    };
  }

  await auditEndorsement(client, {
    endorsement_id: endorsementRow.id,
    check_id: endorsementRow.check_id,
    tenant_id: endorsementRow.tenant_id,
    event_type: 'endorsement_physical_on_check',
    check_event_type: 'endorsement_completed',
    event_description: `${endorsementRow.payee_name} endorsed on the physical check`,
    event_data: { method: 'manual', physical_on_check: true, token_rotated: false },
    actor_id: mapping?.application_user_id,
  });
  const verified = (await client.query(
    `SELECT e.status AS endorsement_status,
            e.signature_method,
            p.endorsement_status AS payee_status,
            p.endorsement_token
     FROM public.check_endorsements e
     JOIN public.check_payees p ON p.id = e.payee_id
     WHERE e.id = $1::uuid
     LIMIT 1`,
    [endorsementRow.id],
  )).rows[0];
  if (verified?.endorsement_status !== 'signed' || verified?.payee_status !== 'signed') {
    return {
      ok: false,
      statusCode: 409,
      error: 'persist_verify_failed',
      message: 'Endorsement action did not persist payee and endorsement state together',
      spoofFieldsIgnored: spoof,
    };
  }
  const completion = await completionWithoutAdvance(client, endorsementRow.check_id, previousCheck);
  return {
    ok: true,
    statusCode: 200,
    success: true,
    endorsement_status: verified.endorsement_status,
    payee_status: verified.payee_status,
    signature_method: verified.signature_method,
    token_rotated: false,
    ...completion,
    spoofFieldsIgnored: spoof,
  };
};

const auditEndorsement = async (client, row) => {
  await safeQuery(
    client,
    `INSERT INTO public.endorsement_audit_log (
       endorsement_id, check_id, event_type, event_description, event_data, actor_id, ip_address, user_agent
     ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::uuid, $7, $8)`,
    [
      row.endorsement_id,
      row.check_id,
      row.event_type,
      row.event_description,
      JSON.stringify(row.event_data || {}),
      row.actor_id || null,
      row.ip_address || null,
      row.user_agent || null,
    ],
  );
  await safeQuery(
    client,
    `INSERT INTO public.check_audit_log (
       check_id, event_type, event_description, event_data, actor_id, tenant_id
     ) VALUES ($1::uuid, $2, $3, $4::jsonb, $5::uuid, $6::uuid)`,
    [
      row.check_id,
      row.check_event_type || row.event_type,
      row.event_description,
      JSON.stringify(row.event_data || {}),
      row.actor_id || null,
      row.tenant_id || null,
    ],
  );
};

const revertUnauthorizedDepositAdvance = async (client, checkId, previous = {}) => {
  if (!checkId) return;
  const previousStatus = String(previous.status || '');
  const previousStage = String(previous.check_stage || '');
  if (['deposited', 'funds_released', 'disbursed_externally'].includes(previousStatus) || previousStage === 'deposited') {
    return;
  }
  const current = (await client.query(
    `SELECT status, check_stage, deposited_at
     FROM public.check_intake_items WHERE id = $1::uuid LIMIT 1`,
    [checkId],
  )).rows[0];
  if (!current || current.deposited_at) return;
  const advanced = current.check_stage === 'ready_for_deposit' || current.status === 'approved_for_deposit';
  if (!advanced) return;
  const restoreStatus = previousStatus || 'endorsements_in_progress';
  const restoreStage = previousStage || 'endorsing';
  if (restoreStatus === 'approved_for_deposit' || restoreStage === 'ready_for_deposit') return;
  await client.query(
    `UPDATE public.check_intake_items
     SET status = $2,
         check_stage = $3::check_stage,
         updated_at = now()
     WHERE id = $1::uuid
       AND deposited_at IS NULL
       AND status IS DISTINCT FROM 'deposited'`,
    [checkId, restoreStatus, restoreStage],
  );
  await safeQuery(
    client,
    `UPDATE public.claim_checks
     SET check_stage = $2::check_stage, updated_at = now()
     WHERE check_intake_item_id = $1::uuid
       AND check_stage IS DISTINCT FROM 'deposited'`,
    [checkId, restoreStage],
  );
};

const completionWithoutAdvance = async (client, checkId, previousCheck = {}) => {
  const rows = (await safeQuery(
    client,
    `SELECT status, payee_type FROM public.check_endorsements WHERE check_id = $1::uuid`,
    [checkId],
  )).rows;
  const result = evaluateEndorsementCompletion(rows);
  if (result.anyRejected) {
    await safeQuery(
      client,
      `UPDATE public.check_intake_items SET status = 'needs_review', updated_at = now() WHERE id = $1::uuid`,
      [checkId],
    );
  }
  await revertUnauthorizedDepositAdvance(client, checkId, previousCheck);
  return result;
};

const lookupPublicEndorsement = async (client, token) => {
  const doc = (await safeQuery(
    client,
    'SELECT public.aws_public_endorsement_by_token($1) AS doc',
    [token],
  )).rows[0]?.doc;
  if (doc) return { kind: 'endorsement', row: doc };
  const byToken = (await safeQuery(
    client,
    `SELECT e.*, ci.carrier_name, ci.check_number, ci.amount, ci.claim_id, ci.tenant_id
     FROM public.check_endorsements e
     LEFT JOIN public.check_intake_items ci ON ci.id = e.check_id
     WHERE e.token = $1
     LIMIT 1`,
    [token],
  )).rows[0];
  if (byToken) return { kind: 'endorsement', row: byToken };
  const payee = (await safeQuery(
    client,
    `SELECT p.id, p.check_id, p.payee_name, p.endorsement_status, p.endorsement_token,
            ci.carrier_name, ci.check_number, ci.amount, ci.claim_id, ci.tenant_id
     FROM public.check_payees p
     LEFT JOIN public.check_intake_items ci ON ci.id = p.check_id
     WHERE p.endorsement_token = $1
     LIMIT 1`,
    [token],
  )).rows[0];
  if (!payee) return { kind: 'missing', row: null };
  const endorsement = (await safeQuery(
    client,
    `SELECT e.*, ci.carrier_name, ci.check_number, ci.amount, ci.claim_id, ci.tenant_id
     FROM public.check_endorsements e
     LEFT JOIN public.check_intake_items ci ON ci.id = e.check_id
     WHERE e.payee_id = $1::uuid
     ORDER BY e.updated_at DESC NULLS LAST
     LIMIT 1`,
    [payee.id],
  )).rows[0];
  if (endorsement) return { kind: 'endorsement', row: endorsement };
  return { kind: 'payee', row: payee };
};

const unknownPublicEndorsementToken = (spoof, { statusCode = 404 } = {}) => ({
  ok: false,
  statusCode,
  error: 'This endorsement link is invalid or has expired.',
  code: 'invalid_link',
  spoofFieldsIgnored: spoof,
});

export const runGetEndorsementData = async (client, token, spoof) => {
  if (!token) return unknownPublicEndorsementToken(spoof, { statusCode: 400 });
  const found = await lookupPublicEndorsement(client, token);
  if (found.kind === 'missing' || !found.row) {
    return unknownPublicEndorsementToken(spoof);
  }
  const row = found.row;
  const status = row.status || row.endorsement_status || 'pending';
  if (['signed', 'rejected', 'waived', 'expired'].includes(String(status))) {
    return {
      ok: false,
      statusCode: 404,
      error: 'This endorsement link has already been used or replaced.',
      code: 'token_consumed',
      spoofFieldsIgnored: spoof,
    };
  }
  return {
    ok: true,
    statusCode: 200,
    id: row.id,
    payee_name: row.payee_name,
    status,
    carrier_name: row.carrier_name || 'Unknown Carrier',
    check_number: row.check_number || 'N/A',
    amount: row.amount ?? null,
    token: row.token || row.endorsement_token || token,
    requires_payment_direction: false,
    spoofFieldsIgnored: spoof,
  };
};

export const runSubmitEndorsement = async (client, event, body, spoof, deps = {}) => {
  const token = String(body.token || '').trim();
  if (!token) return { ok: false, statusCode: 400, error: 'Token required', spoofFieldsIgnored: spoof };
  if (body.eSignConsentAccepted !== true) {
    return { ok: false, statusCode: 400, error: 'Electronic signature consent is required', spoofFieldsIgnored: spoof };
  }
  const signatureData = body.signatureData;
  let signatureImageUrl = null;
  if (typeof signatureData === 'string' && (signatureData.startsWith('data:image/') || signatureData.startsWith('typed:'))) {
    signatureImageUrl = signatureData;
  }
  const newToken = rotateToken();
  const ip = clientIpFromEvent(event);
  const ua = userAgentFromEvent(event);
  const consent = typeof body.consentText === 'string' && body.consentText.trim()
    ? body.consentText
    : DEFAULT_CONSENT_TEXT;
  const checkId = body.checkId || body.check_id || null;
  const payeeId = body.payeeId || body.payee_id || null;
  let doc;
  try {
    doc = readRpcDoc(await execPublicWriteRpc(
      client,
      `SELECT public.aws_public_submit_endorsement(
         $1, $2, $3, $4, $5, $6, $7::uuid, $8::uuid
       ) AS doc`,
      [token, signatureImageUrl, consent, ip, ua, newToken, checkId, payeeId],
      deps,
    ));
  } catch (error) {
    return {
      ok: false,
      statusCode: 503,
      error: 'endorsement_failed',
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  }
  if (!doc) {
    return { ok: false, statusCode: 503, error: 'endorsement_failed', spoofFieldsIgnored: spoof };
  }
  if (doc.ok === false) {
    const statusCode = Number(doc.statusCode || 404);
    const error = doc.error === 'check_mismatch' || doc.error === 'payee_mismatch'
      ? 'Token does not match this check'
      : 'Invalid or already-used token';
    return { ok: false, statusCode, error, code: doc.error, spoofFieldsIgnored: spoof };
  }
  const endorsement = doc;
  if (doc.already_signed) {
    return {
      ok: true,
      statusCode: 200,
      success: true,
      message: 'Already endorsed',
      ...denyDepositAdvance(),
      spoofFieldsIgnored: spoof,
    };
  }
  await updatePayeeSigned(client, endorsement, {
    status: 'signed',
    token: newToken,
    image: signatureImageUrl,
    signedAt: new Date().toISOString(),
  });
  await auditEndorsement(client, {
    endorsement_id: endorsement.id,
    check_id: endorsement.check_id,
    tenant_id: endorsement.tenant_id,
    event_type: 'endorsement_signed',
    check_event_type: 'endorsement_completed',
    event_description: `${endorsement.payee_name} endorsed the check`,
    event_data: { has_signature: Boolean(signatureData), e_sign_consent_accepted: true },
    ip_address: ip,
    user_agent: ua,
  });
  const completion = await completionWithoutAdvance(client, endorsement.check_id);
  const next = (await safeQuery(
    client,
    `SELECT token, payee_name FROM public.check_endorsements
     WHERE check_id = $1::uuid AND id <> $2::uuid AND status IN ('pending', 'sent')
       AND contact_email IS NOT NULL AND contact_email = $3
     ORDER BY created_at ASC NULLS LAST
     LIMIT 1`,
    [endorsement.check_id, endorsement.id, endorsement.contact_email],
  )).rows[0];
  return {
    ok: true,
    statusCode: 200,
    success: true,
    next_token: next?.token || null,
    next_payee_name: next?.payee_name || null,
    ...completion,
    spoofFieldsIgnored: spoof,
  };
};

export const runRejectEndorsement = async (client, event, body, spoof, deps = {}) => {
  const token = String(body.token || '').trim();
  if (!token) return { ok: false, statusCode: 400, error: 'Token required', spoofFieldsIgnored: spoof };
  const newToken = rotateToken();
  const ip = clientIpFromEvent(event);
  const ua = userAgentFromEvent(event);
  let doc;
  try {
    doc = readRpcDoc(await execPublicWriteRpc(
      client,
      'SELECT public.aws_public_reject_endorsement($1, $2, $3, $4, $5) AS doc',
      [token, body.reason || null, ip, ua, newToken],
      deps,
    ));
  } catch (error) {
    return {
      ok: false,
      statusCode: 503,
      error: 'endorsement_failed',
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  }
  if (!doc || doc.ok === false) {
    return {
      ok: false,
      statusCode: Number(doc?.statusCode || 404),
      error: 'Invalid or already-used token',
      code: doc?.error || 'invalid_or_used_token',
      spoofFieldsIgnored: spoof,
    };
  }
  const endorsement = doc;
  await updatePayeeSigned(client, endorsement, { status: 'rejected', token: newToken });
  await auditEndorsement(client, {
    endorsement_id: endorsement.id,
    check_id: endorsement.check_id,
    tenant_id: endorsement.tenant_id,
    event_type: 'endorsement_rejected',
    event_description: `${endorsement.payee_name} rejected endorsement`,
    event_data: { reason: body.reason || null },
    ip_address: ip,
    user_agent: ua,
  });
  const completion = await completionWithoutAdvance(client, endorsement.check_id);
  return { ok: true, statusCode: 200, success: true, ...completion, spoofFieldsIgnored: spoof };
};

export const runPublicEndorsement = async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const action = body.action || 'get_endorsement_data';
  if (!PUBLIC_ENDORSEMENT_ACTIONS.has(action)) {
    return { ok: false, statusCode: 400, error: 'Unknown action', spoofFieldsIgnored: spoof };
  }
  const token = String(body.token || '').trim();
  if (!token) {
    return { ok: false, statusCode: 400, error: 'Token required', spoofFieldsIgnored: spoof };
  }
  const write = action !== 'get_endorsement_data';
  let opened;
  try {
    opened = await publicDb(write, deps);
    const { client } = opened;
    // GET also needs a transaction: safeQuery wraps the SQL 72 RPC in SAVEPOINT,
    // and PostgreSQL rejects SAVEPOINT outside a transaction block. That swallow
    // made unused tokens look consumed/invalid even with the RPC present.
    await client.query('BEGIN');
    if (write) {
      await client.query('SET TRANSACTION READ WRITE');
    } else {
      await client.query('SET TRANSACTION READ ONLY');
    }
    let result;
    if (action === 'get_endorsement_data') {
      result = await runGetEndorsementData(client, String(body.token || '').trim(), spoof);
    } else if (action === 'submit_endorsement') {
      result = await runSubmitEndorsement(client, event, body, spoof, { ...deps, _requestClient: client });
    } else if (action === 'reject_endorsement') {
      result = await runRejectEndorsement(client, event, body, spoof, { ...deps, _requestClient: client });
    } else {
      result = { ok: false, statusCode: 400, error: 'Unknown action', spoofFieldsIgnored: spoof };
    }
    if (result.ok !== false && (result.statusCode || 200) < 400) {
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK');
    }
    return result;
  } catch (error) {
    if (opened?.client) {
      try { await opened.client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return {
      ok: false,
      statusCode: 503,
      error: 'endorsement_failed',
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (opened?.owned) {
      try { await opened.client.end(); } catch { /* ignore */ }
    }
  }
};

export const handlePublicEndorsement = (event, deps = {}) => runPublicEndorsement(event, deps);

export const runAuthenticatedEndorsement = async ({
  client, mapping, body, spoof, event, send,
  durableAudit = false,
  openAuditClient = null,
}) => {
  const action = body.action;
  if (!AUTH_ENDORSEMENT_ACTIONS.has(action)) {
    return { ok: false, statusCode: 400, error: 'Unknown action', spoofFieldsIgnored: spoof };
  }

  const endorsementId = await resolveEndorsementId(client, body);
  if (!endorsementId) {
    return { ok: false, statusCode: 400, error: 'endorsementId (or payeeId) required', spoofFieldsIgnored: spoof };
  }
  const endorsement = await loadEndorsementById(client, endorsementId);
  if (!endorsement) {
    return { ok: false, statusCode: 404, error: 'Endorsement not found', spoofFieldsIgnored: spoof };
  }
  const check = await loadCheckForEndorsement(client, endorsement);
  const tenantId = endorsement.tenant_id || check.tenant_id;
  if (!await canWriteTenant(client, tenantId)) {
    return { ok: false, statusCode: 403, error: 'forbidden', spoofFieldsIgnored: spoof };
  }

  if (action === 'send_endorsement_request') {
    if (isContractorPayee(endorsement.payee_type)) {
      return {
        ok: false,
        statusCode: 400,
        error: 'Contractors cannot sign an endorsement. Their email will be CC\'d when the insured is notified.',
        code: 'contractor_cc_only',
        spoofFieldsIgnored: spoof,
      };
    }
    const email = String(body.email || endorsement.contact_email || '').trim();
    const phone = String(body.phone || endorsement.contact_phone || '').trim() || null;
    if (!email) {
      return { ok: false, statusCode: 502, success: false, error: 'Email delivery failed', details: { emailError: 'Missing payee email address' }, spoofFieldsIgnored: spoof };
    }
    const suppliedKey = String(body.idempotencyKey || body.idempotency_key || '').trim();
    const generation = endorsement.request_sent_at || 'none';
    const idempotencyKey = suppliedKey || stableEmailIdempotencyKey('endorsement', endorsement.id, generation);
    const prior = await peekAuditedEmail(client, idempotencyKey);
    if (!prior.ok) return { ...prior, spoofFieldsIgnored: spoof };
    if (prior.duplicate) {
      const marked = await markEndorsementRequestSent(client, {
        endorsementId: endorsement.id,
        email,
        token: prior.row?.metadata?.endorsement_token || endorsement.token,
        durableAudit,
        openAuditClient,
      });
      if (!marked.ok && marked.statusCode === 403) {
        return { ok: false, statusCode: 403, error: 'forbidden', spoofFieldsIgnored: spoof };
      }
      return {
        ...replayIdempotentSend(prior.row, spoof),
        emailSent: true,
        requestSentAt: marked.doc?.request_sent_at || endorsement.request_sent_at || null,
        ...denyDepositAdvance(),
      };
    }
    if (endorsementRateLimited(endorsement.request_sent_at)) {
      return { ok: false, statusCode: 429, error: 'Request was sent recently. Please wait before resending.', spoofFieldsIgnored: spoof };
    }
    // Do not UPDATE check_endorsements in this request transaction before the
    // mailer. That row lock blocked aws_mark_endorsement_request_sent on the
    // independent audit connection (Query read timeout after sink/SES accept).
    const activeToken = endorsement.token || rotateToken();
    const endorsementUrl = `${appUrl()}/endorse?token=${activeToken}`;
    const tenant = tenantId
      ? (await safeQuery(
        client,
        `SELECT name, logo_url, primary_color, email_from_name, business_phone, email_reply_to
         FROM public.tenants WHERE id = $1::uuid LIMIT 1`,
        [tenantId],
      )).rows[0]
      : null;
    const brandingRow = (await safeQuery(
      client,
      `SELECT company_name, company_email, company_phone, endorsement_email_subject
       FROM public.company_branding LIMIT 1`,
    )).rows[0] || {};
    const resolved = await resolveEmailBranding(client, { tenantId });
    const reply = validatedMailReplyTo(resolved.replyTo);
    if (!reply.ok) {
      return { ok: false, statusCode: 400, error: reply.error, spoofFieldsIgnored: spoof };
    }
    const branding = {
      company_name: resolved.companySubtitle || resolved.companyName || tenant?.email_from_name || tenant?.name || brandingRow.company_name,
      company_email: reply.replyTo || tenant?.email_reply_to || brandingRow.company_email,
      endorsement_email_subject: brandingRow.endorsement_email_subject,
      from: resolved.from,
      replyTo: reply.replyTo,
      primaryColor: resolved.primaryColor,
      logoUrl: resolved.logoUrl,
      companySubtitle: resolved.companySubtitle,
    };
    const ccRaw = body.cc;
    const cc = Array.isArray(ccRaw)
      ? ccRaw.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim())
      : (typeof ccRaw === 'string' && ccRaw.trim() ? [ccRaw.trim()] : []);
    const contractors = (await safeQuery(
      client,
      `SELECT contact_email FROM public.check_payees
       WHERE check_id = $1::uuid AND payee_type = 'contractor'`,
      [endorsement.check_id],
    )).rows;
    for (const row of contractors) {
      const em = String(row.contact_email || '').trim();
      if (em && !cc.some((v) => v.toLowerCase() === em.toLowerCase()) && em.toLowerCase() !== email.toLowerCase()) {
        cc.push(em);
      }
    }
    let emailSent = false;
    let emailError = null;
    let providerMessageId = null;
    const rendered = renderTransactionalTemplate('endorsement-request', {
      payeeName: endorsement.payee_name,
      checkNumber: check.check_number || 'N/A',
      carrier: check.carrier_name || 'Unknown',
      amount: check.amount,
      endorseUrl: endorsementUrl,
      companyName: branding.company_name || 'ChecksOps',
      branding,
      subject: branding.endorsement_email_subject || undefined,
    });
    const subjectBase = branding.endorsement_email_subject
      || `Endorsement Required — Check #${check.check_number || 'N/A'}`;
    const subject = subjectBase.includes(endorsement.payee_name)
      ? subjectBase
      : `${subjectBase} — ${endorsement.payee_name}`;
    const uniqueRecipients = [...new Set([email, ...cc].map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
    for (const recipient of uniqueRecipients) {
      const recipientKey = recipient === email.toLowerCase()
        ? idempotencyKey
        : stableEmailIdempotencyKey(idempotencyKey, recipient);
      const delivery = await deliverAuditedEmail(client, {
        templateName: 'endorsement-request',
        recipientEmail: recipient,
        tenantId,
        idempotencyKey: recipientKey,
        applicationUserId: mapping.application_user_id,
        metadata: {
          endorsement_id: endorsement.id,
          check_id: endorsement.check_id,
          workflow: 'endorsement-request',
          endorsement_token: activeToken,
        },
        spoof,
        send,
        durableAudit,
        openAuditClient,
        mailerArgs: {
          subject,
          html: rendered.html,
          text: rendered.text,
          from: branding.from || defaultFromAddress(),
          replyTo: branding.replyTo,
        },
      });
      if (!delivery.ok) {
        if (delivery.statusCode === 503) return { ...delivery, spoofFieldsIgnored: spoof };
        emailError = delivery.error || 'audit_unavailable';
        emailSent = false;
        break;
      }
      emailSent = true;
      if (recipient === email.toLowerCase()) {
        providerMessageId = delivery.providerMessageId || delivery.replay?.providerMessageId || null;
      }
    }
    if (!emailSent) {
      await auditEndorsement(client, {
        endorsement_id: endorsement.id,
        check_id: endorsement.check_id,
        tenant_id: tenantId,
        event_type: 'request_failed',
        check_event_type: 'endorsement_request_failed',
        event_description: `Delivery failed: ${emailError}`,
        event_data: { emailError },
        actor_id: mapping.application_user_id,
      });
      return { ok: false, statusCode: 502, success: false, error: 'Email delivery failed', details: { emailError }, spoofFieldsIgnored: spoof };
    }
    const marked = await markEndorsementRequestSent(client, {
      endorsementId: endorsement.id,
      email,
      token: activeToken,
      durableAudit,
      openAuditClient,
    });
    if (!marked.ok) {
      return {
        ok: false,
        statusCode: marked.statusCode || 503,
        success: false,
        error: 'request_sent_unfinalized',
        details: {
          emailError: marked.error || 'endorsement_update_failed',
          providerMessageId,
        },
        providerMessageId,
        emailSent: true,
        ...denyDepositAdvance(),
        spoofFieldsIgnored: spoof,
      };
    }
    if (endorsement.payee_id) {
      await safeQuery(
        client,
        `UPDATE public.check_payees
         SET endorsement_token = $2, endorsement_token_expires_at = NULL,
             contact_email = COALESCE($3, contact_email),
             contact_phone = COALESCE($4, contact_phone),
             updated_at = now()
         WHERE id = $1::uuid`,
        [endorsement.payee_id, activeToken, email, phone],
      );
    }
    await safeQuery(
      client,
      `INSERT INTO public.endorsement_requests (
         endorsement_id, check_id, method, sent_by, delivery_status, email_address
       ) VALUES ($1::uuid, $2::uuid, 'email', $3::uuid, 'delivered', $4)`,
      [endorsement.id, endorsement.check_id, mapping.application_user_id, email],
    );
    await safeQuery(
      client,
      `UPDATE public.check_intake_items
       SET status = 'endorsements_in_progress', updated_at = now()
       WHERE id = $1::uuid
         AND status IS DISTINCT FROM 'approved_for_deposit'
         AND COALESCE(deposit_recommendation, '') IS DISTINCT FROM 'ready_for_deposit'`,
      [endorsement.check_id],
    );
    await auditEndorsement(client, {
      endorsement_id: endorsement.id,
      check_id: endorsement.check_id,
      tenant_id: tenantId,
      event_type: 'request_sent',
      check_event_type: 'endorsement_request_sent',
      event_description: `Endorsement request sent to ${endorsement.payee_name} via email`,
      event_data: { method: 'email' },
      actor_id: mapping.application_user_id,
    });
    return {
      ok: true,
      statusCode: 200,
      success: true,
      endorsementUrl,
      emailSent: true,
      providerMessageId,
      requestSentAt: marked.doc?.request_sent_at || null,
      ...denyDepositAdvance(),
      spoofFieldsIgnored: spoof,
    };
  }

  if (action === 'sign_in_person') {
    const signatureData = body.signatureData;
    if (!signatureData || !String(signatureData).startsWith('data:image/')) {
      return { ok: false, statusCode: 400, error: 'signatureData (data:image/*) required', spoofFieldsIgnored: spoof };
    }
    if (body.eSignConsentAccepted !== true) {
      return { ok: false, statusCode: 400, error: 'Consent required', spoofFieldsIgnored: spoof };
    }
    const newToken = rotateToken();
    const ip = clientIpFromEvent(event);
    const ua = userAgentFromEvent(event);
    const consent = typeof body.consentText === 'string' && body.consentText.trim()
      ? body.consentText
      : 'In-person electronic signature captured by staff on behalf of the named payee, who consented to sign electronically.';
    await client.query(
      `UPDATE public.check_endorsements
       SET status = 'signed',
           signed_at = now(),
           signature_image_url = $2,
           signature_method = 'in_person',
           ip_address = $3,
           user_agent = $4,
           consent_text = $5,
           token = $6,
           token_expires_at = NULL,
           notes = COALESCE($7, notes),
           updated_at = now()
       WHERE id = $1::uuid`,
      [endorsement.id, signatureData, ip, ua, consent, newToken, body.notes || 'Signed in person, captured by staff'],
    );
    const payeeSigned = await updatePayeeSigned(client, endorsement, {
      status: 'signed',
      token: newToken,
      image: signatureData,
      signedAt: new Date().toISOString(),
    });
    if (!payeeSigned.ok) {
      return {
        ok: false,
        statusCode: 409,
        error: payeeSigned.error,
        message: payeeSigned.message,
        spoofFieldsIgnored: spoof,
      };
    }
    await auditEndorsement(client, {
      endorsement_id: endorsement.id,
      check_id: endorsement.check_id,
      tenant_id: tenantId,
      event_type: 'endorsement_in_person',
      check_event_type: 'endorsement_completed',
      event_description: `${endorsement.payee_name} signed in person`,
      event_data: { method: 'in_person' },
      actor_id: mapping.application_user_id,
      ip_address: ip,
      user_agent: ua,
    });
    const completion = await completionWithoutAdvance(client, endorsement.check_id);
    return { ok: true, statusCode: 200, success: true, ...completion, spoofFieldsIgnored: spoof };
  }

  if (action === 'mark_internal_signed') {
    await client.query(
      `UPDATE public.check_endorsements
       SET status = 'signed',
           signed_at = now(),
           signature_method = 'internal',
           signature_image_url = NULL,
           notes = COALESCE($2, notes),
           updated_at = now()
       WHERE id = $1::uuid`,
      [endorsement.id, body.notes || 'Internally endorsed by staff'],
    );
    const payeeSigned = await updatePayeeSigned(client, endorsement, { status: 'signed', signedAt: new Date().toISOString() });
    if (!payeeSigned.ok) {
      return {
        ok: false,
        statusCode: 409,
        error: payeeSigned.error,
        message: payeeSigned.message,
        spoofFieldsIgnored: spoof,
      };
    }
    await auditEndorsement(client, {
      endorsement_id: endorsement.id,
      check_id: endorsement.check_id,
      tenant_id: tenantId,
      event_type: 'internal_endorsement',
      event_description: `${endorsement.payee_name} endorsed internally by staff`,
      actor_id: mapping.application_user_id,
    });
    const completion = await completionWithoutAdvance(client, endorsement.check_id);
    return { ok: true, statusCode: 200, success: true, ...completion, spoofFieldsIgnored: spoof };
  }

  if (action !== 'waive_endorsement') {
    return { ok: false, statusCode: 400, error: 'Unknown action', spoofFieldsIgnored: spoof };
  }
  return persistPhysicalEndorsementOnCheck(client, {
    endorsement: { ...endorsement, tenant_id: tenantId },
    mapping,
    notes: body.notes || 'Physical endorsement confirmed on check',
    spoof,
    previousCheck: check,
  });
};

export const handleCheckEndorsement = async (event, deps = {}) => {
  const body = parseBody(event);
  if (PUBLIC_ENDORSEMENT_ACTIONS.has(body.action || 'get_endorsement_data')) {
    return handlePublicEndorsement(event, deps);
  }
  return withIdentityWrite(event, (ctx) => runAuthenticatedEndorsement({
    ...ctx,
    event,
    send: deps.sendViaSesOrSink,
    durableAudit: deps.durableAudit !== false,
    openAuditClient: deps.openAuditClient,
  }), deps);
};
