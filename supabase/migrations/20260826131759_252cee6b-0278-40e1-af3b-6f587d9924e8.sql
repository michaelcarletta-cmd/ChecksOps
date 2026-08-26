DROP TRIGGER IF EXISTS backfill_chunk_outcomes_trigger ON public.claims;
DROP TRIGGER IF EXISTS trigger_capture_claim_outcome ON public.claims;
DROP TRIGGER IF EXISTS bump_intel_on_claim_file ON public.claim_files;

DROP FUNCTION IF EXISTS public.backfill_chunk_outcomes() CASCADE;
DROP FUNCTION IF EXISTS public.capture_claim_outcome() CASCADE;
DROP FUNCTION IF EXISTS public.trg_bump_on_claim_file() CASCADE;
DROP FUNCTION IF EXISTS public.trg_bump_on_argument_map() CASCADE;
DROP FUNCTION IF EXISTS public.trg_bump_on_declared_position() CASCADE;
DROP FUNCTION IF EXISTS public.bump_claim_intelligence_version(uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.find_nearest_building_footprint(double precision, double precision, double precision) CASCADE;
DROP FUNCTION IF EXISTS public.insert_building_footprints_batch(text[], text[], text[], text[], double precision[], double precision[], jsonb[], double precision[], integer[]) CASCADE;
DROP FUNCTION IF EXISTS public.match_claim_document_chunks(extensions.vector, integer, text, claim_doc_loss_type, claim_doc_trade, claim_doc_decision, claim_doc_evidence_type, uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.get_weekly_command_review() CASCADE;