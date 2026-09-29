/**
 * AWS Class A replacement for supabase/functions/ingest-shared-check.
 * Authenticates via x-bridge-secret (not Cognito). Copies partner images to S3.
 * Amount is taken only from the bridge-authenticated partner payload.
 * Does not execute deposits or disbursements.
 */
import pg from 'pg';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { parseBody, ignoredSpoof } from './data.mjs';
import { loadDatabaseCredentials } from './secrets.mjs';
import { buildWriteClientConfig, sanitizePublicError } from './db-health.mjs';
import { s3KeyFor } from './storage-paths.mjs';
import { safeEqual, header } from './providers/hmac.mjs';

const { Client } = pg;
const s3 = () => new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const filesBucket = () => process.env.FILES_BUCKET || '';

export const NATIVE_TENANT_MAP = Object.freeze({
  DF9CC985: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
});

const STANDARD_CAPS_ACRONYMS = new Set([
  'LLC', 'INC', 'LP', 'LLP', 'PA', 'PC', 'CO', 'CORP', 'NA', 'USA',
  'II', 'III', 'IV', 'DBA', 'LTD', 'PO', 'JR', 'SR', 'US', 'ATM',
  'AC', 'HVAC', 'TV', 'PLLC', 'PLC', 'FSB',
]);

