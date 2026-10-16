/**
 * HomeownerOps Class A services (non-financial).
 * Public token routes + staff send/upload helpers.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { CopyObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { withIdentity, withIdentityWrite, parseBody, ignoredSpoof } from './data.mjs';
import { loadDatabaseCredentials } from './secrets.mjs';
import { buildClientConfig, buildWriteClientConfig, sanitizePublicError } from './db-health.mjs';
import { normalizePath, s3KeyFor } from './storage-paths.mjs';
import { sendViaSesOrSink } from './email.mjs';
import { renderTransactionalTemplate } from './email-templates.mjs';
import { normalizeEmail } from './email-policy.mjs';
import { emailAssetOrigin, resolveEmailBranding } from './email-branding.mjs';
import {
  loadPendingSignaturesForHomeowner,
  runHomeownerLedgerDocumentSignLink,
} from './homeowner-signing-integration.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const { Client } = pg;
const s3 = () => new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const filesBucket = () => process.env.FILES_BUCKET || '';

const publicDb = async (write = false) => {
  const credentials = await loadDatabaseCredentials();
  const config = write
    ? buildWriteClientConfig(credentials, { queryTimeoutMillis: 12000 })
    : buildClientConfig(credentials, { queryTimeoutMillis: 12000 });
  const client = new Client(config);
  await client.connect();
  return client;
};

// Per-environment allow-lists. Production matches the production API CORS AllowOrigins
// (aws/production/api-template.yaml); every other environment accepts only the staging SPA.
// A request-supplied origin outside the list is never reflected.
export const HOMEOWNER_LINK_ORIGINS = Object.freeze({
  production: Object.freeze(['https://checksops.com', 'https://www.checksops.com']),
  nonProduction: Object.freeze(['https://staging.checksops.com']),
});

// Same environment test as email-branding.mjs isProductionChecksopsEnv (emailAssetOrigin).
const isProductionChecksopsEnv = (env = process.env.CHECKSOPS_ENV) => {
  const value = String(env || '').trim().toLowerCase();
  return value === 'production' || value === 'production-prep';
};

const allowedLinkOrigin = (override) => {
  const raw = String(override || '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  const origin = parsed.origin.toLowerCase();
  const allowed = isProductionChecksopsEnv()
    ? HOMEOWNER_LINK_ORIGINS.production
    : HOMEOWNER_LINK_ORIGINS.nonProduction;
  return allowed.includes(origin) ? origin : null;
};

/**
 * Link origin: an allow-listed request origin, else the environment's canonical
 * origin (emailAssetOrigin: SIGN_BASE_URL, APP_PUBLIC_URL, VITE_APP_URL; production
 * never staging).
 */
export const appOrigin = (override) => String(
  allowedLinkOrigin(override) || emailAssetOrigin(),
).replace(/\/$/, '');

const loadLedgerTokenStaffRow = async (client, token) => {
  try {
    return (await client.query(
      `SELECT id, tenant_id, claim_id, sent_by_user_id, created_by,
              homeowner_email, homeowner_name, partner_code
       FROM public.homeowner_ledger_tokens WHERE token = $1 LIMIT 1`,
      [token],
    )).rows[0] || null;
  } catch {
    return (await client.query(
      `SELECT id, tenant_id, claim_id, created_by,
              homeowner_email, homeowner_name, partner_code
       FROM public.homeowner_ledger_tokens WHERE token = $1 LIMIT 1`,
      [token],
    )).rows[0] || null;
  }
};

const profileEmail = async (client, userId) => {
  if (!userId) return null;
  const row = (await client.query(
    `SELECT email, full_name FROM public.profiles WHERE id = $1::uuid LIMIT 1`,
    [userId],
  )).rows[0];
  return {
    email: normalizeEmail(row?.email),
    fullName: row?.full_name || null,
  };
};

export const notifyStaffOfHomeownerLedgerUpload = async ({
  client, token, uploadId, origin, homeownerNote, amountEstimate, send,
}) => {
  const meta = await loadLedgerTokenStaffRow(client, token);
  if (!meta) return { notified: false, reason: 'token_not_found' };
  const staffUserId = meta.sent_by_user_id || meta.created_by || null;
  const staff = await profileEmail(client, staffUserId);
  const to = staff?.email;
  if (!to) return { notified: false, reason: 'missing_staff_email' };

  const branding = await resolveEmailBranding(client, { tenantId: meta.tenant_id });
  const inboxUrl = `${appOrigin(origin)}/checks`;
  const rendered = renderTransactionalTemplate('homeowner-upload-alert', {
    staff_name: staff.fullName,
    homeowner_name: meta.homeowner_name,
    homeowner_email: meta.homeowner_email,
    partner_code: meta.partner_code,
    amount_estimate: amountEstimate ?? null,
    homeowner_note: homeownerNote || null,
    inbox_url: inboxUrl,
    claimId: meta.claim_id,
    branding,
  });
  const mailer = send || sendViaSesOrSink;
  await mailer({
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    from: branding.from,
    replyTo: branding.replyTo,
  });
  return { notified: true, recipient: to, uploadId: uploadId || null };
};

const nameWords = (name) => String(name || '').toLowerCase().split(/[^a-z0-9]+/);

/**
 * Same rule as SQL 82/83: the homeowner name needs at least two parts of 2+
 * letters and every one must be a whole word of the payee name. One shared
 * surname, or 'ada' inside 'adam', is not a match.
 */
export const homeownerNameMatches = (homeownerName, payeeName) => {
  const parts = nameWords(homeownerName).filter((part) => part.length >= 2);
  if (parts.length < 2) return false;
  const words = new Set(nameWords(payeeName));
  return parts.every((part) => words.has(part));
};

/**
 * An insured endorsement is this homeowner's when the contact email or the
 * full homeowner name matches, or when it is the only open insured
 * endorsement on that check (claim-scoped sole insured). An empty homeowner
 * email is never a match-all.
 */
export const isHomeownerEndorsementParty = (endorsement, homeowner = {}, ctx = {}) => {
  if (String(endorsement?.payee_type || '') !== 'insured') return false;
  const email = String(homeowner.email || '').toLowerCase().trim();
  const contactEmail = String(endorsement?.contact_email || '').toLowerCase().trim();
  const emailHit = Boolean(email) && contactEmail === email;
  const nameHit = homeownerNameMatches(homeowner.name, endorsement?.payee_name);
  if (emailHit || nameHit) return true;
  // Sole-insured fallback only when nothing contradicts it (same rule as the
  // SQL 83 mint, which also counts every insured endorsement on the check).
  const emailConflict = Boolean(email) && Boolean(contactEmail) && contactEmail !== email;
  const nameConflict = Boolean(String(endorsement?.payee_name || '').trim()) && !nameHit;
  if (emailConflict || nameConflict) return false;
  const openInsuredCount = Number(ctx.openInsuredCount);
  return Number.isInteger(openInsuredCount) && openInsuredCount === 1;
};

