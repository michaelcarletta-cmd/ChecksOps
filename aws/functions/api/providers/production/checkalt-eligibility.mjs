/**
 * Fail-closed production CheckAlt deposit eligibility.
 *
 * Authoritative DB only. Browser signed flags, payee counts, image paths,
 * tenant_id, Ready stage, and packet presence are not sources of truth.
 *
 * Rear official-image freshness is bound by a fingerprint of current
 * endorsement state, stamped when the official rear .checkalt.jpg upload URL
 * is issued. Timestamp comparison of S3 LastModified vs updated_at is not
 * used — it cannot prove the rear image matches current signatures.
 */
import { createHash } from 'node:crypto';

import {
  isCheckAltArtifactPath,
  toCheckAltPath,
} from './checkalt-image-compliance.mjs';

export const ERROR_ENDORSEMENTS_INCOMPLETE = 'endorsements_incomplete';
export const ERROR_ENDORSEMENT_MISSING = 'endorsement_missing';
export const ERROR_ENDORSEMENT_RELATIONSHIP_INVALID = 'endorsement_relationship_invalid';
export const ERROR_ENDORSEMENT_STATE_AMBIGUOUS = 'endorsement_state_ambiguous';
export const ERROR_PROVIDER_FRONT_IMAGE_MISSING = 'provider_front_image_missing';
export const ERROR_PROVIDER_REAR_IMAGE_MISSING = 'provider_rear_image_missing';
export const ERROR_PROVIDER_REAR_IMAGE_STALE = 'provider_rear_image_stale';
export const ERROR_CHECKALT_IMAGE_NONCOMPLIANT = 'checkalt_image_noncompliant';

export const CHECKALT_IMAGE_ERROR = 'CHECKALT_IMAGE_COMPLIANCE_FAILED';
export const FINGERPRINT_META_KEY = 'checkalt_rear_fingerprint';

export const CHECK_ELIGIBILITY_SELECT = `id, tenant_id, amount, check_number,
         front_image_path, back_image_path, back_image_deposit_path,
         status, check_stage, endorsement_render_meta`;

export const PAYEES_ELIGIBILITY_SQL = `SELECT id, check_id, tenant_id, payee_type, endorsement_status, endorsed_at
       FROM public.check_payees
       WHERE check_id = $1 AND tenant_id = $2
       ORDER BY id`;

export const ENDORSEMENTS_ELIGIBILITY_SQL = `SELECT id, check_id, tenant_id, payee_id, payee_type, status, signed_at
       FROM public.check_endorsements
       WHERE check_id = $1 AND tenant_id = $2
       ORDER BY id`;

