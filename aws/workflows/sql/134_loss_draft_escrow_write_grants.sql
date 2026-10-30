-- SQL 134: the column privileges the Loss Draft escrow and draw records need on AWS.
--
-- Why: owner decision 2026-10-30, a monitored loss draft stays in Loss Draft so the
-- tenant can document escrow and disbursements the mortgage company reports. The API's
-- loss_draft_action (aws/functions/api/workflow-rpc.mjs executeLossDraftAction, the
-- Loss Draft API change) records them with five actions, none of which moves money:
--   mark_escrowed       SET escrow_status, total_escrowed, check_received_date, updated_at
--   request_draw        SET escrow_status, draw_amount_requested, draw_stage, updated_at
--   record_release      SET escrow_status, draw_amount_released, updated_at, and lists the
--                       draw in public.loss_draft_releases (the Draws tab): INSERT
--                       (loss_draft_id, draw_number, amount_requested, amount_released,
--                       release_date, released_at, status, notes, created_by)
--   record_holdback     SET holdback_amount, updated_at
--   mark_final_release  SET escrow_status, draw_amount_released, updated_at
-- on its public.loss_draft_tracking row, as checksops (the API login). SQL 50
-- (aws/workflows/sql/50_tranche5_write_grants.sql) grants checksops and authenticated
-- column UPDATE on loss_draft_tracking for escrow_status, check_received_date, updated_at
-- and the file's other metadata columns, but not on total_escrowed, draw_amount_requested,
-- draw_stage, draw_amount_released or holdback_amount, and no migration in this repository
-- grants INSERT on loss_draft_releases (the restored database gave checksops SELECT only,
-- aws/db-copy/sql/02_grant_readonly_application_role.sql). PostgreSQL checks table and
-- column privileges before row-level security, so without these grants the four amount
-- actions are refused (42501) before any policy is evaluated, and the Draws row is never
-- written (the API writes it in a savepoint and reports release_recorded false).
--
-- Grants, to checksops and authenticated, the roles SQL 50 grants loss_draft_tracking to:
--   UPDATE (total_escrowed, draw_amount_requested, draw_stage, draw_amount_released,
--           holdback_amount) ON TABLE public.loss_draft_tracking
--   INSERT (loss_draft_id, draw_number, amount_requested, amount_released, release_date,
--           released_at, status, notes, created_by) ON TABLE public.loss_draft_releases
-- loss_draft_releases.id defaults to gen_random_uuid() (no sequence, so no USAGE), and
-- holdback_amount, requested_at and created_at take their defaults.
--
-- Not changed: no table-wide UPDATE or INSERT; no UPDATE, DELETE, TRUNCATE, REFERENCES or
-- TRIGGER on loss_draft_releases; no SELECT (the API's draw_number subquery reads
-- loss_draft_releases with the table SELECT checksops already holds); nothing to PUBLIC or
-- anon. No policy, RLS setting, function, trigger, column or row changes:
-- aws_write_loss_draft_tracking (aws_can_write_check(check_intake_item_id)) and
-- aws_write_loss_draft_releases (aws/rls/sql/24_complete_write_policies.sql: FOR ALL TO
-- authenticated, aws_can_write_claim of the draft's claim_id) remain the authorization
-- boundary. A draft without a claim_id therefore still cannot get a Draws row: the amounts
-- are recorded on loss_draft_tracking, and widening that policy is a separate decision.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the
-- guarded SQL executor runs it inside one transaction.
-- Idempotent: GRANT is a no-op when the privilege is already held. Not applied by this
-- change: staging first, then production, through the guarded SQL path (AGENTS.md).

GRANT UPDATE (
  total_escrowed,
  draw_amount_requested,
  draw_stage,
  draw_amount_released,
  holdback_amount
) ON TABLE public.loss_draft_tracking TO checksops, authenticated;

GRANT INSERT (
  loss_draft_id,
  draw_number,
  amount_requested,
  amount_released,
  release_date,
  released_at,
  status,
  notes,
  created_by
) ON TABLE public.loss_draft_releases TO checksops, authenticated;
