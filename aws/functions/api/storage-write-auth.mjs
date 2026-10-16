/**
 * Authorize staging storage uploads for check-, tenant-, and document-scoped paths.
 * Keeps financial provider execution out of the path; only object placement is gated.
 */
import {
  STORAGE_WRITE_BUCKETS,
  isBrandingUploadPath,
  isCheckScopedPathFor,
  matchCheckScopedPath,
  matchDepositAttachmentPath,
  matchLossDraftDocumentPath,
  matchTenantDocumentPath,
  normalizePath,
  s3KeyFor,
} from './storage-paths.mjs';
import { canManageTenantDocumentLibrary, mortgageAgentCanWriteTenantLossDraft } from './mortgage-library-docs.mjs';
import { libraryObjectPath } from './tenant-library-rules.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const denyBucket = (bucket) => {
  if (!STORAGE_WRITE_BUCKETS.includes(bucket)) {
    return {
      ok: false,
      statusCode: 403,
      error: 'bucket_not_allowed',
      message: 'Storage writes are limited to allowlisted application buckets',
    };
  }
  return null;
};

const lookupWritableCheck = async (client, checkId) => {
  if (!UUID_RE.test(String(checkId || ''))) return { error: 'invalid_uuid', field: 'check_id' };
  const rows = (await client.query(
    `SELECT id, tenant_id, front_image_path, back_image_path, back_image_deposit_path, endorsement_render_meta
       FROM public.check_intake_items WHERE id = $1::uuid`,
    [checkId],
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'check not found or not writable' };
  return { check: rows[0] };
};

/** Allow overwrite of stored check images, `.deposit2.jpg`, and official `.checkalt.jpg` siblings. */
export const CHECK_IMAGE_OR_DEPOSIT2_WRITE_SQL = `
SELECT id, tenant_id, front_image_path, back_image_path, back_image_deposit_path, endorsement_render_meta
FROM public.check_intake_items
WHERE split_part(front_image_path, '?', 1) = $1
   OR split_part(back_image_path, '?', 1) = $1
   OR split_part(back_image_deposit_path, '?', 1) = $1
   OR regexp_replace(split_part(COALESCE(front_image_path, ''), '?', 1), '\\.[^.]+$', '') || '.deposit2.jpg' = $1
   OR regexp_replace(split_part(COALESCE(back_image_path, ''), '?', 1), '\\.[^.]+$', '') || '.deposit2.jpg' = $1
   OR regexp_replace(split_part(COALESCE(back_image_deposit_path, ''), '?', 1), '\\.[^.]+$', '') || '.deposit2.jpg' = $1
   OR regexp_replace(split_part(COALESCE(front_image_path, ''), '?', 1), '\\.[^.]+$', '') || '.checkalt.jpg' = $1
   OR regexp_replace(split_part(COALESCE(back_image_path, ''), '?', 1), '\\.[^.]+$', '') || '.checkalt.jpg' = $1
   OR regexp_replace(split_part(COALESCE(back_image_deposit_path, ''), '?', 1), '\\.[^.]+$', '') || '.checkalt.jpg' = $1
LIMIT 1`;

const lookupWritableCheckByImagePath = async (client, rel) => {
  const rows = (await client.query(CHECK_IMAGE_OR_DEPOSIT2_WRITE_SQL, [rel])).rows;
  return rows[0] || null;
};

const hasTenantMembership = async (client, userId, tenantId) => {
  if (!UUID_RE.test(String(tenantId || ''))) return false;
  const rows = (await client.query(
    `SELECT 1 FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    [userId, tenantId],
  )).rows;
  return rows.length > 0;
};

const hasAnyTenantMembership = async (client, userId) => {
  const rows = (await client.query(
    `SELECT 1 FROM public.tenant_users WHERE user_id = $1::uuid LIMIT 1`,
    [userId],
  )).rows;
  return rows.length > 0;
};

const isPlatformOwner = async (client) => {
  const row = (await client.query(
    'SELECT COALESCE(public.is_platform_owner(), false) AS is_platform, COALESCE(public.is_master_owner(), false) AS is_master',
  )).rows[0] || {};
  return row.is_platform === true || row.is_master === true;
};

/** tenant-logos: exactly {tenantId}/{file}. */
const TENANT_LOGO_PATH = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[A-Za-z0-9._=-]+$/i;
/** company-branding: one shared folder of timestamped letterheads; new files only. */
const COMPANY_BRANDING_PATH = /^(invoice_)?letterhead_\d+\.[A-Za-z0-9]{1,32}$/;

export const authorizeStorageWritePath = async (client, bucket, objectPath, userId) => {
  const denied = denyBucket(bucket);
  if (denied) return denied;
  const rel = normalizePath(objectPath, bucket);
  if (!rel) return { ok: false, statusCode: 400, error: 'invalid_path' };

  if (bucket === 'claim-files' || bucket === 'endorsement-packets') {
    const checkId = matchCheckScopedPath(rel);
    if (!checkId) {
      if (bucket === 'claim-files') {
        const existing = await lookupWritableCheckByImagePath(client, rel);
        if (existing) {
          return {
            ok: true,
            rel,
            check: existing,
            key: s3KeyFor(bucket, rel),
            strategy: 'existing_check_image_or_deposit2',
          };
        }
      }
      return {
        ok: false,
        statusCode: 403,
        error: 'path_not_allowlisted',
        message: 'Object path is not in a check-scoped write prefix',
      };
    }
    const looked = await lookupWritableCheck(client, checkId);
    if (looked.error) {
      return {
        ok: false,
        statusCode: looked.error === 'invalid_uuid' ? 400 : 403,
        error: looked.error,
        message: looked.message || 'Not authorized for this object',
        field: looked.field,
      };
    }
    if (!isCheckScopedPathFor(rel, looked.check.id)) {
      return { ok: false, statusCode: 403, error: 'rls_denied', message: 'path is not scoped to this check' };
    }
    return { ok: true, rel, check: looked.check, key: s3KeyFor(bucket, rel), strategy: 'check' };
  }

  if (bucket === 'tenant-documents') {
    const tenantId = matchTenantDocumentPath(rel);
    // Exactly {tenantId}/library/{category}/{file}: one known category folder, one file name.
    if (!tenantId || !libraryObjectPath(rel, { tenantId })) {
      return {
        ok: false,
        statusCode: 403,
        error: 'path_not_allowlisted',
        message: 'tenant-documents uploads must use {tenantId}/library/{category}/{file}',
      };
    }
    if (!(await canManageTenantDocumentLibrary(client, userId, tenantId))) {
      return {
        ok: false,
        statusCode: 403,
        error: 'rls_denied',
        // Owner policy: any member of the tenant writes its library; the platform
        // owner and platform roles do not.
        message: 'Membership of this company is required to write library documents',
      };
    }
    return { ok: true, rel, tenantId, key: s3KeyFor(bucket, rel), strategy: 'tenant' };
  }

  if (bucket === 'loss-draft-documents') {
    const draftId = matchLossDraftDocumentPath(rel);
    if (!draftId) {
      return {
        ok: false,
        statusCode: 403,
        error: 'path_not_allowlisted',
        message: 'loss-draft-documents uploads must use {claimId}/{lossDraftId}/{docId}/...',
      };
    }
    const draft = (await client.query(
      `SELECT ld.id, ld.check_intake_item_id, ci.tenant_id
       FROM public.loss_draft_tracking ld
       LEFT JOIN public.check_intake_items ci ON ci.id = ld.check_intake_item_id
       WHERE ld.id = $1::uuid`,
      [draftId],
    )).rows[0];
    if (!draft) {
      return { ok: false, statusCode: 403, error: 'rls_denied', message: 'loss draft not found or not writable' };
    }
    if (draft.tenant_id && (await hasTenantMembership(client, userId, draft.tenant_id))) {
      return { ok: true, rel, draftId, key: s3KeyFor(bucket, rel), strategy: 'loss_draft' };
    }
    if (await mortgageAgentCanWriteTenantLossDraft(client, userId, {
      tenantId: draft.tenant_id,
      checkId: draft.check_intake_item_id,
    })) {
      return { ok: true, rel, draftId, key: s3KeyFor(bucket, rel), strategy: 'loss_draft' };
    }
    return { ok: false, statusCode: 403, error: 'rls_denied', message: 'Not authorized for this loss draft' };
  }

  // Branding writes used to accept any short path from any member of any
  // tenant, with upsert and delete, so one tenant could overwrite or remove
  // another tenant's logo or letterhead.
  if (bucket === 'tenant-logos') {
    const tenantId = String(rel).match(TENANT_LOGO_PATH)?.[1];
    if (!isBrandingUploadPath(rel) || !tenantId) {
      return { ok: false, statusCode: 403, error: 'path_not_allowlisted', message: 'tenant-logos uploads must use {tenantId}/{file}' };
    }
    // Tenant branding is the tenant's own: members only. The platform owner
    // does not edit tenant branding.
    if (!(await hasTenantMembership(client, userId, tenantId))) {
      return { ok: false, statusCode: 403, error: 'rls_denied', message: 'Not a member of this tenant' };
    }
    return { ok: true, rel, tenantId: tenantId.toLowerCase(), key: s3KeyFor(bucket, rel), strategy: 'branding' };
  }

  if (bucket === 'company-branding') {
    if (!isBrandingUploadPath(rel) || !COMPANY_BRANDING_PATH.test(rel)) {
      return { ok: false, statusCode: 403, error: 'path_not_allowlisted', message: 'company-branding uploads must be a new letterhead_<time> or invoice_letterhead_<time> file' };
    }
    if (await isPlatformOwner(client)) {
      return { ok: true, rel, key: s3KeyFor(bucket, rel), strategy: 'branding' };
    }
    if (!(await hasAnyTenantMembership(client, userId))) {
      return { ok: false, statusCode: 403, error: 'rls_denied', message: 'Tenant membership required for branding uploads' };
    }
    // Shared folder: members may add a new file, never replace or remove one.
    return { ok: true, rel, key: s3KeyFor(bucket, rel), strategy: 'branding', createOnly: true };
  }

  if (bucket === 'deposit-attachments') {
    const itemId = matchDepositAttachmentPath(rel);
    if (!itemId) {
      return {
        ok: false,
        statusCode: 403,
        error: 'path_not_allowlisted',
        message: 'deposit-attachments uploads must use {depositItemId}/...',
      };
    }
    const item = (await client.query(
      `SELECT id, tenant_id FROM public.deposit_items WHERE id = $1::uuid`,
      [itemId],
    )).rows[0];
    if (!item?.tenant_id) {
      return { ok: false, statusCode: 403, error: 'rls_denied', message: 'deposit item not found or not writable' };
    }
    if (!(await hasTenantMembership(client, userId, item.tenant_id))) {
      return { ok: false, statusCode: 403, error: 'rls_denied', message: 'Not authorized for this deposit item' };
    }
    return { ok: true, rel, depositItemId: itemId, key: s3KeyFor(bucket, rel), strategy: 'deposit_attachment' };
  }

  // Homeowner check photos are written only by the server-side homeowner
  // portal (homeowner.mjs). Any member of any tenant could previously
  // overwrite or delete them here.
  if (bucket === 'homeowner-uploads') {
    return { ok: false, statusCode: 403, error: 'bucket_not_allowed', message: 'homeowner-uploads are written by the homeowner portal only' };
  }

  return {
    ok: false,
    statusCode: 403,
    error: 'bucket_not_allowed',
    message: 'No write strategy for bucket',
  };
};
