/**
 * Narrow invalidation when a payee's financially material identity changes.
 *
 * The DB trigger tg_mirror_payee_to_endorsement preserves signed/waived rows
 * on rename and inserts a new pending row. Eligibility then either treats the
 * stale signed row as complete or fails only as endorsement_state_ambiguous.
 *
 * AWS write path snapshots prior endorsement/signature state into audit,
 * collapses to one current pending row, and clears the official rear
 * fingerprint so the stale signature cannot satisfy Ready.
 * Does not call CheckAlt or Moov.
 */

export const MATERIAL_PAYEE_FIELDS = new Set(['payee_name', 'payee_type']);
export const MATERIAL_CHANGE_CATEGORY = 'payee_identity';
export const INVALIDATION_REASON = 'material_payee_change';
export const INVALIDATION_EVENT = 'endorsement_invalidated_material_edit';

const changedText = (previous, next) => {
  const before = String(previous || '').trim().toLowerCase();
  const after = String(next || '').trim().toLowerCase();
  return before !== after;
};

export const isMaterialPayeeChange = (previous = {}, next = {}) => {
  if (next.payee_name !== undefined && changedText(previous.payee_name, next.payee_name)) {
    return true;
  }
  if (next.payee_type !== undefined && changedText(previous.payee_type, next.payee_type)) {
    return true;
  }
  return false;
};

export const materialPayeeFieldsChanged = (previous = {}, next = {}) => {
  const fields = [];
  if (next.payee_name !== undefined && changedText(previous.payee_name, next.payee_name)) {
    fields.push('payee_name');
  }
  if (next.payee_type !== undefined && changedText(previous.payee_type, next.payee_type)) {
    fields.push('payee_type');
  }
  return fields;
};

const safeQuery = async (client, sql, params = []) => {
  try {
    return await client.query(sql, params);
  } catch {
    return { rows: [], rowCount: 0, skipped: true };
  }
};

const snapshotRow = (row = {}) => ({
  id: row.id || null,
  payee_id: row.payee_id || null,
  payee_name: row.payee_name || null,
  payee_type: row.payee_type || null,
  status: row.status || null,
  signed_at: row.signed_at || null,
  signature_image_url: row.signature_image_url || null,
  signature_method: row.signature_method || null,
  notes: row.notes || null,
  created_at: row.created_at || null,
  updated_at: row.updated_at || null,
});

const chooseCurrentRowId = (rows = [], newName) => {
  if (!rows.length) return null;
  const withPayee = rows.filter((row) => row.payee_id);
  const pool = withPayee.length ? withPayee : rows;
  const normalized = String(newName || '').trim().toLowerCase();
  const matchingName = pool.find((row) => String(row.payee_name || '').trim().toLowerCase() === normalized);
  if (matchingName?.id) return matchingName.id;
  return [...pool].sort((a, b) => {
    const aTime = Date.parse(a.updated_at || a.created_at || 0) || 0;
    const bTime = Date.parse(b.updated_at || b.created_at || 0) || 0;
    return bTime - aTime;
  })[0]?.id || pool[0].id;
};

