/**
 * Check Command Center / public Endorse workflow (Class A).
 * Ports Lovable check-endorsement actions onto Cognito + Resend (gated) / sink.
 * Auto-advance to Ready for Deposit is gated by AWS_ENDORSEMENT_AUTO_ADVANCE.
 * Official endorsed rear JPEG must exist before workflow Ready is applied.
 * Does not trigger payment-direction disbursement, CheckAlt, or Moov.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { parseBody, ignoredSpoof, withIdentityWrite } from './data.mjs';
import { APP_USER_ID_GUC } from './cognito.mjs';
import { loadDatabaseCredentials } from './secrets.mjs';
import { buildClientConfig, buildWriteClientConfig, sanitizePublicError } from './db-health.mjs';
import { sendViaSesOrSink } from './email.mjs';
import { renderTransactionalTemplate } from './email-templates.mjs';
import { resolveEmailBranding } from './email-branding.mjs';
import {
  allowDepositAdvance,
  endorsementAutoAdvanceEnabled,
  endorsementFromAddress,
  endorsementResendEnabled,
  INELIGIBLE_AUTO_ADVANCE_STATUSES,
  isSuccessfulEndorsementDelivery,
  sendViaResend,
} from './endorsement-parity.mjs';
import {
  afterGenuineEndorsementSigned,
  compositeEndorsementSignatures,
  invalidateOfficialRearImage,
  requireDrawnSignature,
} from './endorsement-composite.mjs';
import {
  decideReadyTransition,
  evaluateEndorsementMath,
  isActiveLossDraft,
  isContractorPayee as isContractorPayeeType,
  isEndorsementSatisfied,
} from './endorsement-completion.mjs';
import { syncPayeeAfterEndorsement, synchronizePayeesFromEndorsements } from './endorsement-payee-sync.mjs';

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
  'force_complete_endorsements',
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
  const math = evaluateEndorsementMath(rows);
  if (!rows.length) return { allSigned: false, anyRejected: false, ...denyDepositAdvance() };
  return {
    allSigned: math.allRequiredSatisfied && !math.anyRejected,
    anyRejected: math.anyRejected,
    ...denyDepositAdvance(),
  };
};

export const isContractorPayee = isContractorPayeeType;

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
  return { client, owned: true };
};

const safeQuery = async (client, sql, params = []) => {
  try {
    return await client.query(sql, params);
  } catch {
    return { rows: [], rowCount: 0 };
  }
};

const canWriteTenant = async (client, tenantId) => {
  if (!tenantId) return false;
  const ok = (await safeQuery(
    client,
    'SELECT public.aws_can_write_tenant($1::uuid) AS ok',
    [tenantId],
  )).rows[0]?.ok;
  return ok === true;
};

const loadCheckForEndorsement = async (client, endorsement) => {
  if (!endorsement?.check_id) return {};
  return (await safeQuery(
    client,
    `SELECT id, tenant_id, claim_id, carrier_name, check_number, amount, status,
            deposit_recommendation, check_stage, deposited_at, back_image_deposit_path
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

export const updatePayeeSigned = (client, endorsement, payload) => (
  syncPayeeAfterEndorsement(client, endorsement, payload)
);

export const retryAutoAdvanceAfterOfficialRear = async (client, checkId) => {
  const evaluation = await evaluateCompletionState(client, checkId);
  return applyAutoAdvanceIfEligible(client, checkId, evaluation, { officialRearReady: true });
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

const evaluateCompletionState = async (client, checkId) => {
  const rows = (await safeQuery(
    client,
    `SELECT status, payee_type FROM public.check_endorsements WHERE check_id = $1::uuid`,
    [checkId],
  )).rows;
  return evaluateEndorsementCompletion(rows);
};

const applyRejectedWorkflow = async (client, checkId, result) => {
  const check = await loadCheckForEndorsement(client, { check_id: checkId });
  const ineligible = INELIGIBLE_AUTO_ADVANCE_STATUSES.has(String(check.status || ''))
    || Boolean(check.deposited_at);
  if (!ineligible) {
    await safeQuery(
      client,
      `UPDATE public.check_intake_items
       SET status = 'needs_review', updated_at = now()
       WHERE id = $1::uuid
         AND deposited_at IS NULL
         AND status IS DISTINCT FROM 'deposited'`,
      [checkId],
    );
  }
  return { ...result, newStatus: ineligible ? check.status || null : 'needs_review' };
};

export const applyAutoAdvanceIfEligible = async (client, checkId, result, { officialRearReady = false } = {}) => {
  const check = await loadCheckForEndorsement(client, { check_id: checkId });
  const ineligible = INELIGIBLE_AUTO_ADVANCE_STATUSES.has(String(check.status || ''))
    || Boolean(check.deposited_at);

  if (result.anyRejected) {
    return applyRejectedWorkflow(client, checkId, result);
  }

  if (!result.allSigned || !endorsementAutoAdvanceEnabled()) {
    return result;
  }
  const readyDecision = decideReadyTransition(check, {
    allRequiredSatisfied: result.allSigned,
    anyRejected: result.anyRejected,
  });
  if (readyDecision.action === 'hold_loss_draft' || isActiveLossDraft(check)) {
    return {
      ...result,
      depositAdvanceDenied: true,
      advance_check_on_endorsement_complete: 'held_loss_draft',
      newStatus: check.status || 'loss_draft_required',
    };
  }
  if (ineligible) {
    return {
      ...result,
      depositAdvanceDenied: true,
      advance_check_on_endorsement_complete: 'skipped_ineligible',
      newStatus: check.status || null,
    };
  }
  if (!officialRearReady) {
    return {
      ...result,
      depositAdvanceDenied: true,
      advance_check_on_endorsement_complete: 'blocked_official_rear_missing',
      officialRearReady: false,
      newStatus: check.status || null,
    };
  }

  if (String(check.deposit_recommendation || '') === 'branch_deposit_recommended') {
    if (check.status === 'branch_deposit_required') {
      return {
        ...result,
        ...allowDepositAdvance('branch_deposit_required'),
        advance_check_on_endorsement_complete: 'already_ready',
      };
    }
    await safeQuery(
      client,
      `UPDATE public.check_intake_items
       SET status = 'branch_deposit_required', updated_at = now()
       WHERE id = $1::uuid
         AND deposited_at IS NULL
         AND status IS DISTINCT FROM 'deposited'`,
      [checkId],
    );
    await safeQuery(
      client,
      `INSERT INTO public.check_audit_log (
         check_id, event_type, event_description, event_data, tenant_id
       ) VALUES (
         $1::uuid, 'all_endorsements_complete',
         'All endorsements complete — routed to branch deposit workflow',
         $2::jsonb, $3::uuid
       )`,
      [checkId, JSON.stringify({ deposit_path: 'branch_deposit_required' }), check.tenant_id || null],
    );
    return { ...result, ...allowDepositAdvance('branch_deposit_required') };
  }

  const alreadyReady = check.status === 'approved_for_deposit'
    && String(check.deposit_recommendation || '') === 'ready_for_deposit';
  if (alreadyReady) {
    if (String(check.check_stage || '') !== 'ready_for_deposit') {
      await safeQuery(
        client,
        `UPDATE public.check_intake_items
         SET check_stage = 'ready_for_deposit', updated_at = now()
         WHERE id = $1::uuid
           AND deposited_at IS NULL
           AND status IS DISTINCT FROM 'deposited'
           AND status IS DISTINCT FROM 'voided'
           AND status IS DISTINCT FROM 'loss_draft_required'`,
        [checkId],
      );
      await safeQuery(
        client,
        `UPDATE public.claim_checks
         SET check_stage = 'ready_for_deposit', updated_at = now()
         WHERE check_intake_item_id = $1::uuid`,
        [checkId],
      );
    }
    return {
      ...result,
      ...allowDepositAdvance('approved_for_deposit'),
      advance_check_on_endorsement_complete: 'already_ready',
    };
  }

  await safeQuery(
    client,
    `UPDATE public.check_intake_items
     SET status = 'approved_for_deposit',
         deposit_recommendation = 'ready_for_deposit',
         check_stage = 'ready_for_deposit',
         updated_at = now()
     WHERE id = $1::uuid
       AND deposited_at IS NULL
       AND status IS DISTINCT FROM 'deposited'
       AND status IS DISTINCT FROM 'voided'
       AND status IS DISTINCT FROM 'loss_draft_required'
       AND check_stage IS DISTINCT FROM 'loss_draft'`,
    [checkId],
  );
  await safeQuery(
    client,
    `UPDATE public.claim_checks
     SET check_stage = 'ready_for_deposit', updated_at = now()
     WHERE check_intake_item_id = $1::uuid`,
    [checkId],
  );
  await safeQuery(
    client,
    `INSERT INTO public.check_audit_log (
       check_id, event_type, event_description, event_data, tenant_id
     ) VALUES (
       $1::uuid, 'all_endorsements_complete',
       'All endorsements complete — ready for deposit',
       $2::jsonb, $3::uuid
     )`,
    [
      checkId,
      JSON.stringify({
        status: 'approved_for_deposit',
        deposit_recommendation: 'ready_for_deposit',
        check_stage: 'ready_for_deposit',
      }),
      check.tenant_id || null,
    ],
  );
  return { ...result, ...allowDepositAdvance('approved_for_deposit') };
};

export const finalizeEndorsementState = async (client, checkId, {
  refreshOfficialRear = false,
  compositeDeps = {},
} = {}) => {
  const evaluation = await evaluateCompletionState(client, checkId);
  const check = await loadCheckForEndorsement(client, { check_id: checkId });
  const ineligible = INELIGIBLE_AUTO_ADVANCE_STATUSES.has(String(check.status || ''))
    || Boolean(check.deposited_at);

  if (ineligible) {
    if (evaluation.anyRejected) {
      return { ...evaluation, newStatus: check.status || null };
    }
    return {
      ...evaluation,
      depositAdvanceDenied: true,
      advance_check_on_endorsement_complete: evaluation.allSigned ? 'skipped_ineligible' : 'denied',
      newStatus: check.status || null,
      officialRearReady: false,
    };
  }

  if (evaluation.anyRejected) {
    if (refreshOfficialRear) {
      await invalidateOfficialRearImage(client, checkId, compositeDeps);
    }
    return applyRejectedWorkflow(client, checkId, evaluation);
  }

  let composited = null;
  if (refreshOfficialRear) {
    const signed = await afterGenuineEndorsementSigned(client, checkId, {
      ...compositeDeps,
      skipComposite: !evaluation.allSigned,
    });
    composited = signed.composited;
  } else if (evaluation.allSigned) {
    composited = await compositeEndorsementSignatures({
      client,
      checkId,
      deps: compositeDeps,
    });
  }

  const officialRearReady = Boolean(
    composited?.ok
    && (composited.back_image_deposit_path || composited.endorsed_back_image_path),
  );
  const advanced = await applyAutoAdvanceIfEligible(client, checkId, evaluation, { officialRearReady });
  return { ...advanced, composited, officialRearReady };
};

const bindPublicWriter = async (client, endorsement) => {
  const actorId = endorsement?.uploaded_by || endorsement?.actor_id || null;
  if (!actorId) return false;
  await client.query('SELECT set_config($1, $2, true)', [APP_USER_ID_GUC, String(actorId)]);
  return true;
};

const lookupPublicEndorsement = async (client, token) => {
  const doc = (await safeQuery(
    client,
    'SELECT public.aws_public_endorsement_by_token($1) AS doc',
    [token],
  )).rows[0]?.doc;
  if (doc?.id) return doc;
  const byToken = (await safeQuery(
    client,
    `SELECT * FROM public.check_endorsements WHERE token = $1 LIMIT 1`,
    [token],
  )).rows[0];
  if (byToken) return byToken;
  const payee = (await safeQuery(
    client,
    `SELECT id, check_id FROM public.check_payees WHERE endorsement_token = $1 LIMIT 1`,
    [token],
  )).rows[0];
  if (!payee) return null;
  return (await safeQuery(
    client,
    `SELECT e.*, ci.carrier_name, ci.check_number, ci.amount, ci.claim_id, ci.tenant_id
     FROM public.check_endorsements e
     LEFT JOIN public.check_intake_items ci ON ci.id = e.check_id
     WHERE e.payee_id = $1::uuid
     ORDER BY e.updated_at DESC NULLS LAST
     LIMIT 1`,
    [payee.id],
  )).rows[0] || null;
};

export const runGetEndorsementData = async (client, token, spoof) => {
  if (!token) return { ok: false, statusCode: 400, error: 'Token required', spoofFieldsIgnored: spoof };
  const row = await lookupPublicEndorsement(client, token);
  if (!row) {
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
    status: row.status,
    carrier_name: row.carrier_name || 'Unknown Carrier',
    check_number: row.check_number || 'N/A',
    amount: row.amount ?? null,
    token: row.token,
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
  const endorsement = await lookupPublicEndorsement(client, token);
  if (!endorsement) {
    return { ok: false, statusCode: 404, error: 'Invalid or already-used token', spoofFieldsIgnored: spoof };
  }
  await bindPublicWriter(client, endorsement);
  if (endorsement.status === 'signed') {
    return { ok: true, statusCode: 200, success: true, message: 'Already endorsed', ...denyDepositAdvance(), spoofFieldsIgnored: spoof };
  }
  const required = requireDrawnSignature(body.signatureData);
  if (!required.ok) return { ...required, spoofFieldsIgnored: spoof };
  const signatureData = body.signatureData;
  const signatureImageUrl = signatureData;
  const newToken = rotateToken();
  const ip = clientIpFromEvent(event);
  const ua = userAgentFromEvent(event);
  const consent = typeof body.consentText === 'string' && body.consentText.trim()
    ? body.consentText
    : DEFAULT_CONSENT_TEXT;
  const marked = await client.query(
    `UPDATE public.check_endorsements
     SET status = 'signed',
         signed_at = now(),
         signature_image_url = $2,
         signature_method = 'portal',
         ip_address = $3,
         user_agent = $4,
         consent_text = $5,
         token = $6,
         token_expires_at = NULL,
         updated_at = now()
     WHERE id = $1::uuid AND token = $7
     RETURNING id, status, signed_at`,
    [endorsement.id, signatureImageUrl, ip, ua, consent, newToken, token],
  );
  if (!marked.rowCount) {
    return {
      ok: false,
      statusCode: 503,
      error: 'endorsement_update_not_applied',
      endorsementId: endorsement.id,
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
  const completion = await finalizeEndorsementState(client, endorsement.check_id, {
    refreshOfficialRear: true,
    compositeDeps: deps.compositeDeps || {},
  });
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

export const runRejectEndorsement = async (client, event, body, spoof) => {
  const token = String(body.token || '').trim();
  if (!token) return { ok: false, statusCode: 400, error: 'Token required', spoofFieldsIgnored: spoof };
  const endorsement = await lookupPublicEndorsement(client, token);
  if (!endorsement) {
    return { ok: false, statusCode: 404, error: 'Invalid or already-used token', spoofFieldsIgnored: spoof };
  }
  await bindPublicWriter(client, endorsement);
  const newToken = rotateToken();
  const ip = clientIpFromEvent(event);
  const ua = userAgentFromEvent(event);
  await client.query(
    `UPDATE public.check_endorsements
     SET status = 'rejected',
         notes = $2,
         ip_address = $3,
         user_agent = $4,
         token = $5,
         token_expires_at = NULL,
         updated_at = now()
     WHERE id = $1::uuid AND token = $6`,
    [endorsement.id, body.reason || null, ip, ua, newToken, token],
  );
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
  const completion = await finalizeEndorsementState(client, endorsement.check_id, {
    refreshOfficialRear: true,
    compositeDeps: {},
  });
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
    if (write) {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION READ WRITE');
    }
    let result;
    if (action === 'get_endorsement_data') {
      result = await runGetEndorsementData(client, String(body.token || '').trim(), spoof);
    } else if (action === 'submit_endorsement') {
      result = await runSubmitEndorsement(client, event, body, spoof, deps);
    } else if (action === 'reject_endorsement') {
      result = await runRejectEndorsement(client, event, body, spoof);
    } else {
      result = { ok: false, statusCode: 400, error: 'Unknown action', spoofFieldsIgnored: spoof };
    }
    if (write) {
      if (result.ok !== false && (result.statusCode || 200) < 400) {
        await client.query('COMMIT');
      } else {
        await client.query('ROLLBACK');
      }
    }
    return result;
  } catch (error) {
    if (opened?.client && write) {
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

const sendEndorsementEmail = async ({ endorsement, check, email, url, branding, cc, send, fetchImpl }) => {
  const useResend = !send && endorsementResendEnabled();
  const mailer = send || (useResend ? sendViaResend : sendViaSesOrSink);
  const rendered = renderTransactionalTemplate('endorsement-request', {
    payeeName: endorsement.payee_name,
    checkNumber: check.check_number || 'N/A',
    carrier: check.carrier_name || 'Unknown',
    amount: check.amount,
    endorseUrl: url,
    companyName: branding.company_name || 'ChecksOps',
    branding,
    subject: branding.endorsement_email_subject || undefined,
  });
  const subjectBase = branding.endorsement_email_subject
    || `Endorsement Required — Check #${check.check_number || 'N/A'}`;
  const subject = subjectBase.includes(endorsement.payee_name)
    ? subjectBase
    : `${subjectBase} — ${endorsement.payee_name}`;
  const result = await mailer({
    to: useResend ? email : [email, ...(cc || [])].filter(Boolean),
    cc: useResend ? (cc || []).filter(Boolean) : undefined,
    subject,
    html: rendered.html,
    text: rendered.text,
    from: endorsementFromAddress(branding),
    replyTo: branding.replyTo || branding.company_email || null,
    headers: {
      'X-Entity-Ref-ID': String(endorsement.id),
      'X-Endorsement-Payee': String(endorsement.payee_name || ''),
    },
    fetchImpl,
  });
  if (!isSuccessfulEndorsementDelivery(result, { injected: Boolean(send) })) {
    throw new Error(result?.error || 'Email delivery failed');
  }
  return result;
};

export const runAuthenticatedEndorsement = async ({
  client, mapping, body, spoof, event, send, fetchImpl, compositeDeps = {},
}) => {
  const action = body.action;
  if (!AUTH_ENDORSEMENT_ACTIONS.has(action)) {
    return { ok: false, statusCode: 400, error: 'Unknown action', spoofFieldsIgnored: spoof };
  }

  if (action === 'force_complete_endorsements') {
    const checkId = body.checkId || body.check_id;
    if (!checkId) {
      return { ok: false, statusCode: 400, error: 'checkId required', spoofFieldsIgnored: spoof };
    }
    const check = await loadCheckForEndorsement(client, { check_id: checkId });
    if (!check?.id) {
      return { ok: false, statusCode: 404, error: 'Check not found', spoofFieldsIgnored: spoof };
    }
    const tenantId = check.tenant_id;
    if (!await canWriteTenant(client, tenantId)) {
      return { ok: false, statusCode: 403, error: 'forbidden', spoofFieldsIgnored: spoof };
    }
    const rows = (await safeQuery(
      client,
      `SELECT id, status, payee_type, signature_image_url, signed_at
       FROM public.check_endorsements WHERE check_id = $1::uuid`,
      [checkId],
    )).rows;
    const incompleteIds = rows
      .filter((row) => !isEndorsementSatisfied(row))
      .map((row) => row.id)
      .filter(Boolean);
    if (incompleteIds.length) {
      await client.query(
        `UPDATE public.check_endorsements
         SET status = 'signed',
             signed_at = COALESCE(signed_at, now()),
             notes = COALESCE(notes, $2),
             signature_method = COALESCE(NULLIF(signature_method, ''), 'manual'),
             updated_at = now()
         WHERE check_id = $1::uuid
           AND id = ANY($3::uuid[])
           AND status IS DISTINCT FROM 'signed'
           AND status IS DISTINCT FROM 'waived'`,
        [checkId, 'Manually marked as received by staff override', incompleteIds],
      );
    }
    await auditEndorsement(client, {
      endorsement_id: null,
      check_id: checkId,
      tenant_id: tenantId,
      event_type: 'endorsements_force_completed',
      check_event_type: 'endorsements_force_completed',
      event_description: `All endorsements manually marked as received (${incompleteIds.length} updated)`,
      event_data: { overridden_ids: incompleteIds },
      actor_id: mapping.application_user_id,
    });
    await synchronizePayeesFromEndorsements(client, checkId);
    const completion = await finalizeEndorsementState(client, checkId, {
      refreshOfficialRear: true,
      compositeDeps,
    });
    return { ok: true, statusCode: 200, success: true, ...completion, spoofFieldsIgnored: spoof };
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
    if (endorsementRateLimited(endorsement.request_sent_at)) {
      return { ok: false, statusCode: 429, error: 'Request was sent recently. Please wait before resending.', spoofFieldsIgnored: spoof };
    }
    const email = String(body.email || endorsement.contact_email || '').trim();
    const phone = String(body.phone || endorsement.contact_phone || '').trim() || null;
    if (body.email || body.phone) {
      await safeQuery(
        client,
        `UPDATE public.check_endorsements
         SET contact_email = COALESCE($2, contact_email),
             contact_phone = COALESCE($3, contact_phone),
             updated_at = now()
         WHERE id = $1::uuid`,
        [endorsement.id, email || null, phone],
      );
    }
    if (!email) {
      return { ok: false, statusCode: 502, success: false, error: 'Email delivery failed', details: { emailError: 'Missing payee email address' }, spoofFieldsIgnored: spoof };
    }
    let activeToken = endorsement.token || rotateToken();
    await client.query(
      `UPDATE public.check_endorsements
       SET token = $2, token_expires_at = NULL, updated_at = now()
       WHERE id = $1::uuid`,
      [endorsement.id, activeToken],
    );
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
    const branding = {
      company_name: resolved.companySubtitle || resolved.companyName || tenant?.email_from_name || tenant?.name || brandingRow.company_name,
      company_email: resolved.replyTo || tenant?.email_reply_to || brandingRow.company_email,
      endorsement_email_subject: brandingRow.endorsement_email_subject,
      from: resolved.from,
      usingCustomFrom: resolved.usingCustomFrom === true,
      replyTo: resolved.replyTo,
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
    let sendResult = null;
    try {
      sendResult = await sendEndorsementEmail({
        endorsement: { ...endorsement, contact_email: email },
        check,
        email,
        url: endorsementUrl,
        branding,
        cc,
        send,
        fetchImpl,
      });
      emailSent = true;
    } catch (error) {
      emailError = String(error?.message || error).slice(0, 200);
    }
    const deliveryStatus = emailSent
      ? (sendResult?.mode === 'resend' ? 'delivered' : (sendResult?.mode === 'sink' ? 'sunk' : 'delivered'))
      : 'failed';
    const persistedDeliveryStatus = emailSent
      ? (sendResult?.mode === 'sink' ? 'pending' : 'delivered')
      : 'failed';
    if (!emailSent) {
      await safeQuery(
        client,
        `INSERT INTO public.endorsement_requests (
           endorsement_id, check_id, method, sent_by, delivery_status, email_address
         ) VALUES ($1::uuid, $2::uuid, 'email', $3::uuid, 'failed', $4)`,
        [endorsement.id, endorsement.check_id, mapping.application_user_id, email],
      );
      await auditEndorsement(client, {
        endorsement_id: endorsement.id,
        check_id: endorsement.check_id,
        tenant_id: tenantId,
        event_type: 'request_failed',
        check_event_type: 'endorsement_request_failed',
        event_description: `Delivery failed: ${emailError}`,
        event_data: { emailError, delivery_status: 'failed' },
        actor_id: mapping.application_user_id,
      });
      return {
        ok: false,
        statusCode: 502,
        success: false,
        error: 'Email delivery failed',
        emailSent: false,
        delivery_status: 'failed',
        details: { emailError },
        spoofFieldsIgnored: spoof,
      };
    }
    const markedSent = await client.query(
      `UPDATE public.check_endorsements
       SET status = 'sent',
           request_sent_at = now(),
           last_reminder_at = now(),
           reminder_count = COALESCE(reminder_count, 0) + 1,
           contact_email = $2,
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING id, status, request_sent_at`,
      [endorsement.id, email],
    );
    if (!markedSent.rowCount) {
      return {
        ok: false,
        statusCode: 503,
        success: false,
        error: 'endorsement_update_not_applied',
        endorsementId: endorsement.id,
        emailSent: true,
        delivery_status: deliveryStatus,
        spoofFieldsIgnored: spoof,
      };
    }
    await safeQuery(
      client,
      `INSERT INTO public.endorsement_requests (
         endorsement_id, check_id, method, sent_by, delivery_status, email_address
       ) VALUES ($1::uuid, $2::uuid, 'email', $3::uuid, $5, $4)`,
      [endorsement.id, endorsement.check_id, mapping.application_user_id, email, persistedDeliveryStatus],
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
      delivery_status: deliveryStatus,
      emailProvider: sendResult?.provider || sendResult?.mode || (endorsementResendEnabled() ? 'resend' : 'sink'),
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
    await updatePayeeSigned(client, endorsement, {
      status: 'signed',
      token: newToken,
      image: signatureData,
      signedAt: new Date().toISOString(),
    });
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
    const completion = await finalizeEndorsementState(client, endorsement.check_id, {
      refreshOfficialRear: true,
      compositeDeps,
    });
    return { ok: true, statusCode: 200, success: true, ...completion, spoofFieldsIgnored: spoof };
  }

  if (action === 'mark_internal_signed') {
    const marked = await client.query(
      `UPDATE public.check_endorsements
       SET status = 'signed',
           signed_at = now(),
           signature_method = 'internal',
           signature_image_url = NULL,
           notes = COALESCE($2, notes),
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING id, status, signed_at`,
      [endorsement.id, body.notes || 'Internally endorsed by staff'],
    );
    if (!marked.rowCount) {
      return {
        ok: false,
        statusCode: 503,
        error: 'endorsement_update_not_applied',
        endorsementId: endorsement.id,
        spoofFieldsIgnored: spoof,
      };
    }
    await updatePayeeSigned(client, endorsement, { status: 'signed', signedAt: new Date().toISOString() });
    await auditEndorsement(client, {
      endorsement_id: endorsement.id,
      check_id: endorsement.check_id,
      tenant_id: tenantId,
      event_type: 'internal_endorsement',
      event_description: `${endorsement.payee_name} endorsed internally by staff`,
      actor_id: mapping.application_user_id,
    });
    const completion = await finalizeEndorsementState(client, endorsement.check_id, {
      refreshOfficialRear: true,
      compositeDeps,
    });
    return { ok: true, statusCode: 200, success: true, ...completion, spoofFieldsIgnored: spoof };
  }

  await client.query(
    `UPDATE public.check_endorsements
     SET status = 'waived',
         notes = COALESCE($2, notes),
         updated_at = now()
     WHERE id = $1::uuid`,
    [endorsement.id, body.notes || 'Endorsement waived by staff'],
  );
  await updatePayeeSigned(client, endorsement, {
    status: 'waived',
    signedAt: new Date().toISOString(),
  });
  await auditEndorsement(client, {
    endorsement_id: endorsement.id,
    check_id: endorsement.check_id,
    tenant_id: tenantId,
    event_type: 'endorsement_waived',
    event_description: `${endorsement.payee_name} endorsement waived`,
    actor_id: mapping.application_user_id,
  });
  const completion = await finalizeEndorsementState(client, endorsement.check_id, {
    refreshOfficialRear: true,
    compositeDeps,
  });
  return { ok: true, statusCode: 200, success: true, ...completion, spoofFieldsIgnored: spoof };
};

export const handleCheckEndorsement = async (event, deps = {}) => {
  const body = parseBody(event);
  if (PUBLIC_ENDORSEMENT_ACTIONS.has(body.action || 'get_endorsement_data')) {
    return handlePublicEndorsement(event, deps);
  }
  return withIdentityWrite(event, (ctx) => runAuthenticatedEndorsement({
    ...ctx,
    event,
    send: deps.sendViaSesOrSink || deps.send,
    fetchImpl: deps.fetchImpl || deps.fetch,
    compositeDeps: deps.compositeDeps || {},
  }), deps);
};