/** /endorse may only send the homeowner back to this ledger. */
export const safeHomeownerReturnTo = (value, ledgerToken) => {
  const token = String(ledgerToken || '').trim();
  if (!token) return null;
  const raw = String(value || '').trim();
  if (!raw) return `/h/ledger/${token}`;
  if (raw.includes('://') || raw.includes('//') || raw.includes('\\') || raw.includes('..')) {
    return null;
  }
  if (raw === `/h/ledger/${token}` || raw === `/ledger/${token}`) return raw;
  return null;
};

const publicEndorsementParty = (party = {}, homeowner = {}, ctx = {}) => {
  const payeeType = String(party?.payee_type || '');
  const email = String(homeowner.email || '').toLowerCase().trim();
  const recomputed = isHomeownerEndorsementParty({
    payee_type: payeeType,
    payee_name: party?.payee_name,
    contact_email: party?.contact_email,
  }, homeowner, ctx);
  // SQL 82 still marks every insured row is_homeowner when the token email
  // is empty. Ignore that match-all unless the homeowner email is present or
  // this check has exactly one open insured endorsement.
  const sqlSaysHomeowner = party?.is_homeowner === true && payeeType === 'insured';
  const isHomeowner = email ? Boolean(recomputed || sqlSaysHomeowner) : recomputed;
  return {
    endorsement_id: party.endorsement_id || party.id || null,
    payee_name: party.payee_name ?? null,
    payee_type: payeeType,
    status: party.status ?? null,
    sent_at: party.sent_at || party.request_sent_at || null,
    is_homeowner: isHomeowner,
    // Only a requested ('sent') insured endorsement, matching the SQL 83 allow-list.
    can_sign: Boolean(isHomeowner && payeeType === 'insured'
      && String(party.status || '').toLowerCase().trim() === 'sent'),
    // Never return a raw check_endorsements.token. The endorse doorway mints at click.
    sign_url: null,
  };
};

export const openInsuredCountFromPendingEndorsements = (pending = []) => {
  const counts = {};
  if (!Array.isArray(pending)) return counts;
  for (const check of pending) {
    const checkId = String(check?.check_id || '');
    if (!checkId) continue;
    const parties = Array.isArray(check.parties) ? check.parties : [];
    counts[checkId] = parties.filter((party) => String(party?.payee_type || '') === 'insured').length;
  }
  return counts;
};

/** Whitelists check + party fields; drops sign_url / tokens / contact emails. */
export const sanitizePendingEndorsementsForHomeowner = (
  pending = [],
  homeowner = {},
  openInsuredByCheck = openInsuredCountFromPendingEndorsements(pending),
) => {
  if (!Array.isArray(pending)) return [];
  return pending.map((check) => {
    const checkId = String(check?.check_id || '');
    const openInsuredCount = openInsuredByCheck[checkId];
    return {
      check_id: check?.check_id ?? null,
      check_number: check?.check_number ?? null,
      check_amount: check?.check_amount ?? null,
      parties: Array.isArray(check?.parties)
        ? check.parties.map((party) => publicEndorsementParty(party, homeowner, { openInsuredCount }))
        : [],
    };
  });
};

export const assembleHomeownerLedgerView = (doc, spoof, { pendingSignatures = [] } = {}) => {
  const tokenMeta = doc.token && typeof doc.token === 'object' ? doc.token : {};
  const mode = doc.mode || (tokenMeta.claim_id || doc.claim?.id ? 'claim' : 'pre_claim');
  const homeowner = doc.homeowner || {
    name: tokenMeta.homeowner_name || null,
    email: tokenMeta.homeowner_email || null,
  };
  return {
    ok: true,
    statusCode: 200,
    ...doc,
    mode,
    homeowner,
    totals: doc.totals || { received: 0, deposited: 0, released: 0, remaining: 0 },
    // Only the sanitized, claim-scoped list loaded by the Lambda (SQL 83).
    // Never pass RPC-supplied signer rows or sign URLs through.
    pending_signatures: Array.isArray(pendingSignatures) ? pendingSignatures : [],
    pending_endorsements: sanitizePendingEndorsementsForHomeowner(
      Array.isArray(doc.pending_endorsements) ? doc.pending_endorsements : [],
      homeowner,
    ),
    pending_upload_count: Number(doc.pending_upload_count || 0),
    can_upload: doc.can_upload !== false,
    allow_deductible_payment: false,
    money: null,
    deductible_payments: [],
    spoofFieldsIgnored: spoof,
  };
};

/**
 * Claim-scoped Signature Requests for this homeowner (SQL 83 reader). The
 * reader may be absent until SQL 83 is applied; a SAVEPOINT keeps that
 * failure from aborting the ledger transaction (and last_viewed_at).
 */
export const loadPendingSignaturesSafely = async (client, token, doc) => {
  const tokenMeta = doc?.token && typeof doc.token === 'object' ? doc.token : {};
  if (!tokenMeta.claim_id && doc?.mode !== 'claim') return [];
  const homeowner = doc.homeowner || {
    name: tokenMeta.homeowner_name || null,
    email: tokenMeta.homeowner_email || null,
  };
  await client.query('SAVEPOINT homeowner_pending_signatures');
  try {
    const rows = await loadPendingSignaturesForHomeowner(client, token, homeowner);
    await client.query('RELEASE SAVEPOINT homeowner_pending_signatures');
    return rows;
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT homeowner_pending_signatures');
    return [];
  }
};