export const toStandardCaps = (input) => {
  if (input == null) return input;
  const s = String(input);
  if (!s.trim()) return input;
  return s.replace(/[A-Za-z][A-Za-z'’]*/g, (word) => {
    const upper = word.toUpperCase();
    if (STANDARD_CAPS_ACRONYMS.has(upper)) return upper;
    if (word.length === 1) return upper;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
};

export const humanizeStatus = (key) => String(key || '')
  .replace(/_/g, ' ')
  .replace(/\b\w/g, (char) => char.toUpperCase());

export const resolveSignedAt = (payee) => payee?.endorsed_at ?? payee?.signed_at ?? null;

export const normalizePayeeStatus = (status, signedAt) => {
  if (signedAt) return 'signed';
  const value = String(status || '').toLowerCase().trim();
  if (!value) return 'pending';
  if (['signed', 'endorsed', 'complete', 'completed', 'waived', 'manual_required'].includes(value)) return 'signed';
  if (['viewed', 'opened'].includes(value)) return 'viewed';
  if (['declined', 'rejected'].includes(value)) return 'rejected';
  if (value === 'expired') return 'expired';
  return 'pending';
};

export const normalizePayeeType = (raw) => {
  const value = String(raw || '').toLowerCase().trim();
  if (!value) return 'unknown';
  if (value === 'insured' || value === 'homeowner' || value === 'policyholder') return 'insured';
  if (value === 'mortgage_company' || value === 'mortgagee' || value === 'mortgage' || value === 'lender') return 'mortgage_company';
  if (value === 'contractor' || value === 'vendor' || value === 'subcontractor') return 'contractor';
  if (value === 'public_adjuster' || value === 'pa' || value === 'adjuster') return 'public_adjuster';
  return 'unknown';
};

export const normalizeEndorsementStatus = (status, signedAt) => {
  if (signedAt) return 'signed';
  const value = String(status || '').toLowerCase().trim();
  if (!value) return 'pending';
  if (['signed', 'endorsed', 'complete', 'completed'].includes(value)) return 'signed';
  if (value === 'waived') return 'waived';
  if (value === 'manual_required') return 'manual_required';
  if (['declined', 'rejected'].includes(value)) return 'rejected';
  if (['sent', 'requested', 'awaiting', 'in_progress', 'viewed', 'opened'].includes(value)) return 'sent';
  if (value === 'expired') return 'expired';
  return 'pending';
};

export const derivePartnerStatusFromPayees = (payees) => {
  if (!payees?.length) return null;
  const normalized = payees.map((payee) => (
    normalizeEndorsementStatus(payee.endorsement_status, resolveSignedAt(payee))
  ));
  const allComplete = normalized.every((status) => ['signed', 'waived', 'manual_required'].includes(status));
  const partnerStatus = allComplete ? 'endorsements_complete' : 'endorsements_in_progress';
  return {
    partner_status: partnerStatus,
    partner_status_label: humanizeStatus(partnerStatus),
    partner_status_updated_at: new Date().toISOString(),
  };
};

export const derivePartnerStatus = (check = {}) => {
  const explicitStatus = String(check.partner_status || '').trim();
  if (explicitStatus) {
    return {
      partner_status: explicitStatus,
      partner_status_label: String(check.partner_status_label || '').trim() || humanizeStatus(explicitStatus),
      partner_status_updated_at: check.partner_status_updated_at || new Date().toISOString(),
    };
  }
  const stage = String(check.check_stage || '').trim().toLowerCase();
  const status = String(check.status || '').trim().toLowerCase();
  const recommendation = String(check.deposit_recommendation || '').trim().toLowerCase();
  if (stage === 'endorsing') {
    return {
      partner_status: 'endorsements_in_progress',
      partner_status_label: 'Endorsements In Progress',
      partner_status_updated_at: new Date().toISOString(),
    };
  }
  if (stage === 'ready_for_deposit') {
    const normalized = status === 'branch_deposit_required' || recommendation === 'branch_deposit_recommended'
      ? 'branch_deposit_required'
      : 'approved_for_deposit';
    return {
      partner_status: normalized,
      partner_status_label: humanizeStatus(normalized),
      partner_status_updated_at: new Date().toISOString(),
    };
  }
  if (stage === 'loss_draft') {
    return {
      partner_status: 'loss_draft_required',
      partner_status_label: 'Loss Draft Required',
      partner_status_updated_at: new Date().toISOString(),
    };
  }
  if (stage === 'deposited') {
    return {
      partner_status: 'deposited',
      partner_status_label: 'Deposited',
      partner_status_updated_at: new Date().toISOString(),
    };
  }
  const allowed = new Set([
    'endorsements_in_progress',
    'approved_for_deposit',
    'branch_deposit_required',
    'loss_draft_required',
    'deposited',
    'manual_review_required',
    'endorsements_complete',
    'needs_review',
    'reissue_requested',
  ]);
  const normalizedStatus = allowed.has(status)
    ? status
    : recommendation === 'endorsements_pending'
      ? 'endorsements_in_progress'
      : recommendation === 'ready_for_deposit'
        ? 'approved_for_deposit'
        : recommendation === 'branch_deposit_recommended'
          ? 'branch_deposit_required'
          : null;
  if (!normalizedStatus) return null;
  return {
    partner_status: normalizedStatus,
    partner_status_label: humanizeStatus(normalizedStatus),
    partner_status_updated_at: new Date().toISOString(),
  };
};

export const expectedBridgeSecret = () => String(process.env.CROSS_APP_BRIDGE_SECRET || '');

export const bridgeSecretMatches = (event) => {
  const expected = expectedBridgeSecret();
  if (!expected) return false;
  const provided = header(event, 'x-bridge-secret') || header(event, 'X-Bridge-Secret');
  return safeEqual(expected, provided);
};

const isHttpUrl = (value) => /^https?:\/\//i.test(String(value || ''));

export const copyRemoteImageLocally = async (remoteUrl, checkLocalId, side, deps = {}) => {
  if (!remoteUrl) return null;
  const trimmed = String(remoteUrl).trim();
  if (!trimmed) return null;
  if (!isHttpUrl(trimmed)) return trimmed;
  const fetchImpl = deps.fetch || fetch;
  const put = deps.putObject || (async (args) => s3().send(new PutObjectCommand(args)));
  try {
    const resp = await fetchImpl(trimmed);
    if (!resp?.ok) return trimmed;
    const contentType = resp.headers?.get?.('content-type') || 'image/jpeg';
    const bytes = Buffer.from(await resp.arrayBuffer());
    const extFromUrl = (() => {
      const clean = trimmed.split('?')[0];
      const last = clean.split('/').pop() || '';
      const ext = last.includes('.') ? last.split('.').pop() : '';
      return (ext || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    })();
    const rel = `checks/shared/${checkLocalId}/${side}-${Date.now()}.${extFromUrl}`;
    const key = s3KeyFor('claim-files', rel);
    if (!key || !filesBucket()) return trimmed;
    await put({
      Bucket: filesBucket(),
      Key: key,
      Body: bytes,
      ContentType: contentType.split(';')[0] || 'image/jpeg',
    });
    return rel;
  } catch {
    return trimmed;
  }
};

export const buildIngestPlan = (body) => {
  if (body?.action === 'ocr_only') {
    return { error: 'use_check_ocr_intake', statusCode: 400 };
  }
  if (!body?.source_check_id || !body?.target_partner_code || !body?.source_tenant_id) {
    return { error: 'missing required fields', statusCode: 400 };
  }
  const sourcePartnerCode = String(body.source_partner_code || '').trim().toUpperCase();
  const nativeTenantId = NATIVE_TENANT_MAP[sourcePartnerCode] || null;
  const isNativePaired = Boolean(nativeTenantId);
  const payeesProvided = Array.isArray(body.payees);
  const cleanedPayees = payeesProvided
    ? body.payees.filter((p) => p && typeof p.payee_name === 'string' && p.payee_name.trim().length > 0)
    : [];
  const check = body.check && typeof body.check === 'object' ? body.check : {};
  const partnerAmount = check.amount === undefined || check.amount === null || check.amount === ''
    ? null
    : Number(check.amount);
  return {
    source_app: body.source_app || null,
    source_project_ref: body.source_project_ref || null,
    source_tenant_id: body.source_tenant_id,
    source_tenant_name: body.source_tenant_name || null,
    source_check_id: body.source_check_id,
    source_partner_code: sourcePartnerCode || null,
    target_partner_code: String(body.target_partner_code).trim().toUpperCase(),
    shared_by_email: body.shared_by_email || null,
    freedom_claim_id: body.freedom_claim_id ?? null,
    freedom_claim_number: body.freedom_claim_number ?? null,
    nativeTenantId,
    isNativePaired,
    payeesProvided,
    check,
    amount: Number.isFinite(partnerAmount) ? partnerAmount : null,
    cleanedPayees,
    initialPartnerStatus: derivePartnerStatus(check) || derivePartnerStatusFromPayees(cleanedPayees),
  };
};

const publicWriteDb = async () => {
  const credentials = await loadDatabaseCredentials();
  const client = new Client(buildWriteClientConfig(credentials, { queryTimeoutMillis: 20000 }));
  await client.connect();
  return client;
};

const tenantIdOf = (row) => row?.id || row?.tenant_id || null;

export const persistIngestInline = async (client, plan) => {
  const code = plan.target_partner_code;
  const lookup = await client.query(
    'SELECT * FROM public.lookup_tenant_by_partner_code($1) LIMIT 1',
    [code],
  );
  const targetTenantId = tenantIdOf(lookup.rows[0]);
  if (!targetTenantId) {
    return { error: 'target_partner_code not found', statusCode: 404 };
  }

  let sourceTenantId;
  if (plan.isNativePaired) {
    sourceTenantId = plan.nativeTenantId;
  } else {
    const externalSlug = `ext-${String(plan.source_app || 'app').slice(0, 24)}-${String(plan.source_tenant_id).slice(0, 8)}`;
    const existing = await client.query(
      'SELECT id FROM public.tenants WHERE slug = $1 LIMIT 1',
      [externalSlug],
    );
    if (existing.rows[0]?.id) {
      sourceTenantId = existing.rows[0].id;
    } else {
      const created = await client.query(
        `INSERT INTO public.tenants
           (name, slug, plan_tier, payment_provider, moov_allowlisted, moov_environment)
         VALUES ($1, $2, 'starter', 'moov', true, 'production')
         RETURNING id`,
        [`${plan.source_tenant_name || 'External'} (${plan.source_app || 'partner'})`, externalSlug],
      );
      sourceTenantId = created.rows[0].id;
    }
  }

  const existingCheck = await client.query(
    `SELECT id FROM public.check_intake_items
     WHERE external_origin->>'source_check_id' = $1
     LIMIT 1`,
    [plan.source_check_id],
  );

  const origin = {
    source_app: plan.source_app,
    source_project_ref: plan.source_project_ref,
    source_tenant_id: plan.source_tenant_id,
    source_tenant_name: plan.source_tenant_name,
    source_check_id: plan.source_check_id,
    source_partner_code: plan.source_partner_code,
    native_paired: plan.isNativePaired,
    ingested_at: new Date().toISOString(),
    shared_by_email: plan.shared_by_email,
  };

  let checkId;
  if (existingCheck.rows[0]?.id) {
    checkId = existingCheck.rows[0].id;
    const updates = ['updated_at = now()'];
    const values = [];
    const add = (sql, value) => {
      values.push(value);
      updates.push(`${sql} = $${values.length}`);
    };
    const check = plan.check;
    if (check.carrier_name !== undefined) add('carrier_name', toStandardCaps(check.carrier_name ?? null));
    if (check.check_number !== undefined) add('check_number', check.check_number ?? null);
    if (check.amount !== undefined) add('amount', plan.amount);
    if (check.issue_date !== undefined) add('issue_date', check.issue_date ?? null);
    if (check.payee_line !== undefined) add('payee_line', toStandardCaps(check.payee_line ?? null));
    if (check.detected_claim_number !== undefined) add('detected_claim_number', check.detected_claim_number ?? null);
    if (check.funds_type !== undefined) add('funds_type', check.funds_type ?? null);
    if (check.property_address !== undefined) add('property_address', toStandardCaps(check.property_address ?? null));
    if (check.payment_classification !== undefined) add('payment_classification', check.payment_classification ?? null);
    if (check.payee_address !== undefined) add('payee_address', toStandardCaps(check.payee_address ?? null));
    if (check.status !== undefined) add('status', check.status ?? null);
    if (check.check_stage !== undefined) add('check_stage', check.check_stage ?? 'review');
    if (check.deposit_recommendation !== undefined) add('deposit_recommendation', check.deposit_recommendation ?? null);
    if (check.ocr_status !== undefined) add('ocr_status', check.ocr_status ?? null);
    if (plan.freedom_claim_id !== undefined) add('freedom_claim_id', plan.freedom_claim_id);
    if (plan.freedom_claim_number !== undefined) add('freedom_claim_number', plan.freedom_claim_number);
    if (plan.front_image_path && !isHttpUrl(plan.front_image_path)) add('front_image_path', plan.front_image_path);
    if (plan.back_image_path && !isHttpUrl(plan.back_image_path)) add('back_image_path', plan.back_image_path);
    if (plan.initialPartnerStatus) {
      add('partner_status', plan.initialPartnerStatus.partner_status);
      add('partner_status_label', plan.initialPartnerStatus.partner_status_label);
      add('partner_status_updated_at', plan.initialPartnerStatus.partner_status_updated_at);
    }
    values.push(checkId);
    await client.query(
      `UPDATE public.check_intake_items SET ${updates.join(', ')} WHERE id = $${values.length}`,
      values,
    );
  } else {
    const check = plan.check;
    const ocrStatus = check.ocr_status
      ?? (check.carrier_name || check.check_number || plan.amount != null ? 'completed' : 'pending');
    const inserted = await client.query(
      `INSERT INTO public.check_intake_items (
         tenant_id, front_image_path, back_image_path, carrier_name, check_number,
         amount, issue_date, payee_line, detected_claim_number, funds_type,
         property_address, payment_classification, payee_address, status, check_stage,
         check_source, deposit_recommendation, ocr_status, freedom_claim_id,
         freedom_claim_number, partner_status, partner_status_label,
         partner_status_updated_at, external_origin
       ) VALUES (
         $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
         'insurance', $16, $17, $18, $19, $20, $21, $22, $23::jsonb
       ) RETURNING id`,
      [
        sourceTenantId,
        plan.front_image_path || `external://${plan.source_check_id}`,
        plan.back_image_path || null,
        toStandardCaps(check.carrier_name ?? null),
        check.check_number ?? null,
        plan.amount,
        check.issue_date ?? null,
        toStandardCaps(check.payee_line ?? null),
        check.detected_claim_number ?? null,
        check.funds_type ?? null,
        toStandardCaps(check.property_address ?? null),
        check.payment_classification ?? null,
        toStandardCaps(check.payee_address ?? null),
        plan.isNativePaired ? (check.status ?? 'needs_review') : (check.status ?? 'uploaded'),
        plan.isNativePaired ? 'review' : (check.check_stage ?? 'review'),
        check.deposit_recommendation ?? null,
        ocrStatus,
        plan.freedom_claim_id,
        plan.freedom_claim_number,
        plan.isNativePaired ? null : plan.initialPartnerStatus?.partner_status ?? null,
        plan.isNativePaired ? null : plan.initialPartnerStatus?.partner_status_label ?? null,
        plan.isNativePaired ? null : plan.initialPartnerStatus?.partner_status_updated_at ?? null,
        JSON.stringify(origin),
      ],
    );
    checkId = inserted.rows[0].id;
  }

  if (plan.payeesProvided) {
    await client.query('DELETE FROM public.check_payees WHERE check_id = $1::uuid', [checkId]);
    await client.query('DELETE FROM public.check_endorsements WHERE check_id = $1::uuid', [checkId]);
    for (const payee of plan.cleanedPayees) {
      const signedAt = resolveSignedAt(payee);
      await client.query(
        `INSERT INTO public.check_payees (
           check_id, tenant_id, payee_name, payee_type, endorsement_status, endorsed_at,
           contact_email, contact_phone
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)`,
        [
          checkId,
          sourceTenantId,
          toStandardCaps(payee.payee_name.trim()),
          normalizePayeeType(payee.payee_type),
          normalizePayeeStatus(payee.endorsement_status, signedAt),
          signedAt,
          payee.contact_email ?? null,
          payee.contact_phone ?? null,
        ],
      );
      await client.query(
        `INSERT INTO public.check_endorsements (
           check_id, tenant_id, payee_name, payee_type, status, signed_at,
           contact_email, contact_phone
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)`,
        [
          checkId,
          sourceTenantId,
          toStandardCaps(payee.payee_name.trim()),
          normalizePayeeType(payee.payee_type),
          normalizeEndorsementStatus(payee.endorsement_status, signedAt),
          signedAt,
          payee.contact_email ?? null,
          payee.contact_phone ?? null,
        ],
      );
    }
  }

  if (!plan.isNativePaired) {
    await client.query(
      `INSERT INTO public.shared_checks (
         check_id, source_tenant_id, target_tenant_id, shared_by, access_level, revoked_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'read_only', NULL)
       ON CONFLICT (check_id, source_tenant_id, target_tenant_id)
       DO UPDATE SET revoked_at = NULL, access_level = 'read_only'`,
      [checkId, sourceTenantId, targetTenantId, '00000000-0000-0000-0000-000000000000'],
    );
  }

  return {
    ok: true,
    statusCode: 200,
    check_id: checkId,
    target_tenant_id: targetTenantId,
    source_tenant_id: sourceTenantId,
    native_paired: plan.isNativePaired,
  };
};

export const persistIngest = async (client, plan) => {
  try {
    const doc = (await client.query(
      'SELECT public.aws_ingest_shared_check($1::jsonb) AS doc',
      [JSON.stringify({ ...plan, check: plan.check })],
    )).rows[0]?.doc;
    if (doc?.ok || doc?.error) return doc;
  } catch (error) {
    if (error?.code !== '42883') throw error;
  }
  return persistIngestInline(client, plan);
};

const maybeStatusBackfill = async (plan) => {
  if (plan.initialPartnerStatus) return;
  if (plan.source_app !== 'freedom_crm' || !plan.source_project_ref) return;
  const expected = expectedBridgeSecret();
  if (!expected) return;
  const url = `https://${plan.source_project_ref}.supabase.co/functions/v1/push-check-status`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer bridge-status-backfill',
        'x-bridge-secret': expected,
      },
      body: JSON.stringify({ check_id: plan.source_check_id }),
    });
  } catch {
    /* non-fatal; partner status can be repaired later */
  }
};

export const handleIngestSharedCheck = async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  if (!expectedBridgeSecret() || !bridgeSecretMatches(event)) {
    return { ok: false, statusCode: 401, error: 'unauthorized', spoofFieldsIgnored: spoof };
  }
  const plan = buildIngestPlan(body);
  if (plan.error) {
    return { ok: false, statusCode: plan.statusCode, error: plan.error, spoofFieldsIgnored: spoof };
  }

  const persist = deps.persistIngest || persistIngest;
  const copyImage = deps.copyRemoteImageLocally || copyRemoteImageLocally;
  let client;
  try {
    plan.front_image_path = await copyImage(plan.check.front_image_url, plan.source_check_id, 'front', deps);
    plan.back_image_path = await copyImage(plan.check.back_image_url, plan.source_check_id, 'back', deps);
    client = deps.client || await publicWriteDb();
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ WRITE');
    const result = await persist(client, plan);
    if (result?.ok === false || result?.error) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: result.statusCode || 400, error: result.error, spoofFieldsIgnored: spoof };
    }
    await client.query('COMMIT');
    await maybeStatusBackfill(plan);
    return { ...result, spoofFieldsIgnored: spoof };
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return {
      ok: false,
      statusCode: 500,
      error: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (client && !deps.client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};