export const invalidateEndorsementsForMaterialPayeeChange = async (client, {
  checkId,
  payeeId,
  previousName,
  newName,
  previousType = null,
  newType = null,
  materialFields = null,
  actorId = null,
} = {}) => {
  if (!checkId || !payeeId) return { ok: false, error: 'missing_ids' };

  const invalidatedAt = new Date().toISOString();
  const fields = Array.isArray(materialFields) && materialFields.length
    ? materialFields
    : materialPayeeFieldsChanged(
      { payee_name: previousName, payee_type: previousType },
      {
        payee_name: newName !== undefined ? newName : previousName,
        payee_type: newType !== undefined && newType !== null ? newType : previousType,
      },
    );

  const prior = await client.query(
    `SELECT id, payee_id, payee_name, payee_type, status, signed_at,
            signature_image_url, signature_method, notes, created_at, updated_at
       FROM public.check_endorsements
      WHERE check_id = $1::uuid
        AND (
          payee_id = $2::uuid
          OR (
            payee_id IS NULL
            AND $3::text IS NOT NULL
            AND lower(trim(payee_name)) = lower(trim($3::text))
          )
        )
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST`,
    [checkId, payeeId, previousName || null],
  );
  const priorRows = (prior.rows || []).map(snapshotRow);
  const keepId = chooseCurrentRowId(prior.rows || [], newName);
  const priorSignatureState = {
    statuses: priorRows.map((row) => row.status),
    signed_or_waived_ids: priorRows
      .filter((row) => ['signed', 'waived'].includes(String(row.status || '').toLowerCase()))
      .map((row) => row.id),
    signed_at: priorRows.map((row) => row.signed_at).filter(Boolean),
    signature_image_urls: priorRows.map((row) => row.signature_image_url).filter(Boolean),
    duplicate_row_count: priorRows.length,
  };

  for (const row of priorRows) {
    await safeQuery(
      client,
      `INSERT INTO public.endorsement_audit_log (
         endorsement_id, check_id, event_type, event_description, event_data, actor_id
       ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::uuid)`,
      [
        row.id,
        checkId,
        INVALIDATION_EVENT,
        'Prior endorsement snapshotted before material payee invalidation',
        JSON.stringify({
          reason: INVALIDATION_REASON,
          material_change_category: MATERIAL_CHANGE_CATEGORY,
          prior_endorsement_state: row,
        }),
        actorId,
      ],
    );
  }

  await safeQuery(
    client,
    `INSERT INTO public.check_endorsement_events (
       check_id, payee_id, event_type, event_data, actor_id
     ) VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5::uuid)`,
    [
      checkId,
      payeeId,
      INVALIDATION_EVENT,
      JSON.stringify({
        reason: INVALIDATION_REASON,
        material_change_category: MATERIAL_CHANGE_CATEGORY,
        material_fields: fields,
        prior_endorsement_state: priorRows,
        current_endorsement_id: keepId,
      }),
      actorId,
    ],
  );

  await client.query(
    `INSERT INTO public.check_audit_log (
       check_id, tenant_id, actor_id, event_type, event_description, event_data
     ) VALUES (
       $1::uuid,
       (SELECT tenant_id FROM public.check_intake_items WHERE id = $1::uuid),
       $2::uuid,
       'endorsement_invalidated_material_edit',
       'Material payee change invalidated prior endorsement/signature state',
       $3::jsonb
     )`,
    [
      checkId,
      actorId,
      JSON.stringify({
        reason: INVALIDATION_REASON,
        material_change_category: MATERIAL_CHANGE_CATEGORY,
        material_fields: fields,
        payee_id: payeeId,
        previous_payee_name: previousName || null,
        new_payee_name: newName || null,
        previous_payee_type: previousType || null,
        new_payee_type: newType || null,
        invalidated_at: invalidatedAt,
        current_endorsement_id: keepId,
        historical_endorsement_ids: priorRows.filter((row) => row.id !== keepId).map((row) => row.id),
        prior_endorsement_state: priorRows,
        prior_signature_state: priorSignatureState,
        current_endorsement_status: 'pending',
      }),
    ],
  );

  if (keepId) {
    await client.query(
      `DELETE FROM public.check_endorsements
        WHERE check_id = $1::uuid
          AND id <> $2::uuid
          AND (
            payee_id = $3::uuid
            OR (
              payee_id IS NULL
              AND (
                ($4::text IS NOT NULL AND lower(trim(payee_name)) = lower(trim($4::text)))
                OR ($5::text IS NOT NULL AND lower(trim(payee_name)) = lower(trim($5::text)))
              )
            )
          )`,
      [checkId, keepId, payeeId, previousName || null, newName || null],
    );

    await client.query(
      `UPDATE public.check_endorsements
          SET status = 'pending',
              signed_at = NULL,
              signature_image_url = NULL,
              signature_method = 'portal',
              payee_id = $3::uuid,
              payee_name = COALESCE($4, payee_name),
              notes = CASE
                WHEN notes IS NULL OR length(trim(notes)) = 0
                  THEN 'Invalidated after material payee change; prior signed state retained in audit'
                WHEN notes ILIKE '%Invalidated after material payee change%'
                  THEN notes
                ELSE notes || ' | Invalidated after material payee change; prior signed state retained in audit'
              END,
              updated_at = now()
        WHERE id = $2::uuid
          AND check_id = $1::uuid
        RETURNING id`,
      [checkId, keepId, payeeId, newName || null],
    );
  }

  await client.query(
    `UPDATE public.check_payees
        SET endorsement_status = 'pending',
            endorsed_at = NULL,
            endorsement_image_path = NULL,
            updated_at = now()
      WHERE id = $1::uuid`,
    [payeeId],
  );

  await client.query(
    `UPDATE public.check_intake_items
        SET back_image_deposit_path = NULL,
            endorsement_render_status = 'idle',
            endorsement_render_meta = COALESCE(endorsement_render_meta, '{}'::jsonb)
              - 'checkalt_rear_fingerprint'
              || jsonb_build_object(
                   'invalidated_at', $2::text,
                   'reason', 'material_payee_change',
                   'material_change_category', 'payee_identity'
                 ),
            endorsement_render_version = COALESCE(endorsement_render_version, 0) + 1,
            updated_at = now()
      WHERE id = $1::uuid
        AND deposited_at IS NULL`,
    [checkId, invalidatedAt],
  );

  return {
    ok: true,
    resetCount: priorRows.length,
    resetIds: priorRows.map((row) => row.id),
    currentEndorsementId: keepId,
    priorSignatureState,
  };
};
