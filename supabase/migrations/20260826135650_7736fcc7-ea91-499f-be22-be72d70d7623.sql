DO $$
DECLARE j record;
BEGIN
  FOR j IN SELECT jobid, jobname, command FROM cron.job LOOP
    IF j.command ~ '(automation-webhook|backfill-rebuild-events|check-scheduled-automations|claim-context-pipeline|claim-sync-webhook|claims-ai-assistant|draft-client-update|draft-escalation-artifact|execute-automations|get-claim-timeline|inbound-email|notify-client-claim-update|outlook-email-sync|process-claim-ai-action|process-follow-ups|process-jobnimbus-sync|process-rd-check-tracking|process-rd-follow-ups|process-task-follow-ups|run-claim-autopilot|scan-status-urgency|sync-claim-to-external|sync-claim-to-partner|task-reminders|telnyx-inbound-sms|workspace-sync|process-immediate-notifications|backfill-money-snapshots)' THEN
      PERFORM cron.unschedule(j.jobid);
    END IF;
  END LOOP;
EXCEPTION WHEN undefined_table OR insufficient_privilege THEN
  RAISE NOTICE 'cron schema not accessible; skipping unschedule';
END $$;

DROP TABLE IF EXISTS
  public.ai_generated_tasks,
  public.task_activity_events,
  public.task_automations,
  public.claim_microtasks,
  public.claim_automations,
  public.automation_executions,
  public.automations,
  public.workflow_automation_rules,
  public.global_automation_settings,
  public.tasks,
  public.claim_adjusters,
  public.adjusters,
  public.claim_carrier_deadlines,
  public.claim_deadlines,
  public.claim_communications_diary,
  public.claim_context_pipelines,
  public.claim_followup_log,
  public.claim_photo_findings,
  public.claim_policy_analysis,
  public.claim_warnings_log,
  public.claim_master_state,
  public.claim_events,
  public.claim_updates,
  public.claim_additional_contacts,
  public.claim_custom_field_values,
  public.custom_fields,
  public.claim_staff,
  public.claim_sub_statuses,
  public.claim_statuses,
  public.claim_partner_assignments,
  public.inspections,
  public.insurance_companies,
  public.loss_types,
  public.state_insurance_regulations,
  public.escalation_actions,
  public.escalation_artifact_templates,
  public.escalation_trigger_rules,
  public.status_urgency_rules,
  public.status_urgency_notifications_log,
  public.urgency_sms_recipients
CASCADE;

DROP FUNCTION IF EXISTS public.auto_generate_claim_microtasks() CASCADE;