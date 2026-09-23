/**
 * Fail-closed check_payees synchronization after endorsement completion.
 * Status/token updates are required. Signature image writes are optional and
 * never block status (large in-person data:image/* payloads stay on
 * check_endorsements.signature_image_url).
 */

export const PAYEE_IMAGE_MAX_CHARS = 120000;

export const payeeStatusSyncError = (message = 'Corresponding check_payees row could not be synchronized') => (
  Object.assign(new Error(message), {
    statusCode: 503,
    error: 'payee_status_sync_failed',
    message,
  })
);

export const payeeImageForPersist = (image) => {
  if (typeof image !== 'string') return null;
  const trimmed = image.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('data:image/')) {
    return trimmed.length <= PAYEE_IMAGE_MAX_CHARS ? trimmed : null;
  }
  if (trimmed.length > 512) return null;
  return trimmed;
};

export const synchronizePayeeEndorsementStatus = async (client, endorsement, {
  status,
  token,
  signedAt,
} = {}) => {
  const nextStatus = String(status || '').trim().toLowerCase();
  if (!nextStatus) throw payeeStatusSyncError('payee endorsement status is required');
  if (!endorsement?.payee_id && !(endorsement?.check_id && endorsement?.payee_name)) {
    throw payeeStatusSyncError();
  }

  const endorsedAt = (nextStatus === 'signed' || nextStatus === 'waived')
    ? (signedAt || new Date().toISOString())
    : (signedAt || null);

  let result;
  if (endorsement.payee_id) {
    result = await client.query(
      `UPDATE public.check_payees
       SET endorsement_status = $2,
           endorsed_at = COALESCE($3::timestamptz, endorsed_at),
           endorsement_token = COALESCE($4, endorsement_token),
           endorsement_token_expires_at = NULL,
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING id, endorsement_status, endorsed_at`,
      [endorsement.payee_id, nextStatus, endorsedAt, token || null],
    );
  } else {
    result = await client.query(
      `UPDATE public.check_payees
       SET endorsement_status = $3,
           endorsed_at = COALESCE($4::timestamptz, endorsed_at),
           endorsement_token = COALESCE($5, endorsement_token),
           endorsement_token_expires_at = NULL,
           updated_at = now()
       WHERE check_id = $1::uuid AND payee_name = $2
       RETURNING id, endorsement_status, endorsed_at`,
      [endorsement.check_id, endorsement.payee_name, nextStatus, endorsedAt, token || null],
    );
  }

  if (!result?.rowCount) throw payeeStatusSyncError();
  return result.rows[0];
};

export const persistPayeeSignatureImage = async (client, endorsement, image) => {
  const persistable = payeeImageForPersist(image);
  if (!persistable) return { skipped: true, reason: 'not_persistable' };
  try {
    if (endorsement?.payee_id) {
      await client.query(
        `UPDATE public.check_payees
         SET endorsement_image_path = $2, updated_at = now()
         WHERE id = $1::uuid`,
        [endorsement.payee_id, persistable],
      );
      return { skipped: false };
    }
    if (endorsement?.check_id && endorsement?.payee_name) {
      await client.query(
        `UPDATE public.check_payees
         SET endorsement_image_path = $3, updated_at = now()
         WHERE check_id = $1::uuid AND payee_name = $2`,
        [endorsement.check_id, endorsement.payee_name, persistable],
      );
      return { skipped: false };
    }
    return { skipped: true, reason: 'missing_payee' };
  } catch {
    return { skipped: true, reason: 'image_write_failed' };
  }
};

export const syncPayeeAfterEndorsement = async (client, endorsement, {
  status,
  token,
  image,
  signedAt,
} = {}) => {
  const row = await synchronizePayeeEndorsementStatus(client, endorsement, {
    status,
    token,
    signedAt,
  });
  if (image) {
    await persistPayeeSignatureImage(client, {
      ...endorsement,
      payee_id: endorsement.payee_id || row?.id,
    }, image);
  }
  return row;
};

export const synchronizePayeesFromEndorsements = async (client, checkId) => {
  if (!checkId) throw payeeStatusSyncError('check id is required to synchronize payees');
  const { rows } = await client.query(
    `SELECT payee_id, payee_name, status, signed_at, check_id, token
     FROM public.check_endorsements
     WHERE check_id = $1::uuid`,
    [checkId],
  );
  const synced = [];
  for (const row of rows || []) {
    const status = String(row.status || '').toLowerCase();
    if (status !== 'signed' && status !== 'waived') continue;
    synced.push(await synchronizePayeeEndorsementStatus(client, row, {
      status,
      token: row.token || null,
      signedAt: row.signed_at || null,
    }));
  }
  return synced;
};
