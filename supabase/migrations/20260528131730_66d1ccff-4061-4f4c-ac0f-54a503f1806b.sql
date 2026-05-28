
CREATE OR REPLACE VIEW public.loss_draft_dashboard AS
SELECT ld.id,
   ld.claim_id,
   c.claim_number,
   COALESCE(c.policyholder_name, ci.payee_line) AS policyholder_name,
   COALESCE(c.insurance_company, ci.carrier_name) AS insurance_company,
   CASE
     WHEN NULLIF(btrim(ld.mortgage_servicer), ''::text) IS NULL
       OR (lower(btrim(ld.mortgage_servicer)) = ANY (ARRAY['unknown lender'::text,'unknown servicer'::text,'unknown'::text]))
       THEN COALESCE(mc.name, ld.mortgage_servicer)
     ELSE ld.mortgage_servicer
   END AS mortgage_servicer,
   ld.escrow_status,
   ld.total_escrowed,
   ld.draw_amount_released,
   ld.holdback_amount,
   ld.total_escrowed - ld.draw_amount_released AS unreleased_amount,
   ld.draw_stage,
   ld.follow_up_date,
   ld.follow_up_count,
   ld.last_contact_at,
   ld.check_sent_date,
   ld.check_received_date,
   ld.created_at,
   ld.updated_at,
   CASE WHEN ld.check_received_date IS NOT NULL THEN CURRENT_DATE - ld.check_received_date ELSE NULL::integer END AS days_in_escrow,
   ( SELECT count(*) FROM loss_draft_documents ldd
       WHERE ldd.loss_draft_id = ld.id AND ldd.is_required = true AND ldd.is_submitted = false ) AS missing_docs_count,
   CASE WHEN ld.last_contact_at IS NOT NULL
        AND ld.last_contact_at < (now() - '14 days'::interval)
        AND (ld.total_escrowed - ld.draw_amount_released) > 0::numeric
     THEN true ELSE false END AS is_stale,
   COALESCE(ci.tenant_id,
            (SELECT tenants.id FROM tenants WHERE tenants.is_system_tenant = true LIMIT 1)) AS tenant_id,
   ld.monitoring_type,
   ci.status AS check_status
FROM loss_draft_tracking ld
LEFT JOIN claims c ON c.id = ld.claim_id
LEFT JOIN mortgage_companies mc ON mc.id = c.mortgage_company_id
LEFT JOIN check_intake_items ci ON ci.id = ld.check_intake_item_id
WHERE NOT (
  ld.escrow_status = 'endorsing'::text
  OR (ld.monitoring_type = 'not_monitored'::text
      AND ci.status = ANY (ARRAY['endorsements_in_progress'::text,'approved_for_deposit'::text,'deposited'::text]))
);

GRANT SELECT ON public.loss_draft_dashboard TO authenticated;
GRANT ALL ON public.loss_draft_dashboard TO service_role;