export const handleHomeownerLedgerView = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const qs = event.queryStringParameters || {};
  const token = String(body.token || qs.token || '').trim();
  if (!token || token.length < 8) {
    return { ok: false, statusCode: 400, error: 'invalid_token', spoofFieldsIgnored: spoof };
  }
  let client;
  try {
    client = await publicDb(true);
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ WRITE');
    const doc = (await client.query(
      'SELECT public.aws_public_homeowner_ledger_by_token($1) AS doc',
      [token],
    )).rows[0]?.doc;
    if (!doc) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 404, error: 'not_found', spoofFieldsIgnored: spoof };
    }
    if (doc.error) {
      await client.query('ROLLBACK');
      const status = doc.error === 'revoked' || doc.error === 'expired' ? 410 : 400;
      return { ok: false, statusCode: status, error: doc.error, spoofFieldsIgnored: spoof };
    }
    const pendingSignatures = await loadPendingSignaturesSafely(client, token, doc);
    await client.query('COMMIT');
    return assembleHomeownerLedgerView(doc, spoof, { pendingSignatures });
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return {
      ok: false,
      statusCode: 503,
      error: 'ledger_view_failed',
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

export const handleHomeownerClaimPortal = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const token = String(body.token || '').trim();
  const action = body.action || 'get';
  if (!/^[a-f0-9]{32,80}$/i.test(token)) {
    return { ok: false, statusCode: 400, error: 'invalid body', spoofFieldsIgnored: spoof };
  }

  let client;
  try {
    client = await publicDb(true);
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ WRITE');
    const doc = (await client.query(
      'SELECT public.aws_public_homeowner_claim_by_token($1) AS doc',
      [token],
    )).rows[0]?.doc;
    if (!doc) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 404, error: 'invalid or expired link', spoofFieldsIgnored: spoof };
    }

    if (doc.pending) {
      if (action === 'get') {
        await client.query('COMMIT');
        return {
          ok: true,
          statusCode: 200,
          pending: true,
          lead: {
            id: doc.lead?.id,
            homeowner_name: doc.lead?.homeowner_name,
            status: doc.lead?.status,
            accepted_at: doc.lead?.accepted_at,
            created_at: doc.lead?.created_at,
          },
          contractor: doc.contractor
            ? { id: doc.contractor.id, display_name: doc.contractor.display_name, tier: doc.contractor.tier }
            : null,
          spoofFieldsIgnored: spoof,
        };
      }
      await client.query('ROLLBACK');
      return {
        ok: false,
        statusCode: 403,
        error: 'contractor has not accepted this request yet',
        spoofFieldsIgnored: spoof,
      };
    }

    if (action === 'get' || action === 'list_actions') {
      await client.query('COMMIT');
      return {
        ok: true,
        statusCode: 200,
        pending: false,
        lead: doc.lead,
        contractor: doc.contractor,
        uploads: doc.uploads || [],
        actions: action === 'list_actions' ? [] : undefined,
        allow_deductible_payment: false,
        spoofFieldsIgnored: spoof,
      };
    }

    if (action === 'upload_check') {
      const b64 = String(body.file_base64 || '');
      if (b64.length < 100) {
        await client.query('ROLLBACK');
        return { ok: false, statusCode: 400, error: 'missing_file', spoofFieldsIgnored: spoof };
      }
      const mime = String(body.file_mime || 'image/jpeg').slice(0, 120);
      const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
      if (!allowed.has(mime)) {
        await client.query('ROLLBACK');
        return { ok: false, statusCode: 400, error: 'unsupported_mime', spoofFieldsIgnored: spoof };
      }
      const clean = b64.includes(',') ? b64.split(',').pop() : b64;
      const bytes = Buffer.from(clean, 'base64');
      if (bytes.length > 15 * 1024 * 1024) {
        await client.query('ROLLBACK');
        return { ok: false, statusCode: 400, error: 'file_too_large', spoofFieldsIgnored: spoof };
      }
      const filename = String(body.filename || `homeowner-upload-${Date.now()}.jpg`).slice(0, 200);
      const rel = `homeowner/${doc.lead.id}/${Date.now()}_${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const key = s3KeyFor('homeowner-uploads', rel);
      if (!filesBucket() || !key) {
        await client.query('ROLLBACK');
        return { ok: false, statusCode: 503, error: 's3_not_configured', spoofFieldsIgnored: spoof };
      }
      await s3().send(new PutObjectCommand({
        Bucket: filesBucket(),
        Key: key,
        Body: bytes,
        ContentType: mime,
      }));
      const inserted = (await client.query(
        `INSERT INTO public.homeowner_check_uploads (lead_id, file_path, status, note, created_at)
         VALUES ($1::uuid, $2, 'uploaded', $3, now())
         RETURNING id, file_path, status, created_at`,
        [doc.lead.id, rel, body.note || null],
      )).rows[0];
      await client.query('COMMIT');
      return {
        ok: true,
        statusCode: 200,
        upload: inserted,
        spoofFieldsIgnored: spoof,
      };
    }

    if (action === 'submit_mortgage_intake' || action === 'sign_dtp' || action === 'complete_action' || action === 'sign_document') {
      // Non-financial form/sign metadata only — keep narrow.
      if (action === 'sign_dtp') {
        const name = String(body.signature_name || '').trim();
        if (name.length < 2) {
          await client.query('ROLLBACK');
          return { ok: false, statusCode: 400, error: 'missing_signature_name', spoofFieldsIgnored: spoof };
        }
        await client.query(
          `UPDATE public.homeowner_intro_requests SET
             dtp_signed_at = now(),
             dtp_signature_name = $2,
             dtp_insurance_carrier = COALESCE($3, dtp_insurance_carrier),
             dtp_claim_number = COALESCE($4, dtp_claim_number),
             dtp_policy_number = COALESCE($5, dtp_policy_number),
             dtp_property_address = COALESCE($6, dtp_property_address)
           WHERE id = $1::uuid`,
          [
            doc.lead.id,
            name,
            body.insurance_carrier || null,
            body.claim_number || null,
            body.policy_number || null,
            body.property_address || null,
          ],
        );
        await client.query('COMMIT');
        return { ok: true, statusCode: 200, signed: true, spoofFieldsIgnored: spoof };
      }
      await client.query('ROLLBACK');
      return {
        ok: false,
        statusCode: 501,
        error: 'action_not_ported',
        message: `Action ${action} is not fully ported on AWS staging yet`,
        spoofFieldsIgnored: spoof,
      };
    }

    await client.query('ROLLBACK');
    return { ok: false, statusCode: 400, error: 'unsupported_action', spoofFieldsIgnored: spoof };
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return {
      ok: false,
      statusCode: 503,
      error: 'claim_portal_failed',
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

export const handleHomeownerLedgerUpload = async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const token = String(body.token || '').trim();
  if (!token) return { ok: false, statusCode: 400, error: 'invalid_token', spoofFieldsIgnored: spoof };

  let client;
  try {
    client = deps.client || await publicDb(true);
    if (!deps.client) {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION READ WRITE');
    }
    const doc = (await client.query(
      'SELECT public.aws_public_homeowner_ledger_by_token($1) AS doc',
      [token],
    )).rows[0]?.doc;
    if (!doc?.ok || !doc.token) {
      if (!deps.client) await client.query('ROLLBACK');
      return { ok: false, statusCode: 404, error: doc?.error || 'not_found', spoofFieldsIgnored: spoof };
    }

    const frontB64 = String(body.front_base64 || body.file_base64 || '');
    if (frontB64.length < 100) {
      if (!deps.client) await client.query('ROLLBACK');
      return { ok: false, statusCode: 400, error: 'missing_file', spoofFieldsIgnored: spoof };
    }
    const clean = frontB64.includes(',') ? frontB64.split(',').pop() : frontB64;
    const bytes = Buffer.from(clean, 'base64');
    const rel = `ledger/${doc.token.claim_id || doc.token.id}/${Date.now()}_front.jpg`;
    const key = s3KeyFor('homeowner-uploads', rel);
    if (typeof deps.putObject === 'function') {
      await deps.putObject({ Bucket: filesBucket(), Key: key, Body: bytes, ContentType: 'image/jpeg' });
    } else {
      await s3().send(new PutObjectCommand({
        Bucket: filesBucket(),
        Key: key,
        Body: bytes,
        ContentType: 'image/jpeg',
      }));
    }
    const row = (await client.query(
      `INSERT INTO public.homeowner_ledger_check_uploads (
         tenant_id, claim_id, front_path, status, created_at
       ) VALUES ($1::uuid, $2::uuid, $3, 'uploaded', now())
       RETURNING id, front_path, status, created_at`,
      [doc.token.tenant_id, doc.token.claim_id, rel],
    )).rows[0];
    if (!deps.client) await client.query('COMMIT');
    let notified = false;
    try {
      const notify = await notifyStaffOfHomeownerLedgerUpload({
        client,
        token,
        uploadId: row?.id,
        origin: body.origin,
        homeownerNote: body.homeowner_note,
        amountEstimate: body.amount_estimate,
        send: deps.sendViaSesOrSink,
      });
      notified = notify.notified === true;
    } catch {
      notified = false;
    }
    return { ok: true, statusCode: 200, upload: row, notified, spoofFieldsIgnored: spoof };
  } catch (error) {
    if (client && !deps.client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return {
      ok: false,
      statusCode: 503,
      error: 'ledger_upload_failed',
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (client && !deps.client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

const signLinkStatus = (error) => {
  if (error === 'revoked' || error === 'expired') return 410;
  if (error === 'already_signed') return 409;
  if (error === 'mismatch' || error === 'not_your_signature' || error === 'invalid_state') return 403;
  if (error === 'invalid_hash' || error === 'missing_fields') return 400;
  if (error === 'signer_not_found' || error === 'not_found' || error === 'no_claim') return 404;
  return 403;
};

const mapHomeownerCapabilityError = (error, spoof) => {
  const code = String(error || 'not_found');
  const statusCode = code === 'existing_email_link_required' ? 409 : signLinkStatus(code);
  return { ok: false, statusCode, error: code, spoofFieldsIgnored: spoof };
};

/**
 * Review & Sign Check doorway. SQL 83 re-checks the ledger token, exact
 * tenant + claim, insured payee, open status and homeowner identity (or
 * sole open insured), then returns that endorsement's /endorse token. The
 * token is only ever returned here, never in the ledger view.
 */
export const runHomeownerLedgerEndorseLink = async ({ client, token, endorsementId, spoof }) => {
  const ledgerToken = String(token || '').trim();
  const id = String(endorsementId || '').trim();
  if (!ledgerToken || ledgerToken.length < 8 || !id) {
    return { ok: false, statusCode: 400, error: 'missing_fields', spoofFieldsIgnored: spoof };
  }
  if (!UUID_RE.test(id)) {
    return { ok: false, statusCode: 404, error: 'not_found', spoofFieldsIgnored: spoof };
  }

  const cap = (await client.query(
    'SELECT public.aws_public_homeowner_ledger_endorse_capability($1, $2::uuid) AS doc',
    [ledgerToken, id],
  )).rows[0]?.doc;
  if (!cap || cap.error || cap.ok !== true) {
    return mapHomeownerCapabilityError(cap?.error || 'not_found', spoof);
  }

  const endorseToken = String(cap.endorse_token || '').trim();
  const returnTo = safeHomeownerReturnTo(`/h/ledger/${ledgerToken}`, ledgerToken);
  if (!endorseToken || !returnTo) {
    return { ok: false, statusCode: 404, error: 'not_found', spoofFieldsIgnored: spoof };
  }
  return {
    ok: true,
    statusCode: 200,
    sign_url: `/endorse?token=${encodeURIComponent(endorseToken)}&return_to=${encodeURIComponent(returnTo)}`,
    endorsement_id: cap.endorsement_id || id,
    check_id: cap.check_id || null,
    return_to: returnTo,
    spoofFieldsIgnored: spoof,
  };
};

const runPublicTokenTransaction = async (spoof, failure, run) => {
  let client;
  try {
    client = await publicDb(true);
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ WRITE');
    const result = await run(client);
    await client.query(result.ok ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return {
      ok: false,
      statusCode: 503,
      error: failure,
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

export const handleHomeownerLedgerEndorseLink = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const token = String(body.token || '').trim();
  const endorsementId = body.endorsement_id || body.endorsementId;
  if (!token || token.length < 8 || !endorsementId) {
    return { ok: false, statusCode: 400, error: 'missing_fields', spoofFieldsIgnored: spoof };
  }
  return runPublicTokenTransaction(spoof, 'endorse_link_failed', (client) => (
    runHomeownerLedgerEndorseLink({ client, token, endorsementId, spoof })
  ));
};

/**
 * Review & Sign Document doorway (SQL 83). Reuses the signer's existing
 * /sign capability only; never rotates token_hash and never calls the
 * legacy remint RPC.
 */
export const handleHomeownerLedgerDocumentSignLink = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const token = String(body.token || '').trim();
  const signerId = body.signer_id || body.signature_signer_id;
  if (!token || token.length < 8 || !signerId) {
    return { ok: false, statusCode: 400, error: 'missing_fields', spoofFieldsIgnored: spoof };
  }
  return runPublicTokenTransaction(spoof, 'document_sign_link_failed', (client) => (
    runHomeownerLedgerDocumentSignLink({ client, token, signerId, spoof })
  ));
};

/**
 * Retired. The legacy Homeowner sign-link reminted a signer through
 * aws_public_homeowner_ledger_remint_signer, which is not token + claim +
 * homeowner scoped, and echoed a caller-supplied `origin` into the link.
 * The route stays registered so old SPA builds get a clean refusal; it
 * never touches the database. Use homeowner-ledger-document-sign-link.
 */
export const handleHomeownerLedgerSignLink = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  return {
    ok: false,
    statusCode: 410,
    error: 'sign_link_retired',
    message: 'Use homeowner-ledger-document-sign-link.',
    spoofFieldsIgnored: spoof,
  };
};

export const runHomeownerLedgerSend = async ({
  client, mapping, body, spoof, send,
}) => {
  const homeownerEmail = normalizeEmail(body.homeowner_email);
  const homeownerPhone = body.homeowner_phone || null;
  if (!homeownerEmail && !homeownerPhone) {
    return { ok: false, statusCode: 400, error: 'missing_contact', spoofFieldsIgnored: spoof };
  }
  let tenantId = body.tenant_id || null;
  const claimId = body.claim_id || null;
  // claim_id null = pre-claim homeowner upload link (/start-claim); otherwise one claim's tracking link.
  if (claimId && !UUID_RE.test(String(claimId))) {
    return { ok: false, statusCode: 400, error: 'invalid_claim_id', spoofFieldsIgnored: spoof };
  }
  if (tenantId && !UUID_RE.test(String(tenantId))) {
    return { ok: false, statusCode: 400, error: 'invalid_tenant_id', spoofFieldsIgnored: spoof };
  }
  if (claimId && !tenantId) {
    const row = (await client.query(
      `SELECT tenant_id FROM public.check_intake_items
       WHERE claim_id = $1::uuid AND tenant_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [claimId],
    )).rows[0];
    tenantId = row?.tenant_id || null;
  }
  if (!tenantId) {
    const row = (await client.query(
      `SELECT tenant_id FROM public.tenant_users WHERE user_id = $1::uuid LIMIT 1`,
      [mapping.application_user_id],
    )).rows[0];
    tenantId = row?.tenant_id || null;
  }
  if (!tenantId) return { ok: false, statusCode: 400, error: 'no_tenant', spoofFieldsIgnored: spoof };

  const member = (await client.query(
    `SELECT 1 FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    [mapping.application_user_id, tenantId],
  )).rows[0];
  if (!member) return { ok: false, statusCode: 403, error: 'cross_tenant_denied', spoofFieldsIgnored: spoof };

  // Owner policy: every member of the tenant is a user with the same rights; partners and other tenants do not act. (the membership above is the whole gate).

  // The claim must belong to this tenant (its org, or one of this tenant's checks).
  const claimOwned = !claimId || (await client.query(
    `SELECT 1 FROM public.claims c
     WHERE c.id = $1::uuid
       AND (c.org_id = $2::uuid
         OR (c.org_id IS NULL AND EXISTS (SELECT 1 FROM public.check_intake_items ci
                    WHERE ci.claim_id = c.id AND ci.tenant_id = $2::uuid)))
     LIMIT 1`,
    [claimId, tenantId],
  )).rows[0];
  if (!claimOwned) return { ok: false, statusCode: 403, error: 'claim_not_in_tenant', spoofFieldsIgnored: spoof };

  // A ledger token is one recipient's capability (the signing doorways trust
  // its homeowner_email/name). Reuse only this recipient's own live token on
  // the same tenant + claim; a co-insured or a new address gets a new token.
  const homeownerName = String(body.homeowner_name || '').trim() || null;
  let tokenRow = null;
  if (!body.rotate) {
    tokenRow = (await client.query(
      `SELECT id, token FROM public.homeowner_ledger_tokens
       WHERE tenant_id = $1::uuid
         AND claim_id IS NOT DISTINCT FROM $2::uuid
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())
         AND lower(trim(COALESCE(homeowner_email, ''))) = lower(trim(COALESCE($3::text, '')))
         AND (
           $4::text IS NULL
           OR NULLIF(trim(COALESCE(homeowner_name, '')), '') IS NULL
           OR lower(trim(homeowner_name)) = lower(trim($4::text))
         )
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, claimId, homeownerEmail || null, homeownerName],
    )).rows[0];
  }
  if (!tokenRow) {
    const token = randomBytes(24).toString('hex');
    const insertWithSentBy = async () => client.query(
      `INSERT INTO public.homeowner_ledger_tokens (
         tenant_id, claim_id, token, homeowner_email, homeowner_name, created_by, sent_by_user_id, created_at
       ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $6::uuid, now())
       RETURNING id, token`,
      [tenantId, claimId, token, homeownerEmail || null, homeownerName, mapping.application_user_id],
    );
    const insertWithoutSentBy = async () => client.query(
      `INSERT INTO public.homeowner_ledger_tokens (
         tenant_id, claim_id, token, homeowner_email, homeowner_name, created_by, created_at
       ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, now())
       RETURNING id, token`,
      [tenantId, claimId, token, homeownerEmail || null, homeownerName, mapping.application_user_id],
    );
    try {
      tokenRow = (await insertWithSentBy()).rows[0];
    } catch {
      tokenRow = (await insertWithoutSentBy()).rows[0];
    }
  } else {
    try {
      await client.query(
        `UPDATE public.homeowner_ledger_tokens
         SET sent_by_user_id = $2::uuid,
             homeowner_email = COALESCE(NULLIF(trim(COALESCE(homeowner_email, '')), ''), $3),
             homeowner_name = COALESCE(NULLIF(trim(COALESCE(homeowner_name, '')), ''), $4)
         WHERE id = $1::uuid`,
        [tokenRow.id, mapping.application_user_id, homeownerEmail || null, homeownerName],
      );
    } catch {
      /* sent_by_user_id may be absent on older staging dumps */
    }
  }

  const origin = appOrigin(body.origin);
  const url = `${origin}/h/ledger/${tokenRow.token}`;
  if (homeownerEmail) {
    const branding = await resolveEmailBranding(client, {
      tenantId,
      senderOverride: 'checksops',
    });
    const rendered = renderTransactionalTemplate('homeowner-ledger-invite', {
      homeownerName: body.homeowner_name,
      ledgerUrl: url,
      is_pre_claim: body.is_pre_claim === true,
      branding,
    });
    const mailer = send || sendViaSesOrSink;
    await mailer({
      to: homeownerEmail,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      from: branding.from,
      replyTo: branding.replyTo,
    });
  }

  return {
    ok: true,
    statusCode: 200,
    token: tokenRow.token,
    url,
    partner_code: body.partner_code || null,
    spoofFieldsIgnored: spoof,
  };
};