function fingerprintToken(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function tenantMatches(parentTenantId, childTenantId) {
  if (parentTenantId == null || childTenantId == null) return false;
  return String(parentTenantId) === String(childTenantId);
}

function normalizedStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function endorsementCompleted(payee, endorsement) {
  const status = normalizedStatus(endorsement?.status);
  if (status === 'signed' || status === 'waived') return true;
  if (status === 'manual_required' && String(payee?.payee_type || '') === 'mortgage_company') return true;
  return false;
}

/**
 * Canonical endorsement-state fingerprint. Uses ids, types, statuses, and
 * signed_at only — never payee names, signature URLs, or image bytes.
 */
export function endorsementStateFingerprint(checkId, payees, endorsements) {
  const payeeRows = [...(payees || [])]
    .map((p) => ({
      id: fingerprintToken(p.id),
      check_id: fingerprintToken(p.check_id || checkId),
      tenant_id: fingerprintToken(p.tenant_id),
      payee_type: fingerprintToken(p.payee_type),
      endorsement_status: fingerprintToken(p.endorsement_status),
      endorsed_at: fingerprintToken(p.endorsed_at),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const endorsementRows = [...(endorsements || [])]
    .map((e) => ({
      id: fingerprintToken(e.id),
      check_id: fingerprintToken(e.check_id || checkId),
      tenant_id: fingerprintToken(e.tenant_id),
      payee_id: fingerprintToken(e.payee_id),
      payee_type: fingerprintToken(e.payee_type),
      status: fingerprintToken(e.status),
      signed_at: fingerprintToken(e.signed_at),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const canonical = JSON.stringify({
    check_id: fingerprintToken(checkId),
    payees: payeeRows,
    endorsements: endorsementRows,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function readStoredRearFingerprint(check) {
  let meta = check?.endorsement_render_meta;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { return ''; }
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return '';
  return fingerprintToken(meta[FINGERPRINT_META_KEY]);
}

export function officialCheckAltFrontPath(check) {
  return toCheckAltPath(check?.front_image_path);
}

export function officialCheckAltRearPath(check) {
  return toCheckAltPath(check?.back_image_deposit_path);
}

export function isOfficialCheckAltRearPath(check, rel) {
  if (!rel || !isCheckAltArtifactPath(rel)) return false;
  const official = officialCheckAltRearPath(check);
  return Boolean(official) && official === rel;
}

export function buildCompletedEndorsementState({
  checkId,
  tenantId,
  payees = [{
    id: 'payee-eligible-1',
    payee_type: 'insured',
    endorsement_status: 'signed',
    endorsed_at: '2026-01-01T00:00:00.000Z',
  }],
  endorsements,
} = {}) {
  const payeeRows = payees.map((p) => ({
    id: p.id,
    check_id: checkId,
    tenant_id: tenantId,
    payee_type: p.payee_type || 'insured',
    endorsement_status: p.endorsement_status || 'signed',
    endorsed_at: p.endorsed_at || '2026-01-01T00:00:00.000Z',
  }));
  const endorsementRows = (endorsements || payeeRows.map((p, i) => ({
    id: `endo-eligible-${i + 1}`,
    payee_id: p.id,
    payee_type: p.payee_type,
    status: p.endorsement_status || 'signed',
    signed_at: p.endorsed_at || '2026-01-01T00:00:00.000Z',
  }))).map((e) => ({
    id: e.id,
    check_id: checkId,
    tenant_id: tenantId,
    payee_id: e.payee_id,
    payee_type: e.payee_type || 'insured',
    status: e.status || 'signed',
    signed_at: e.signed_at || '2026-01-01T00:00:00.000Z',
  }));
  return {
    payees: payeeRows,
    endorsements: endorsementRows,
    fingerprint: endorsementStateFingerprint(checkId, payeeRows, endorsementRows),
  };
}

export function evaluateEndorsementEligibility(check, payees, endorsements) {
  const checkId = check?.id;
  const tenantId = check?.tenant_id;
  if (!checkId || !tenantId) {
    return { ok: false, error: ERROR_ENDORSEMENT_RELATIONSHIP_INVALID, reason: 'check_tenant_required' };
  }

  const payeeList = Array.isArray(payees) ? payees : [];
  const endorsementList = Array.isArray(endorsements) ? endorsements : [];

  if (payeeList.length === 0) {
    return { ok: false, error: ERROR_ENDORSEMENTS_INCOMPLETE, reason: 'required_payees_missing' };
  }

  for (const payee of payeeList) {
    if (String(payee.check_id) !== String(checkId) || !tenantMatches(tenantId, payee.tenant_id)) {
      return { ok: false, error: ERROR_ENDORSEMENT_RELATIONSHIP_INVALID, reason: 'payee_relationship_invalid' };
    }
  }

  const endorsementsByPayee = new Map();
  for (const endorsement of endorsementList) {
    if (String(endorsement.check_id) !== String(checkId)) {
      return { ok: false, error: ERROR_ENDORSEMENT_RELATIONSHIP_INVALID, reason: 'endorsement_wrong_check' };
    }
    if (!tenantMatches(tenantId, endorsement.tenant_id)) {
      return { ok: false, error: ERROR_ENDORSEMENT_RELATIONSHIP_INVALID, reason: 'endorsement_tenant_mismatch' };
    }
    const payeeId = fingerprintToken(endorsement.payee_id);
    if (!payeeId) {
      return { ok: false, error: ERROR_ENDORSEMENT_RELATIONSHIP_INVALID, reason: 'endorsement_payee_missing' };
    }
    const bucket = endorsementsByPayee.get(payeeId) || [];
    bucket.push(endorsement);
    endorsementsByPayee.set(payeeId, bucket);
  }

  const payeeIds = new Set(payeeList.map((p) => fingerprintToken(p.id)));
  for (const payeeId of endorsementsByPayee.keys()) {
    if (!payeeIds.has(payeeId)) {
      return { ok: false, error: ERROR_ENDORSEMENT_RELATIONSHIP_INVALID, reason: 'endorsement_unknown_payee' };
    }
  }

  for (const payee of payeeList) {
    const matches = endorsementsByPayee.get(fingerprintToken(payee.id)) || [];
    if (matches.length === 0) {
      return { ok: false, error: ERROR_ENDORSEMENT_MISSING, reason: 'endorsement_record_missing' };
    }
    if (matches.length > 1) {
      const statuses = new Set(matches.map((row) => normalizedStatus(row.status)));
      if (statuses.size > 1 || matches.length > 1) {
        return { ok: false, error: ERROR_ENDORSEMENT_STATE_AMBIGUOUS, reason: 'duplicate_endorsements' };
      }
    }
    const endorsement = matches[0];
    if (String(endorsement.payee_id) !== String(payee.id)) {
      return { ok: false, error: ERROR_ENDORSEMENT_RELATIONSHIP_INVALID, reason: 'endorsement_wrong_payee' };
    }
    if (normalizedStatus(endorsement.status) === 'rejected') {
      return { ok: false, error: ERROR_ENDORSEMENTS_INCOMPLETE, reason: 'required_payee_unsigned' };
    }
    if (!endorsementCompleted(payee, endorsement)) {
      return { ok: false, error: ERROR_ENDORSEMENTS_INCOMPLETE, reason: 'required_payee_unsigned' };
    }
  }

  return { ok: true };
}

export function evaluateOfficialImagePaths(check) {
  const front = officialCheckAltFrontPath(check);
  const rear = officialCheckAltRearPath(check);
  if (!front || !isCheckAltArtifactPath(front)) {
    return { ok: false, error: ERROR_PROVIDER_FRONT_IMAGE_MISSING, reason: 'front_missing' };
  }
  if (!rear || !isCheckAltArtifactPath(rear)) {
    return { ok: false, error: ERROR_PROVIDER_REAR_IMAGE_MISSING, reason: 'rear_missing' };
  }
  return { ok: true, frontPath: front, rearPath: rear };
}

export function evaluateRearImageFreshness(check, payees, endorsements) {
  const expected = endorsementStateFingerprint(check?.id, payees, endorsements);
  const stored = readStoredRearFingerprint(check);
  if (!stored) {
    return { ok: false, error: ERROR_PROVIDER_REAR_IMAGE_STALE, reason: 'rear_fingerprint_missing' };
  }
  if (stored !== expected) {
    return { ok: false, error: ERROR_PROVIDER_REAR_IMAGE_STALE, reason: 'rear_fingerprint_mismatch' };
  }
  return { ok: true, fingerprint: expected };
}

export function evaluateProductionDepositEligibility({ check, payees, endorsements }) {
  const endorsement = evaluateEndorsementEligibility(check, payees, endorsements);
  if (!endorsement.ok) return endorsement;
  const images = evaluateOfficialImagePaths(check);
  if (!images.ok) return images;
  const freshness = evaluateRearImageFreshness(check, payees, endorsements);
  if (!freshness.ok) return freshness;
  return {
    ok: true,
    fingerprint: freshness.fingerprint,
    frontPath: images.frontPath,
    rearPath: images.rearPath,
  };
}

export function mapCheckAltImageGateError(imageError) {
  if (!imageError) return { error: ERROR_CHECKALT_IMAGE_NONCOMPLIANT };
  const existing = String(imageError.error || '');
  if (existing && existing !== CHECKALT_IMAGE_ERROR && existing !== 'images_too_large') {
    return imageError;
  }
  const reason = String(imageError.reason || '');
  const base = {
    reason: imageError.reason,
    details: imageError.details,
    side: imageError.side,
    message: imageError.message,
    complianceError: CHECKALT_IMAGE_ERROR,
    liveProviderCalled: false,
    productionExecution: false,
  };
  if (reason === 'front_missing') {
    return { ...base, error: ERROR_PROVIDER_FRONT_IMAGE_MISSING };
  }
  if (reason === 'rear_missing') {
    return { ...base, error: ERROR_PROVIDER_REAR_IMAGE_MISSING };
  }
  return { ...base, error: ERROR_CHECKALT_IMAGE_NONCOMPLIANT };
}

export async function loadCheckPayees(client, checkId, tenantId) {
  const { rows } = await client.query(PAYEES_ELIGIBILITY_SQL, [checkId, tenantId]);
  return rows || [];
}

export async function loadCheckEndorsements(client, checkId, tenantId) {
  const { rows } = await client.query(ENDORSEMENTS_ELIGIBILITY_SQL, [checkId, tenantId]);
  return rows || [];
}

export async function stampCheckAltRearFingerprint(client, checkId, tenantId, payees, endorsements) {
  const fingerprint = endorsementStateFingerprint(checkId, payees, endorsements);
  await client.query(
    `UPDATE public.check_intake_items
        SET endorsement_render_meta = COALESCE(endorsement_render_meta, '{}'::jsonb)
          || jsonb_build_object($2::text, $3::text)
      WHERE id = $1
        AND tenant_id = $4`,
    [checkId, FINGERPRINT_META_KEY, fingerprint, tenantId],
  );
  return fingerprint;
}

export async function stampOfficialRearFingerprintIfNeeded(client, check, rel) {
  if (!check?.id || !rel) return null;
  let row = check;
  if (!row.back_image_deposit_path && !row.back_image_path && !row.front_image_path) {
    const loaded = (await client.query(
      `SELECT id, tenant_id, front_image_path, back_image_path, back_image_deposit_path, endorsement_render_meta
         FROM public.check_intake_items
        WHERE id = $1::uuid`,
      [check.id],
    )).rows[0];
    if (!loaded) return null;
    row = loaded;
  }
  if (!isOfficialCheckAltRearPath(row, rel)) return null;
  const payees = await loadCheckPayees(client, row.id, row.tenant_id);
  const endorsements = await loadCheckEndorsements(client, row.id, row.tenant_id);
  return stampCheckAltRearFingerprint(client, row.id, row.tenant_id, payees, endorsements);
}
