-- SQL 89: checksops gets column-level UPDATE on check_intake_items instead of
-- table-level UPDATE.
--
-- Production's checksops holds table-level UPDATE (ACL checksops=arwd), so every
-- column is updatable, id, tenant_id, created_at, uploaded_by and
-- deposited_by_tenant_id included. Staging has column grants instead (SQL 33, 35,
-- 40, 50, 52, 71 and the 2026-09-16 endorsement lock). This file makes both the
-- same: UPDATE on exactly the 43 columns the API writes as checksops, nothing else.
--
-- The REVOKE drops the table-level UPDATE and every column UPDATE that the owner
-- granted to checksops. The GRANT then gives back UPDATE on the listed columns.
-- SELECT, INSERT and DELETE are not touched. Run as the table owner (production:
-- checksops_admin); the reviewed tools wrap both statements in one transaction.
-- No data changes.
--
-- Columns and the code that writes each one: ops/production-sql-89-apply.md.
-- Writes through SECURITY DEFINER functions (SQL 43, SQL 44, SQL 70,
-- ocr_commit_results, deposit_action, record_check_return and the rest) run as
-- the function owner and need no checksops grant.
REVOKE UPDATE ON TABLE public.check_intake_items FROM checksops;
GRANT UPDATE (
  account_number,
  amount,
  back_image_deposit_path,
  back_image_original_path,
  back_image_path,
  carrier_name,
  check_number,
  check_stage,
  deposit_recommendation,
  endorsement_override,
  endorsement_packet_path,
  endorsement_render_meta,
  endorsement_render_status,
  endorsement_render_version,
  expiration_days,
  front_image_path,
  funds_type,
  is_multi_payee,
  issue_date,
  mortgage_monitoring_type,
  mortgage_received_at,
  mortgage_sent_at,
  mortgage_tracking_number,
  ocr_needs_verification,
  ocr_status,
  payee_address,
  payee_line,
  pre_return_stage,
  property_address,
  return_code,
  return_notes,
  return_reason,
  return_recorded_by,
  return_resolution,
  return_resolved_at,
  return_source,
  returned_at,
  review_notes,
  reviewed_at,
  reviewed_by,
  routing_number,
  status,
  updated_at
) ON TABLE public.check_intake_items TO checksops;