export const handleHomeownerLedgerSend = (event, deps = {}) => withIdentity(event, (ctx) => (
  runHomeownerLedgerSend({ ...ctx, send: deps.sendViaSesOrSink })
), { write: true, commit: true, ...deps });

export const runSendFileToHomeowner = async ({
  client, mapping, body, spoof, send,
}) => {
  const checkFileId = body.check_file_id;
  if (!checkFileId) return { ok: false, statusCode: 400, error: 'missing_check_file_id', spoofFieldsIgnored: spoof };
  const file = (await client.query(
    `SELECT id, check_id, tenant_id, file_path, file_name
     FROM public.check_files WHERE id = $1::uuid LIMIT 1`,
    [checkFileId],
  )).rows[0];
  if (!file) return { ok: false, statusCode: 404, error: 'not_found', spoofFieldsIgnored: spoof };
  const member = (await client.query(
    `SELECT 1 FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    [mapping.application_user_id, file.tenant_id],
  )).rows[0];
  if (!member) return { ok: false, statusCode: 403, error: 'cross_tenant_denied', spoofFieldsIgnored: spoof };

  // Owner policy: every member of the tenant is a user with the same rights; partners and other tenants do not act. (the membership above is the whole gate).

  const claim = (await client.query(
    `SELECT claim_id FROM public.check_intake_items WHERE id = $1::uuid LIMIT 1`,
    [file.check_id],
  )).rows[0];
  const claimId = claim?.claim_id || null;
  // Only this claim's homeowner: never the tenant's newest token for another claim.
  const tok = claimId ? (await client.query(
    `SELECT token, homeowner_email, homeowner_name
     FROM public.homeowner_ledger_tokens
     WHERE tenant_id = $1::uuid
       AND claim_id = $2::uuid
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())
     ORDER BY created_at DESC LIMIT 1`,
    [file.tenant_id, claimId],
  )).rows[0] : null;
  const homeownerEmail = normalizeEmail(tok?.homeowner_email);
  if (!homeownerEmail) {
    return {
      ok: false,
      statusCode: 400,
      error: 'missing_recipient',
      reason: 'no_homeowner_link',
      message: 'Send the homeowner their portal link first.',
      spoofFieldsIgnored: spoof,
    };
  }

  if (claimId) {
    await client.query(
      `INSERT INTO public.homeowner_ledger_events (
         tenant_id, claim_id, check_id, event_type, occurred_at, actor_label, payload_json, created_by, amount
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'document_shared', now(), 'Document shared', $4::jsonb, $5::uuid, NULL)`,
      [
        file.tenant_id,
        claimId,
        file.check_id,
        JSON.stringify({ file_name: file.file_name, note: body.note || null }),
        mapping.application_user_id,
      ],
    );
  }

  const origin = appOrigin(body.origin);
  const portalUrl = `${origin}/h/ledger/${tok.token}`;
  const branding = await resolveEmailBranding(client, {
    tenantId: file.tenant_id,
    senderOverride: 'checksops',
  });
  const rendered = renderTransactionalTemplate('homeowner-document-shared', {
    homeowner_name: tok.homeowner_name,
    portal_url: portalUrl,
    url: portalUrl,
    document_name: file.file_name,
    note: body.note || null,
    branding,
  });
  const mailer = send || sendViaSesOrSink;
  await mailer({
    to: homeownerEmail,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    from: branding.from,
    replyTo: branding.replyTo,
  });

  return {
    ok: true,
    statusCode: 200,
    shared: true,
    emailed: true,
    portal_url: portalUrl,
    spoofFieldsIgnored: spoof,
  };
};

export const handleSendFileToHomeowner = (event, deps = {}) => withIdentity(event, (ctx) => (
  runSendFileToHomeowner({ ...ctx, send: deps.sendViaSesOrSink })
), { write: true, commit: true, ...deps });

export const runSendPortalInvite = async ({
  mapping, body, spoof, client, send,
}) => {
  const email = normalizeEmail(body.email);
  if (!email) return { ok: false, statusCode: 400, error: 'missing_email', spoofFieldsIgnored: spoof };
  const origin = appOrigin(body.appUrl || body.origin);
  const loginUrl = /\/(portal|login)(\/|$)/i.test(origin) ? origin : `${origin}/login`;
  const branding = await resolveEmailBranding(client, {
    tenantId: body.tenant_id || body.tenantId || null,
    senderOverride: body.senderOverride || body.sender_override || null,
  });
  const rendered = renderTransactionalTemplate('portal-invite', {
    tenantName: body.tenantName,
    userName: body.userName,
    userType: body.userType,
    loginUrl,
    branding,
  });
  const mailer = send || sendViaSesOrSink;
  const sendResult = await mailer({
    to: email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    from: branding.from,
    replyTo: branding.replyTo,
  });
  await client.query(
    `INSERT INTO public.email_send_log (
       id, template_name, recipient_email, status, provider, provider_message_id, metadata, created_at
     ) VALUES ($1::uuid, 'send-portal-invite', $2, $3, 'aws_staging', $4, $5::jsonb, now())`,
    [
      randomUUID(),
      email,
      sendResult.results?.[0]?.delivery === 'ses' ? 'sent' : 'sunk',
      sendResult.results?.[0]?.messageId || null,
      JSON.stringify({ application_user_id: mapping.application_user_id, userType: body.userType || null }),
    ],
  ).catch(() => {});
  return {
    ok: true,
    statusCode: 200,
    success: true,
    stagingMode: sendResult.mode,
    spoofFieldsIgnored: spoof,
  };
};

export const handleSendPortalInvite = (event, deps = {}) => withIdentity(event, (ctx) => (
  runSendPortalInvite({ ...ctx, send: deps.sendViaSesOrSink })
), { write: true, commit: true, ...deps });

export const handleHomeownerUploadCheck = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const contractorProfileId = body.contractor_profile_id;
  const fileB64 = String(body.file_base64 || '');
  if (!contractorProfileId || fileB64.length < 100) {
    return { ok: false, statusCode: 400, error: 'invalid body', spoofFieldsIgnored: spoof };
  }
  const mime = String(body.file_mime || 'image/jpeg').slice(0, 60);
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']);
  if (!allowed.has(mime)) {
    return { ok: false, statusCode: 400, error: 'unsupported file type', spoofFieldsIgnored: spoof };
  }

  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
  const uploadToken = String(
    body.upload_token
    || body.uploadToken
    || event.headers?.['x-homeowner-upload-token']
    || event.headers?.['X-Homeowner-Upload-Token']
    || '',
  ).trim() || (/^[a-f0-9]{64}$/i.test(bearer) ? bearer : '');

  // Purpose-scoped AWS upload session (replaces Supabase Auth on /h/upload).
  if (uploadToken) {
    let client;
    try {
      const { resolveHomeownerUploadToken } = await import('./homeowner-otp.mjs');
      client = await publicDb(true);
      await client.query('BEGIN');
      await client.query('SET TRANSACTION READ WRITE');
      const session = await resolveHomeownerUploadToken(client, uploadToken);
      if (!session) {
        await client.query('ROLLBACK');
        return { ok: false, statusCode: 401, error: 'invalid session', spoofFieldsIgnored: spoof };
      }
      const result = await insertHomeownerCheckUpload(client, {
        body: {
          ...body,
          lead_id: body.lead_id || session.lead_id,
          contractor_profile_id: contractorProfileId || session.contractor_profile_id,
        },
        homeownerEmail: normalizeEmail(session.email),
        homeownerUserId: null,
        spoof,
        verifiedLead: session.lead
          ? {
            id: session.lead.id,
            homeowner_email: session.lead.homeowner_email || session.email,
            contractor_profile_id: session.lead.contractor_profile_id || session.contractor_profile_id,
          }
          : (session.lead_id ? {
            id: session.lead_id,
            homeowner_email: session.email,
            contractor_profile_id: session.contractor_profile_id,
          } : null),
      });
      if (result.ok) await client.query('COMMIT');
      else await client.query('ROLLBACK');
      return result;
    } catch (error) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      }
      return {
        ok: false,
        statusCode: 503,
        error: 'upload failed',
        message: sanitizePublicError(error),
        spoofFieldsIgnored: spoof,
      };
    } finally {
      if (client) {
        try { await client.end(); } catch { /* ignore */ }
      }
    }
  }

  // Prefer Cognito-mapped identity email when present; otherwise require lead access token + email.
  let homeownerEmail = normalizeEmail(body.homeowner_email || body.email);
  let homeownerUserId = null;
  const hasBearer = Boolean(bearer) && bearer.includes('.');

  let client;
  try {
    if (hasBearer) {
      return withIdentity(event, async ({ client: c, mapping, body: b, spoof: s }) => {
        homeownerEmail = normalizeEmail(mapping.email || b.homeowner_email || b.email);
        homeownerUserId = mapping.application_user_id;
        if (!homeownerEmail) {
          return { ok: false, statusCode: 401, error: 'invalid session', spoofFieldsIgnored: s };
        }
        return insertHomeownerCheckUpload(c, {
          body: b,
          homeownerEmail,
          homeownerUserId,
          spoof: s,
        });
      }, { write: true, commit: true });
    }

    // Public staging path: lead access_token proves ownership of the lead email.
    const leadToken = String(body.access_token || body.lead_access_token || '').trim();
    if (!leadToken || !homeownerEmail) {
      return {
        ok: false,
        statusCode: 401,
        error: 'unauthenticated',
        message: 'Upload session token, Cognito session, or lead access_token + homeowner_email required',
        spoofFieldsIgnored: spoof,
      };
    }

    client = await publicDb(true);
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ WRITE');
    const leadDoc = (await client.query(
      'SELECT public.aws_public_homeowner_claim_by_token($1) AS doc',
      [leadToken],
    )).rows[0]?.doc;
    if (!leadDoc?.ok || !leadDoc.lead) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 404, error: 'lead not found', spoofFieldsIgnored: spoof };
    }
    const leadEmail = normalizeEmail(leadDoc.lead.homeowner_email);
    if (leadEmail !== homeownerEmail) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 403, error: 'lead does not match this session', spoofFieldsIgnored: spoof };
    }
    if (body.lead_id && String(body.lead_id) !== String(leadDoc.lead.id)) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 403, error: 'lead does not match this session', spoofFieldsIgnored: spoof };
    }
    const result = await insertHomeownerCheckUpload(client, {
      body: { ...body, lead_id: body.lead_id || leadDoc.lead.id },
      homeownerEmail,
      homeownerUserId: null,
      spoof,
      verifiedLead: {
        id: leadDoc.lead.id,
        homeowner_email: leadDoc.lead.homeowner_email,
        contractor_profile_id: leadDoc.lead.contractor_profile_id || body.contractor_profile_id,
      },
    });
    if (result.ok) await client.query('COMMIT');
    else await client.query('ROLLBACK');
    return result;
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return {
      ok: false,
      statusCode: 503,
      error: 'upload failed',
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

const insertHomeownerCheckUpload = async (client, {
  body, homeownerEmail, homeownerUserId, spoof, verifiedLead = null,
}) => {
  const profile = (await client.query(
    `SELECT id, user_id, is_directory_listed, directory_opt_in, display_name
     FROM public.contractor_profiles WHERE id = $1::uuid LIMIT 1`,
    [body.contractor_profile_id],
  )).rows[0];
  if (!profile || !profile.is_directory_listed || !profile.directory_opt_in) {
    return { ok: false, statusCode: 403, error: 'contractor not accepting uploads', spoofFieldsIgnored: spoof };
  }

  if (body.lead_id) {
    const lead = verifiedLead || (await client.query(
      `SELECT id, homeowner_email, contractor_profile_id
       FROM public.homeowner_intro_requests WHERE id = $1::uuid LIMIT 1`,
      [body.lead_id],
    )).rows[0];
    if (
      !lead
      || String(lead.contractor_profile_id) !== String(profile.id)
      || normalizeEmail(lead.homeowner_email) !== homeownerEmail
    ) {
      return { ok: false, statusCode: 403, error: 'lead does not match this session', spoofFieldsIgnored: spoof };
    }
  }

  const clean = String(body.file_base64).includes(',')
    ? String(body.file_base64).split(',').pop()
    : String(body.file_base64);
  const bytes = Buffer.from(clean, 'base64');
  if (bytes.length > 15 * 1024 * 1024) {
    return { ok: false, statusCode: 400, error: 'file too large (15 MB max)', spoofFieldsIgnored: spoof };
  }
  const mime = String(body.file_mime || 'image/jpeg').slice(0, 60);
  const ext = String(body.filename || 'upload.jpg').split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  const rel = `homeowner-uploads/${profile.user_id}/${body.lead_id || 'nolead'}/${randomUUID()}.${ext}`;
  const key = s3KeyFor('homeowner-uploads', rel);
  if (!filesBucket() || !key) {
    return { ok: false, statusCode: 503, error: 's3_not_configured', spoofFieldsIgnored: spoof };
  }
  await s3().send(new PutObjectCommand({
    Bucket: filesBucket(),
    Key: key,
    Body: bytes,
    ContentType: mime,
  }));

  const row = (await client.query(
    `SELECT public.aws_public_homeowner_check_upload_insert(
       $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, $8
     ) AS doc`,
    [
      body.lead_id || null,
      profile.id,
      profile.user_id,
      homeownerEmail,
      homeownerUserId,
      rel,
      mime,
      body.note || null,
    ],
  )).rows[0]?.doc;
  if (!row?.ok || !row.id) {
    return {
      ok: false,
      statusCode: 500,
      error: 'db insert failed',
      detail: row?.error || null,
      spoofFieldsIgnored: spoof,
    };
  }

  return { ok: true, statusCode: 200, id: row.id, spoofFieldsIgnored: spoof };
};

export const handleGetCheckImageUrls = async (event) => withIdentity(event, async ({
  client, body, spoof,
}) => {
  const checkId = body.checkId || body.check_id;
  if (!checkId) return { ok: false, statusCode: 400, error: 'missing_check_id', spoofFieldsIgnored: spoof };
  const row = (await client.query(
    `SELECT id, front_image_path, back_image_path
     FROM public.check_intake_items WHERE id = $1::uuid LIMIT 1`,
    [checkId],
  )).rows[0];
  if (!row) return { ok: false, statusCode: 404, error: 'not_found', spoofFieldsIgnored: spoof };

  const sign = async (path) => {
    if (!path) return null;
    const rel = normalizePath(path, 'claim-files');
    const key = s3KeyFor('claim-files', rel);
    if (!key || !filesBucket()) return null;
    try {
      return await getSignedUrl(
        s3(),
        new GetObjectCommand({ Bucket: filesBucket(), Key: key }),
        { expiresIn: 300 },
      );
    } catch {
      return null;
    }
  };

  const frontUrl = await sign(row.front_image_path);
  const backUrl = await sign(row.back_image_path);
  return {
    ok: true,
    statusCode: 200,
    checkId: row.id,
    check_id: row.id,
    frontUrl,
    backUrl,
    front_url: frontUrl,
    back_url: backUrl,
    spoofFieldsIgnored: spoof,
  };
});

export const handlePublicContractorDirectory = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const action = body.action || 'search';
  let client;
  try {
    client = await publicDb(false);
    if (action === 'get' && body.id) {
      const row = (await client.query(
        `SELECT id, display_name, bio, tier, is_directory_listed, directory_opt_in
         FROM public.contractor_profiles
         WHERE id = $1::uuid AND COALESCE(is_directory_listed, false) = true
         LIMIT 1`,
        [body.id],
      )).rows[0];
      return { ok: true, statusCode: 200, contractor: row || null, spoofFieldsIgnored: spoof };
    }
    const q = String(body.q || body.query || '').trim();
    const rows = (await client.query(
      `SELECT id, display_name, bio, tier
       FROM public.contractor_profiles
       WHERE COALESCE(is_directory_listed, false) = true
         AND COALESCE(directory_opt_in, false) = true
         AND ($1 = '' OR display_name ILIKE '%' || $1 || '%')
       ORDER BY display_name ASC
       LIMIT 50`,
      [q],
    )).rows;
    return { ok: true, statusCode: 200, contractors: rows, spoofFieldsIgnored: spoof };
  } catch (error) {
    return {
      ok: false,
      statusCode: 503,
      error: 'directory_failed',
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

export const handleLookupPartnerCodePublic = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const code = String(body.code || body.partner_code || '').trim();
  if (!code) return { ok: false, statusCode: 400, error: 'missing_code', spoofFieldsIgnored: spoof };
  let client;
  try {
    client = await publicDb(false);
    const row = (await client.query(
      `SELECT public.lookup_tenant_by_partner_code($1) AS tenant`,
      [code],
    )).rows[0];
    return { ok: true, statusCode: 200, tenant: row?.tenant || null, spoofFieldsIgnored: spoof };
  } catch (error) {
    return {
      ok: false,
      statusCode: 503,
      error: 'lookup_failed',
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

const copyHomeownerUploadToClaimFiles = async (tenantId, claimId, srcPath) => {
  const srcRel = normalizePath(srcPath, 'homeowner-uploads') || String(srcPath || '').replace(/^\/+/, '');
  const filename = srcRel.split('/').pop() || 'check';
  const destRel = `${tenantId}/${claimId}/homeowner-checks/${Date.now()}-${filename}`;
  const fromKey = s3KeyFor('homeowner-uploads', srcRel);
  const toKey = s3KeyFor('claim-files', destRel);
  if (!fromKey || !toKey || !filesBucket()) {
    throw new Error('s3_not_configured');
  }
  await s3().send(new CopyObjectCommand({
    Bucket: filesBucket(),
    CopySource: encodeURI(`${filesBucket()}/${fromKey}`),
    Key: toKey,
  }));
  return destRel;
};

/**
 * Staff attach of a homeowner ledger upload onto a claim/check.
 * Ignores browser-supplied amount; uses homeowner_ledger_check_uploads.amount_estimate.
 * Does not execute deposits.
 */
export const handleHomeownerLedgerAttachUpload = async (event) => withIdentityWrite(event, async ({
  client, mapping, body, spoof,
}) => {
  const uploadId = body.upload_id || body.uploadId;
  const claimId = body.claim_id || body.claimId || null;
  if (!uploadId) {
    return { ok: false, statusCode: 400, error: 'missing_params', spoofFieldsIgnored: spoof };
  }

  const up = (await client.query(
    `SELECT * FROM public.homeowner_ledger_check_uploads WHERE id = $1::uuid LIMIT 1`,
    [uploadId],
  )).rows[0];
  if (!up) return { ok: false, statusCode: 404, error: 'upload_not_found', spoofFieldsIgnored: spoof };
  if (up.status === 'attached') {
    return {
      ok: false,
      statusCode: 409,
      error: 'already_attached',
      check_id: up.attached_check_id,
      spoofFieldsIgnored: spoof,
    };
  }

  let claimNumber = null;
  if (claimId) {
    const claim = (await client.query(
      `SELECT id, org_id AS tenant_id, claim_number FROM public.claims WHERE id = $1::uuid LIMIT 1`,
      [claimId],
    )).rows[0];
    if (!claim) return { ok: false, statusCode: 404, error: 'claim_not_found', spoofFieldsIgnored: spoof };
    if (String(claim.tenant_id) !== String(up.tenant_id)) {
      return { ok: false, statusCode: 403, error: 'tenant_mismatch', spoofFieldsIgnored: spoof };
    }
    claimNumber = claim.claim_number;
  }

  const membership = (await client.query(
    `SELECT user_id FROM public.tenant_users
     WHERE user_id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    [mapping.application_user_id, up.tenant_id],
  )).rows[0];
  if (!membership) return { ok: false, statusCode: 403, error: 'forbidden', spoofFieldsIgnored: spoof };

  const amount = up.amount_estimate ?? null;
  const copied = await copyHomeownerUploadToClaimFiles(
    up.tenant_id,
    claimId || 'unlinked',
    up.front_path,
  );
  const backCopied = up.back_path
    ? await copyHomeownerUploadToClaimFiles(up.tenant_id, claimId || 'unlinked', up.back_path)
    : null;

  const check = (await client.query(
    `INSERT INTO public.check_intake_items (
       claim_id, tenant_id, uploaded_by, front_image_path, back_image_path,
       amount, status, check_stage, check_source
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 'pending', 'review', 'insurance')
     RETURNING id`,
    [claimId, up.tenant_id, mapping.application_user_id, copied, backCopied, amount],
  )).rows[0];

  await client.query(
    `UPDATE public.homeowner_ledger_check_uploads
     SET status = 'attached',
         attached_check_id = $2::uuid,
         claim_id = $3::uuid,
         reviewed_by = $4::uuid,
         reviewed_at = now()
     WHERE id = $1::uuid`,
    [uploadId, check.id, claimId, mapping.application_user_id],
  );

  if (up.token_id && claimId) {
    await client.query(
      `UPDATE public.homeowner_ledger_tokens
       SET claim_id = $2::uuid
       WHERE id = $1::uuid AND claim_id IS NULL`,
      [up.token_id, claimId],
    );
  }

  await client.query(
    `INSERT INTO public.homeowner_ledger_events (
       tenant_id, claim_id, event_type, amount, actor_label, payload_json
     ) VALUES ($1::uuid, $2::uuid, 'homeowner_upload_attached', $3, 'Staff', $4::jsonb)`,
    [
      up.tenant_id,
      claimId,
      amount,
      JSON.stringify({ upload_id: uploadId, check_id: check.id, claim_number: claimNumber }),
    ],
  );

  return {
    ok: true,
    statusCode: 200,
    check_id: check.id,
    claim_id: claimId,
    amount_source: 'homeowner_ledger_check_uploads.amount_estimate',
    clientAmountIgnored: Object.prototype.hasOwnProperty.call(body, 'amount'),
    spoofFieldsIgnored: spoof,
  };
});
