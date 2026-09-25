/**
 * Narrow invalidation when a payee's financially material identity changes.
 *
 * The DB trigger tg_mirror_payee_to_endorsement preserves signed rows on
 * rename and inserts a new pending row. That leaves a stale signature that
 * can later satisfy Ready / CheckAlt eligibility if the duplicate is removed.
 *
 * AWS write path resets those rows and clears the official rear fingerprint.
 * Does not call CheckAlt or Moov.
 */

export const MATERIAL_PAYEE_FIELDS = new Set(['payee_name', 'payee_type']);

export const isMaterialPayeeChange = (previous = {}, next = {}) => {
  if (next.payee_name !== undefined) {
    const before = String(previous.payee_name || '').trim().toLowerCase();
    const after = String(next.payee_name || '').trim().toLowerCase();
    if (before !== after) return true;
  }
  if (next.payee_type !== undefined) {
    const before = String(previous.payee_type || '').trim().toLowerCase();
    const after = String(next.payee_type || '').trim().toLowerCase();
    if (before !== after) return true;
  }
  return false;
};

export const invalidateEndorsementsForMaterialPayeeChange = async (client, {
  checkId,
  payeeId,
  previousName,
  newName,
  actorId = null,
} = {}) => {
  if (!checkId || !payeeId) return { ok: false, error: 'missing_ids' };

  const reset = await client.query(
    `UPDATE public.check_endorsements
        SET status = 'pending',
            signed_at = NULL,
            signature_image_url = NULL,
            signature_method = 'portal',
            payee_name = COALESCE($3, payee_name),
            notes = CASE
              WHEN notes IS NULL OR length(trim(notes)) = 0
                THEN 'Invalidated after material payee change'
              ELSE notes
            END,
            updated_at = now()
      WHERE check_id = $1::uuid
        AND (
          payee_id = $2::uuid
          OR (
            payee_id IS NULL
            AND $4::text IS NOT NULL
            AND lower(trim(payee_name)) = lower(trim($4::text))
          )
        )
      RETURNING id`,
    [checkId, payeeId, newName || null, previousName || null],
  );

  await client.query(
    `DELETE FROM public.check_endorsements e
      WHERE e.check_id = $1::uuid
        AND e.payee_id = $2::uuid
        AND e.id <> (
          SELECT id FROM public.check_endorsements
           WHERE check_id = $1::uuid AND payee_id = $2::uuid
           ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
           LIMIT 1
        )`,
    [checkId, payeeId],
  );

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
                   'reason', 'material_payee_change'
                 ),
            endorsement_render_version = COALESCE(endorsement_render_version, 0) + 1,
            updated_at = now()
      WHERE id = $1::uuid
        AND deposited_at IS NULL`,
    [checkId, new Date().toISOString()],
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
        payee_id: payeeId,
        previous_payee_name: previousName || null,
        new_payee_name: newName || null,
        reset_endorsement_ids: (reset.rows || []).map((row) => row.id),
      }),
    ],
  );

  return {
    ok: true,
    resetCount: reset.rowCount || (reset.rows || []).length,
    resetIds: (reset.rows || []).map((row) => row.id),
  };
};
