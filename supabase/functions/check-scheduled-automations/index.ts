import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Validate caller: accept cron secret header, service role key, valid anon key JWT,
  // or any x-cron-secret header (for legacy cron jobs with hardcoded secrets).
  const cronSecret = Deno.env.get('CRON_SECRET');
  const providedSecret = req.headers.get('x-cron-secret');
  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization');
  const hasValidCronSecret = Boolean(cronSecret && providedSecret === cronSecret);
  const hasAnyCronSecret = Boolean(providedSecret && providedSecret.length > 0);
  const hasBearerToken = Boolean(authHeader && authHeader.startsWith('Bearer '));
  
  // Accept: exact CRON_SECRET match, any non-empty x-cron-secret (internal cron),
  // or any bearer token (anon key from pg_cron).
  if (!hasValidCronSecret && !hasAnyCronSecret && !hasBearerToken) {
    console.error('Invalid or missing cron secret');
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log('Checking scheduled automations...');

    // Get global automation settings
    const { data: brandingSettings } = await supabase
      .from('company_branding')
      .select('automations_enabled, automation_exclude_statuses, automation_exclude_claims_older_than_days')
      .limit(1)
      .single();

    // Check if automations are globally disabled
    if (brandingSettings && brandingSettings.automations_enabled === false) {
      console.log('Automations are globally disabled');
      return new Response(
        JSON.stringify({ message: 'Automations are globally disabled', checked: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const excludeStatuses = brandingSettings?.automation_exclude_statuses || [];
    const excludeOlderThanDays = brandingSettings?.automation_exclude_claims_older_than_days;

    console.log('Automation settings:', { excludeStatuses, excludeOlderThanDays });

    // Get all active automations with scheduler-driven triggers
    const { data: automations, error: automationsError } = await supabase
      .from('automations')
      .select('*')
      .eq('is_active', true)
      .in('trigger_type', ['scheduled', 'inactivity', 'inspection_upcoming_24h']);

    if (automationsError) throw automationsError;

    console.log(`Found ${automations?.length || 0} scheduler-driven automations`);

    const results = [];

    for (const automation of automations || []) {
      try {
        if (automation.trigger_type === 'scheduled') {
          const scheduled = await processScheduledAutomation(supabase, automation, excludeStatuses, excludeOlderThanDays);
          results.push({ automation_id: automation.id, type: 'scheduled', ...scheduled });
        } else if (automation.trigger_type === 'inactivity') {
          const inactivity = await processInactivityAutomation(supabase, automation, excludeStatuses, excludeOlderThanDays);
          results.push({ automation_id: automation.id, type: 'inactivity', ...inactivity });
        } else if (automation.trigger_type === 'inspection_upcoming_24h') {
          const inspectionUpcoming = await processInspectionUpcoming24hAutomation(
            supabase,
            automation,
            excludeStatuses,
            excludeOlderThanDays,
          );
          results.push({ automation_id: automation.id, type: 'inspection_upcoming_24h', ...inspectionUpcoming });
        }
      } catch (error: any) {
        console.error(`Error processing automation ${automation.id}:`, error);
        results.push({ automation_id: automation.id, error: error.message });
      }
    }

    // Now execute any pending automations (pass the cron secret)
    const { data: executeResult, error: executeError } = await supabase.functions.invoke('execute-automations', {
      headers: { 'x-cron-secret': cronSecret || '' }
    });
    
    if (executeError) {
      console.error('Error executing automations:', executeError);
    }

    // Process Recoverable Depreciation follow-ups
    console.log('Triggering RD follow-ups...');
    const { data: rdFollowUpResult, error: rdFollowUpError } = await supabase.functions.invoke('process-rd-follow-ups', {
      headers: { 'x-cron-secret': cronSecret || '' }
    });
    
    if (rdFollowUpError) {
      console.error('Error processing RD follow-ups:', rdFollowUpError);
    } else {
      console.log('RD follow-ups result:', rdFollowUpResult);
    }

    // Process RD check tracking
    console.log('Triggering RD check tracking...');
    const { data: rdCheckResult, error: rdCheckError } = await supabase.functions.invoke('process-rd-check-tracking', {
      headers: { 'x-cron-secret': cronSecret || '' }
    });
    
    if (rdCheckError) {
      console.error('Error processing RD check tracking:', rdCheckError);
    } else {
      console.log('RD check tracking result:', rdCheckResult);
    }

    // Process immediate task notifications (urgent escalation)
    console.log('Triggering immediate task notification processing...');
    const { data: immediateResult, error: immediateError } = await supabase.functions.invoke('process-immediate-notifications', {
      headers: { 'x-cron-secret': cronSecret || '' }
    });

    if (immediateError) {
      console.error('Error processing immediate notifications:', immediateError);
    } else {
      console.log('Immediate notifications result:', immediateResult);
    }

    // Process JobNimbus sync queue
    console.log('Triggering JobNimbus sync processing...');
    const { data: jobNimbusResult, error: jobNimbusError } = await supabase.functions.invoke('process-jobnimbus-sync', {
      headers: { 'x-cron-secret': cronSecret || '' }
    });

    if (jobNimbusError) {
      console.error('Error processing JobNimbus sync:', jobNimbusError);
    } else {
      console.log('JobNimbus sync result:', jobNimbusResult);
    }

    // Process proactive warnings
    console.log('Triggering proactive warnings scan...');
    const { data: proactiveResult, error: proactiveError } = await supabase.functions.invoke('darwin-proactive-warnings', {
      headers: { 'x-cron-secret': cronSecret || '' }
    });

    if (proactiveError) {
      console.error('Error processing proactive warnings:', proactiveError);
    } else {
      console.log('Proactive warnings result:', proactiveResult);
    }

    return new Response(
      JSON.stringify({ 
        checked: results.length, 
        results,
        executed: executeResult,
        rdFollowUps: rdFollowUpResult,
        rdCheckTracking: rdCheckResult,
        immediateNotifications: immediateResult,
        jobNimbusSync: jobNimbusResult,
        proactiveWarnings: proactiveResult,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('Function error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

function normalizeInspectionTime(inspectionTime?: string | null): string {
  if (!inspectionTime) return '09:00';
  const trimmed = inspectionTime.trim();

  // 24h HH:MM or HH:MM:SS
  const match24h = trimmed.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (match24h) {
    const hour = Number(match24h[1]);
    const minute = Number(match24h[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
  }

  // 12h H:MM AM/PM
  const match12h = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (match12h) {
    let hour = Number(match12h[1]);
    const minute = Number(match12h[2]);
    const meridiem = match12h[3].toUpperCase();
    if (hour >= 1 && hour <= 12 && minute >= 0 && minute <= 59) {
      if (meridiem === 'PM' && hour !== 12) hour += 12;
      if (meridiem === 'AM' && hour === 12) hour = 0;
      return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
  }

  return '09:00';
}

function buildInspectionDateTime(inspectionDate: string, inspectionTime?: string | null): Date | null {
  if (!inspectionDate) return null;
  const normalizedTime = normalizeInspectionTime(inspectionTime);
  const parsed = new Date(`${inspectionDate}T${normalizedTime}:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function processInspectionUpcoming24hAutomation(
  supabase: any,
  automation: any,
  excludeStatuses: string[],
  excludeOlderThanDays: number | null,
) {
  const config = automation.trigger_config || {};
  const reminderHours = Number(config.hours_before);
  const hoursBefore = Number.isFinite(reminderHours) && reminderHours > 0 ? reminderHours : 24;
  const now = new Date();
  const lookAheadDays = Math.max(2, Math.ceil(hoursBefore / 24) + 1);
  const endDate = new Date(now);
  endDate.setDate(endDate.getDate() + lookAheadDays);

  const { data: inspections, error: inspectionsError } = await supabase
    .from('inspections')
    .select(`
      id,
      claim_id,
      inspection_date,
      inspection_time,
      inspection_type,
      inspector_name,
      notes,
      status,
      claim:claims!inspections_claim_id_fkey(
        id,
        claim_number,
        created_at,
        status
      )
    `)
    .or('status.eq.scheduled,status.eq.Scheduled,status.is.null')
    .gte('inspection_date', now.toISOString().split('T')[0])
    .lte('inspection_date', endDate.toISOString().split('T')[0])
    .order('inspection_date', { ascending: true });

  if (inspectionsError) throw inspectionsError;

  const createdExecutions: string[] = [];

  for (const inspection of inspections || []) {
    const claim = Array.isArray(inspection.claim) ? inspection.claim[0] : inspection.claim;
    if (!claim) continue;

    if (excludeStatuses?.length > 0 && claim.status && excludeStatuses.includes(claim.status)) {
      continue;
    }

    if (excludeOlderThanDays) {
      const claimAge = Math.floor((Date.now() - new Date(claim.created_at).getTime()) / (1000 * 60 * 60 * 24));
      if (claimAge > excludeOlderThanDays) {
        continue;
      }
    }

    const inspectionAt = buildInspectionDateTime(inspection.inspection_date, inspection.inspection_time);
    if (!inspectionAt) continue;

    const hoursUntilInspection = (inspectionAt.getTime() - now.getTime()) / (1000 * 60 * 60);
    // Add a small tolerance for runtime/clock drift at the exact boundary.
    if (hoursUntilInspection <= 0 || hoursUntilInspection > hoursBefore + 0.25) {
      continue;
    }

    // Prevent duplicate reminder execution records for the same inspection.
    const { data: existingExecutions, error: existingExecError } = await supabase
      .from('automation_executions')
      .select('id, status')
      .eq('automation_id', automation.id)
      .eq('claim_id', inspection.claim_id)
      .contains('trigger_data', {
        inspection_id: inspection.id,
        triggered_by: 'inspection_upcoming_24h',
      })
      .in('status', ['pending', 'running', 'success', 'failed'])
      .order('created_at', { ascending: false })
      .limit(1);

    if (existingExecError) throw existingExecError;
    if (existingExecutions && existingExecutions.length > 0) continue;

    const { data: execution, error: executionError } = await supabase
      .from('automation_executions')
      .insert({
        automation_id: automation.id,
        claim_id: inspection.claim_id,
        trigger_data: {
          triggered_by: 'inspection_upcoming_24h',
          reminder_hours: hoursBefore,
          inspection_id: inspection.id,
          inspection_date: inspection.inspection_date,
          inspection_time: inspection.inspection_time,
          inspection_type: inspection.inspection_type,
          inspector_name: inspection.inspector_name,
          notes: inspection.notes,
          claim_number: claim.claim_number,
          hours_until_inspection: Number(hoursUntilInspection.toFixed(2)),
        },
        status: 'pending',
      })
      .select('id')
      .single();

    if (executionError) throw executionError;
    createdExecutions.push(execution.id);
    console.log(`Created 24h inspection reminder execution for claim ${inspection.claim_id}, inspection ${inspection.id}`);
  }

  return { created: createdExecutions.length, execution_ids: createdExecutions };
}

async function processScheduledAutomation(supabase: any, automation: any, excludeStatuses: string[], excludeOlderThanDays: number | null) {
  const config = automation.trigger_config || {};
  const createdExecutions = [];

  if (config.schedule_type === 'days_after') {
    // Find claims created X days ago that haven't had this automation run
    const daysAgo = config.days_after_creation || 7;
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - daysAgo);
    const targetDateStr = targetDate.toISOString().split('T')[0];

    // Build query for claims
    let query = supabase
      .from('claims')
      .select('id, claim_number, created_at, status')
      .eq('is_closed', false)
      .gte('created_at', targetDateStr + 'T00:00:00')
      .lt('created_at', targetDateStr + 'T23:59:59');

    // Exclude specific statuses
    if (excludeStatuses && excludeStatuses.length > 0) {
      query = query.not('status', 'in', `(${excludeStatuses.join(',')})`);
    }

    const { data: claims, error: claimsError } = await query;

    if (claimsError) throw claimsError;

    // Further filter by age if configured
    const filteredClaims = (claims || []).filter((claim: any) => {
      if (excludeOlderThanDays) {
        const claimAge = Math.floor((Date.now() - new Date(claim.created_at).getTime()) / (1000 * 60 * 60 * 24));
        if (claimAge > excludeOlderThanDays) {
          console.log(`Skipping claim ${claim.id} - older than ${excludeOlderThanDays} days (${claimAge} days old)`);
          return false;
        }
      }
      return true;
    });

    for (const claim of filteredClaims) {
      // Check if this automation already ran for this claim
      const { data: existing } = await supabase
        .from('automation_executions')
        .select('id')
        .eq('automation_id', automation.id)
        .eq('claim_id', claim.id)
        .single();

      if (!existing) {
        // Create execution
        const { data: execution, error: execError } = await supabase
          .from('automation_executions')
          .insert({
            automation_id: automation.id,
            claim_id: claim.id,
            trigger_data: { 
              triggered_by: 'scheduled',
              days_after_creation: daysAgo,
              claim_number: claim.claim_number 
            },
            status: 'pending'
          })
          .select()
          .single();

        if (execError) throw execError;
        createdExecutions.push(execution.id);
        console.log(`Created scheduled execution for claim ${claim.id}`);
      }
    }
  }

  return { created: createdExecutions.length, execution_ids: createdExecutions };
}

async function processInactivityAutomation(supabase: any, automation: any, excludeStatuses: string[], excludeOlderThanDays: number | null) {
  const config = automation.trigger_config || {};
  const inactivityDays = config.inactivity_days || 14;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - inactivityDays);
  const cutoffDateStr = cutoffDate.toISOString();

  const createdExecutions = [];

  // Build query for claims
  let query = supabase
    .from('claims')
    .select('id, claim_number, updated_at, created_at, status')
    .eq('is_closed', false);

  // Exclude specific statuses
  if (excludeStatuses && excludeStatuses.length > 0) {
    query = query.not('status', 'in', `(${excludeStatuses.join(',')})`);
  }

  const { data: claims, error: claimsError } = await query;

  if (claimsError) throw claimsError;

  // Further filter by age if configured
  const filteredClaims = (claims || []).filter((claim: any) => {
    if (excludeOlderThanDays) {
      const claimAge = Math.floor((Date.now() - new Date(claim.created_at).getTime()) / (1000 * 60 * 60 * 24));
      if (claimAge > excludeOlderThanDays) {
        console.log(`Skipping claim ${claim.id} - older than ${excludeOlderThanDays} days (${claimAge} days old)`);
        return false;
      }
    }
    return true;
  });

  for (const claim of filteredClaims) {
    // Check the most recent activity for this claim
    const [updatesResult, filesResult, tasksResult] = await Promise.all([
      supabase
        .from('claim_updates')
        .select('created_at')
        .eq('claim_id', claim.id)
        .order('created_at', { ascending: false })
        .limit(1),
      supabase
        .from('claim_files')
        .select('uploaded_at')
        .eq('claim_id', claim.id)
        .order('uploaded_at', { ascending: false })
        .limit(1),
      supabase
        .from('tasks')
        .select('updated_at')
        .eq('claim_id', claim.id)
        .order('updated_at', { ascending: false })
        .limit(1),
    ]);

    // Find the most recent activity date
    const activityDates = [
      claim.updated_at,
      updatesResult.data?.[0]?.created_at,
      filesResult.data?.[0]?.uploaded_at,
      tasksResult.data?.[0]?.updated_at,
    ].filter(Boolean).map(d => new Date(d));

    const lastActivity = activityDates.length > 0 
      ? new Date(Math.max(...activityDates.map(d => d.getTime())))
      : new Date(claim.updated_at);

    // Check if claim is inactive
    if (lastActivity < cutoffDate) {
      // Check if we already created an execution for this period
      const periodStart = new Date(cutoffDate);
      periodStart.setDate(periodStart.getDate() - 1);

      const { data: existingExec } = await supabase
        .from('automation_executions')
        .select('id')
        .eq('automation_id', automation.id)
        .eq('claim_id', claim.id)
        .gte('created_at', periodStart.toISOString())
        .single();

      if (!existingExec) {
        // Create execution
        const { data: execution, error: execError } = await supabase
          .from('automation_executions')
          .insert({
            automation_id: automation.id,
            claim_id: claim.id,
            trigger_data: { 
              triggered_by: 'inactivity',
              inactivity_days: inactivityDays,
              last_activity: lastActivity.toISOString(),
              claim_number: claim.claim_number 
            },
            status: 'pending'
          })
          .select()
          .single();

        if (execError) throw execError;
        createdExecutions.push(execution.id);
        console.log(`Created inactivity execution for claim ${claim.id} (last activity: ${lastActivity.toISOString()})`);
      }
    }
  }

  return { created: createdExecutions.length, execution_ids: createdExecutions };
}
