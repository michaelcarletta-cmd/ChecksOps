DROP VIEW IF EXISTS public.darwin_source_accuracy_stats;

DROP FUNCTION IF EXISTS public.acquire_darwin_job(text, text, integer);
DROP FUNCTION IF EXISTS public.heartbeat_darwin_job(text, text);
DROP FUNCTION IF EXISTS public.release_darwin_job(text, text);
DROP FUNCTION IF EXISTS public.trg_bump_on_dismantler() CASCADE;

DROP TABLE IF EXISTS public.darwin_declared_position_audit_logs CASCADE;
DROP TABLE IF EXISTS public.darwin_declared_positions CASCADE;
DROP TABLE IF EXISTS public.darwin_action_log CASCADE;
DROP TABLE IF EXISTS public.darwin_analysis_results CASCADE;
DROP TABLE IF EXISTS public.darwin_estimate_lines CASCADE;
DROP TABLE IF EXISTS public.darwin_feedback_events CASCADE;
DROP TABLE IF EXISTS public.darwin_health_checks CASCADE;
DROP TABLE IF EXISTS public.darwin_jobs CASCADE;
DROP TABLE IF EXISTS public.darwin_roof_tuning_heuristics CASCADE;
DROP TABLE IF EXISTS public.darwin_sms_activity CASCADE;
DROP TABLE IF EXISTS public.darwin_sms_settings CASCADE;
DROP TABLE IF EXISTS public.learned_rules_active CASCADE;
DROP TABLE IF EXISTS public.learned_rule_candidates CASCADE;
DROP TABLE IF EXISTS public.claim_document_dismantlers CASCADE;