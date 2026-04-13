import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Keywords that should trigger escalation
const ESCALATION_KEYWORDS = [
  'lawsuit', 'attorney', 'lawyer', 'legal action', 'litigation',
  'bad faith', 'sue', 'court', 'complaint', 'demand letter'
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    console.log("Darwin Autonomous Agent starting...");

    // Get all claims with autonomy enabled
    const { data: automatedClaims, error: fetchError } = await supabase
      .from('claim_automations')
      .select(`
        *,
        claims(
          id,
          claim_number,
          policyholder_name,
          status,
          is_closed,
          insurance_company,
          created_at
        )
      `)
      .eq('is_enabled', true)
      .in('autonomy_level', ['semi_autonomous', 'fully_autonomous']);

    if (fetchError) {
      console.error("Failed to fetch automated claims:", fetchError);
      throw fetchError;
    }

    console.log(`Found ${automatedClaims?.length || 0} claims with autonomy enabled`);

    const results = {
      processed: 0,
      tasks_completed: 0,
      emails_sent: 0,
      escalations: 0,
      documents_processed: 0,
      errors: [] as string[],
    };

    // Get claim IDs for document processing
    const claimIds = automatedClaims?.map(a => a.claims?.id).filter(Boolean) || [];

    // Process unclassified documents for autonomous claims
    if (claimIds.length > 0) {
      await processUnclassifiedDocuments(supabase, claimIds, results);
    }

    const CLOSED_STATUSES = ['Claim Settled', 'Dead File', 'Closed'];

    for (const automation of automatedClaims || []) {
      const claim = automation.claims;
      if (!claim) continue;

      // Skip closed/settled claims entirely
      if (claim.is_closed || CLOSED_STATUSES.includes(claim.status)) {
        console.log(`Skipping claim ${claim.claim_number} - status: ${claim.status} (closed/settled)`);
        continue;
      }

      // Calculate claim age in days
      const claimCreatedAt = claim.created_at ? new Date(claim.created_at) : null;
      const claimAgeDays = claimCreatedAt
        ? (Date.now() - claimCreatedAt.getTime()) / (1000 * 60 * 60 * 24)
        : Infinity;
      const NEW_CLAIM_GRACE_PERIOD_DAYS = 7;
      const isNewClaim = claimAgeDays < NEW_CLAIM_GRACE_PERIOD_DAYS;

      if (isNewClaim) {
        console.log(`Skipping claim ${claim.claim_number} - created ${Math.round(claimAgeDays)}d ago (grace period: ${NEW_CLAIM_GRACE_PERIOD_DAYS}d)`);
        continue;
      }

      try {
        console.log(`Processing claim ${claim.claim_number}...`);

        // Check daily action limit
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const { count: todayActions } = await supabase
          .from('darwin_action_log')
          .select('*', { count: 'exact', head: true })
          .eq('claim_id', claim.id)
          .eq('was_auto_executed', true)
          .gte('executed_at', today.toISOString());

        if ((todayActions || 0) >= (automation.daily_action_limit || 10)) {
          console.log(`Claim ${claim.claim_number} hit daily action limit`);
          continue;
        }

        // 1. AUTO-COMPLETE TASKS (if enabled OR semi/fully autonomous)
        if (automation.auto_complete_tasks || ['semi_autonomous', 'fully_autonomous'].includes(automation.autonomy_level)) {
          await processAutoCompleteTasks(supabase, claim.id, results);
        }

        // 2. AUTO-SEND PENDING EMAILS (if semi or fully autonomous)
        // Semi-autonomous: auto-send to clients/contractors, queue insurance emails
        // Fully autonomous: auto-send everything
        if (['semi_autonomous', 'fully_autonomous'].includes(automation.autonomy_level)) {
          await processAutoSendEmails(supabase, claim.id, automation, results);
        }

        // 3. CHECK FOR ESCALATIONS (if enabled)
        if (automation.auto_escalate_urgency) {
          await checkForEscalations(supabase, claim.id, automation, results);
        }

        // 4. SMART CARRIER FOLLOW-UPS (only when awaiting carrier response)
        await processSmartCarrierFollowUp(supabase, claim, automation, results);

        // 5. BI-WEEKLY IDLE CLAIM UPDATES (client updates when no activity)
        await processIdleClaimUpdates(supabase, claim, automation, results);

        results.processed++;
      } catch (err) {
        const errorMsg = `Error processing claim ${claim.claim_number}: ${err}`;
        console.error(errorMsg);
        results.errors.push(errorMsg);
      }
    }

    console.log("Darwin Autonomous Agent completed:", results);

    return new Response(
      JSON.stringify({ success: true, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Darwin Autonomous Agent error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

async function processAutoCompleteTasks(
  supabase: any,
  claimId: string,
  results: any
) {
  // Find follow-up tasks that should be auto-completed
  const { data: followUpTasks } = await supabase
    .from('tasks')
    .select('*')
    .eq('claim_id', claimId)
    .neq('status', 'completed')
    .or('title.ilike.%follow up%,title.ilike.%follow-up%,title.ilike.%reminder%');

  for (const task of followUpTasks || []) {
    // Check if there's been recent activity (email received) that would complete this task
    const { data: recentEmails } = await supabase
      .from('emails')
      .select('id')
      .eq('claim_id', claimId)
      .eq('recipient_type', 'inbound')
      .gte('sent_at', task.created_at)
      .limit(1);

    if (recentEmails && recentEmails.length > 0) {
      // Auto-complete the task
      await supabase
        .from('tasks')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
        })
        .eq('id', task.id);

      // Log the action
      await supabase
        .from('darwin_action_log')
        .insert({
          claim_id: claimId,
          action_type: 'task_completed',
          action_details: { task_id: task.id, task_title: task.title, reason: 'response_received' },
          was_auto_executed: true,
          result: `Auto-completed task "${task.title}" - response received`,
          trigger_source: 'darwin_autonomous_agent',
        });

      results.tasks_completed++;
    }
  }
}

async function processAutoSendEmails(
  supabase: any,
  claimId: string,
  automation: any,
  results: any
) {
  const isFullyAutonomous = automation.autonomy_level === 'fully_autonomous';
  
  // Insurance-related recipient types that require human review for semi-autonomous
  const INSURANCE_RECIPIENT_TYPES = [
    'adjuster', 
    'insurance', 
    'insurance company', 
    'primary adjuster',
    'carrier'
  ];

  // Find pending email drafts that can be auto-sent
  const { data: pendingActions } = await supabase
    .from('claim_ai_pending_actions')
    .select('*')
    .eq('claim_id', claimId)
    .eq('status', 'pending')
    .eq('action_type', 'email_response');

  for (const action of pendingActions || []) {
    const draft = action.draft_content as any;
    const recipientType = (draft.recipient_type || '').toLowerCase();
    
    // Check if this is an insurance email
    const isInsuranceEmail = INSURANCE_RECIPIENT_TYPES.some(type => 
      recipientType.includes(type.toLowerCase())
    );
    
    // For semi-autonomous: skip insurance emails (require human review)
    if (!isFullyAutonomous && isInsuranceEmail) {
      console.log(`Skipping insurance email for semi-autonomous: ${draft.to_email}`);
      
      // Log that this requires human review
      await supabase.from('darwin_action_log').insert({
        claim_id: claimId,
        action_type: 'pending_review',
        action_details: { 
          pending_action_id: action.id,
          reason: 'insurance_email_requires_review',
          recipient_type: recipientType,
          to_email: draft.to_email
        },
        was_auto_executed: false,
        result: `Email to insurance (${draft.to_email}) queued for human review`,
        trigger_source: 'darwin_autonomous_agent',
      });
      
      results.escalations++;
      continue;
    }
    
    // Check for keyword blockers
    const content = `${draft.subject || ''} ${draft.body || ''}`.toLowerCase();
    const keywordBlockers = automation.keyword_blockers || ESCALATION_KEYWORDS;
    
    const blockedKeyword = keywordBlockers.find((kw: string) => 
      content.includes(kw.toLowerCase())
    );

    if (blockedKeyword) {
      // Create escalation instead of auto-sending
      await supabase
        .from('darwin_action_log')
        .insert({
          claim_id: claimId,
          action_type: 'escalation',
          action_details: { 
            pending_action_id: action.id, 
            blocked_keyword: blockedKeyword,
            draft_subject: draft.subject 
          },
          was_auto_executed: false,
          result: `Email blocked due to keyword "${blockedKeyword}" - requires human review`,
          trigger_source: 'darwin_autonomous_agent',
        });

      results.escalations++;
      continue;
    }

    // Auto-send the email
    try {
      const sendResponse = await fetch(
        `${Deno.env.get('SUPABASE_URL')}/functions/v1/send-email`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            recipients: [{ email: draft.to_email, name: draft.to_name }],
            subject: draft.subject,
            body: draft.body,
            claimId: claimId,
          }),
        }
      );

      if (sendResponse.ok) {
        // Update pending action as auto-executed
        await supabase
          .from('claim_ai_pending_actions')
          .update({
            status: 'sent',
            auto_executed: true,
            auto_executed_at: new Date().toISOString(),
          })
          .eq('id', action.id);

        // Log the action
        await supabase
          .from('darwin_action_log')
          .insert({
            claim_id: claimId,
            action_type: 'email_sent',
            action_details: { 
              pending_action_id: action.id, 
              to: draft.to_email,
              subject: draft.subject,
              recipient_type: recipientType
            },
            was_auto_executed: true,
            result: `Auto-sent email to ${recipientType || 'recipient'} (${draft.to_email}): ${draft.subject}`,
            trigger_source: 'darwin_autonomous_agent',
          });

        results.emails_sent++;
      }
    } catch (err) {
      console.error(`Failed to auto-send email for action ${action.id}:`, err);
    }
  }

  // Also process pending SMS for semi/fully autonomous
  await processAutoSendSMS(supabase, claimId, automation, results);
}

// Process auto-send SMS for semi/fully autonomous claims
async function processAutoSendSMS(
  supabase: any,
  claimId: string,
  automation: any,
  results: any
) {
  const isFullyAutonomous = automation.autonomy_level === 'fully_autonomous';

  // Find pending SMS drafts
  const { data: pendingActions } = await supabase
    .from('claim_ai_pending_actions')
    .select('*')
    .eq('claim_id', claimId)
    .eq('status', 'pending')
    .eq('action_type', 'sms');

  for (const action of pendingActions || []) {
    const draft = action.draft_content as any;
    const recipientType = (draft.recipient_type || '').toLowerCase();
    
    // For semi-autonomous: only auto-send SMS to clients, not adjusters/insurance
    const isInsuranceSMS = recipientType.includes('adjuster') || recipientType.includes('insurance');
    
    if (!isFullyAutonomous && isInsuranceSMS) {
      console.log(`Skipping insurance SMS for semi-autonomous: ${draft.to_number}`);
      
      await supabase.from('darwin_action_log').insert({
        claim_id: claimId,
        action_type: 'pending_review',
        action_details: { 
          pending_action_id: action.id,
          reason: 'insurance_sms_requires_review',
          recipient_type: recipientType,
          to_number: draft.to_number
        },
        was_auto_executed: false,
        result: `SMS to insurance (${draft.to_number}) queued for human review`,
        trigger_source: 'darwin_autonomous_agent',
      });
      
      results.escalations++;
      continue;
    }

    // Check for keyword blockers in SMS
    const content = (draft.message || '').toLowerCase();
    const keywordBlockers = automation.keyword_blockers || ESCALATION_KEYWORDS;
    
    const blockedKeyword = keywordBlockers.find((kw: string) => 
      content.includes(kw.toLowerCase())
    );

    if (blockedKeyword) {
      await supabase
        .from('darwin_action_log')
        .insert({
          claim_id: claimId,
          action_type: 'escalation',
          action_details: { 
            pending_action_id: action.id, 
            blocked_keyword: blockedKeyword,
          },
          was_auto_executed: false,
          result: `SMS blocked due to keyword "${blockedKeyword}" - requires human review`,
          trigger_source: 'darwin_autonomous_agent',
        });

      results.escalations++;
      continue;
    }

    // Auto-send the SMS
    try {
      const smsResponse = await fetch(
        `${Deno.env.get('SUPABASE_URL')}/functions/v1/send-sms`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            claimId: claimId,
            toNumber: draft.to_number,
            messageBody: draft.message,
          }),
        }
      );

      if (smsResponse.ok) {
        await supabase
          .from('claim_ai_pending_actions')
          .update({
            status: 'sent',
            auto_executed: true,
            auto_executed_at: new Date().toISOString(),
          })
          .eq('id', action.id);

        await supabase
          .from('darwin_action_log')
          .insert({
            claim_id: claimId,
            action_type: 'sms_sent',
            action_details: { 
              pending_action_id: action.id, 
              to: draft.to_number,
              recipient_type: recipientType
            },
            was_auto_executed: true,
            result: `Auto-sent SMS to ${recipientType || 'recipient'} (${draft.to_number})`,
            trigger_source: 'darwin_autonomous_agent',
          });

        results.emails_sent++; // Reusing count for simplicity
      }
    } catch (err) {
      console.error(`Failed to auto-send SMS for action ${action.id}:`, err);
    }
  }
}

async function checkForEscalations(
  supabase: any,
  claimId: string,
  automation: any,
  results: any
) {
  // Check for stalled claims (no activity in X days)
  const stalledDays = 7;
  const stalledDate = new Date();
  stalledDate.setDate(stalledDate.getDate() - stalledDays);

  const { data: recentActivity } = await supabase
    .from('claim_updates')
    .select('id')
    .eq('claim_id', claimId)
    .gte('created_at', stalledDate.toISOString())
    .limit(1);

  if (!recentActivity || recentActivity.length === 0) {
    // Check if we already escalated for this
    const { data: existingEscalation } = await supabase
      .from('darwin_action_log')
      .select('id')
      .eq('claim_id', claimId)
      .eq('action_type', 'escalation')
      .contains('action_details', { reason: 'stalled_claim' })
      .gte('executed_at', stalledDate.toISOString())
      .limit(1);

    if (!existingEscalation || existingEscalation.length === 0) {
      await supabase
        .from('darwin_action_log')
        .insert({
          claim_id: claimId,
          action_type: 'escalation',
          action_details: { reason: 'stalled_claim', days_inactive: stalledDays },
          was_auto_executed: true,
          result: `Claim has had no activity for ${stalledDays} days - needs attention`,
          trigger_source: 'darwin_autonomous_agent',
        });

      results.escalations++;
    }
  }

  // Check for approaching deadlines
  const { data: upcomingDeadlines } = await supabase
    .from('claim_carrier_deadlines')
    .select('*')
    .eq('claim_id', claimId)
    .eq('status', 'pending')
    .lte('deadline_date', new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString())
    .gte('deadline_date', new Date().toISOString());

  for (const deadline of upcomingDeadlines || []) {
    const { data: existingEscalation } = await supabase
      .from('darwin_action_log')
      .select('id')
      .eq('claim_id', claimId)
      .eq('action_type', 'escalation')
      .contains('action_details', { deadline_id: deadline.id })
      .limit(1);

    if (!existingEscalation || existingEscalation.length === 0) {
      await supabase
        .from('darwin_action_log')
        .insert({
          claim_id: claimId,
          action_type: 'escalation',
          action_details: { 
            reason: 'approaching_deadline',
            deadline_id: deadline.id,
            deadline_type: deadline.deadline_type,
            deadline_date: deadline.deadline_date
          },
          was_auto_executed: true,
          result: `Deadline approaching: ${deadline.deadline_type} due ${deadline.deadline_date}`,
          trigger_source: 'darwin_autonomous_agent',
        });

      results.escalations++;
    }
  }
}

// Process unclassified documents for autonomous claims
async function processUnclassifiedDocuments(
  supabase: any,
  claimIds: string[],
  results: any
) {
  console.log(`Checking for unprocessed documents across ${claimIds.length} claims...`);

  // Find unprocessed files for these claims (limit to 10 per run)
  const { data: unprocessedFiles, error } = await supabase
    .from('claim_files')
    .select('id, claim_id, file_name, file_path, file_type, extracted_text')
    .in('claim_id', claimIds)
    .is('document_classification', null)
    .or('processed_by_darwin.is.null,processed_by_darwin.eq.false')
    .limit(10);

  if (error) {
    console.error('Error fetching unprocessed files:', error);
    return;
  }

  console.log(`Found ${unprocessedFiles?.length || 0} unprocessed documents`);

  for (const file of unprocessedFiles || []) {
    try {
      // Skip photos and very small files
      if (file.file_type?.includes('image') || file.file_name?.match(/\.(jpg|jpeg|png|gif|heic)$/i)) {
        // Just mark as processed with 'photo' classification
        await supabase
          .from('claim_files')
          .update({
            document_classification: 'photo',
            classification_confidence: 1.0,
            classification_metadata: { method: 'file_type', summary: 'Photo file' },
            processed_by_darwin: true,
            darwin_processed_at: new Date().toISOString(),
          })
          .eq('id', file.id);
        
        results.documents_processed++;
        continue;
      }

      // Call darwin-process-document function
      const response = await fetch(
        `${Deno.env.get('SUPABASE_URL')}/functions/v1/darwin-process-document`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ fileId: file.id }),
        }
      );

      if (response.ok) {
        const result = await response.json();
        console.log(`Processed ${file.file_name}: ${result.classification} (${Math.round((result.confidence || 0) * 100)}%)`);
        results.documents_processed++;
      } else {
        console.error(`Failed to process ${file.file_name}: ${response.status}`);
      }
    } catch (err) {
      console.error(`Error processing file ${file.id}:`, err);
    }
  }
}

// Statuses that indicate we're waiting on the carrier
const AWAITING_CARRIER_STATUSES = [
  'submitted to insurance',
  'awaiting initial response',
  'awaiting adjuster assignment',
  'supplement submitted',
  'awaiting supplement response',
  'rfi submitted',
  'awaiting rfi response',
  'under review',
  'inspection scheduled',
  'pending carrier response'
];

// Smart carrier follow-up: only send if we're actually waiting on carrier response
async function processSmartCarrierFollowUp(
  supabase: any,
  claim: any,
  automation: any,
  results: any
) {
  const claimStatus = (claim.status || '').toLowerCase();
  
  // Check if this claim is in a status that indicates we're waiting on carrier
  const isAwaitingCarrier = AWAITING_CARRIER_STATUSES.some(s => 
    claimStatus.includes(s.toLowerCase()) || s.toLowerCase().includes(claimStatus)
  );
  
  if (!isAwaitingCarrier) {
    return; // No follow-up needed - not waiting on carrier
  }
  
  // Check when we last contacted the carrier
  const { data: lastCarrierEmail } = await supabase
    .from('emails')
    .select('id, sent_at, subject')
    .eq('claim_id', claim.id)
    .neq('recipient_type', 'inbound')
    .or('recipient_type.eq.adjuster,recipient_type.eq.insurance,recipient_type.ilike.%carrier%')
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  
  // Default follow-up interval: 5 business days (7 calendar days)
  const followUpIntervalDays = automation.follow_up_interval_days || 7;
  const followUpThreshold = new Date();
  followUpThreshold.setDate(followUpThreshold.getDate() - followUpIntervalDays);
  
  // No carrier email sent, or last email is older than threshold
  const shouldFollowUp = !lastCarrierEmail || new Date(lastCarrierEmail.sent_at) < followUpThreshold;
  
  if (!shouldFollowUp) {
    return; // Recent contact exists, no follow-up needed
  }
  
  // Check if we already sent a follow-up today
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const { data: recentFollowUp } = await supabase
    .from('darwin_action_log')
    .select('id')
    .eq('claim_id', claim.id)
    .eq('action_type', 'carrier_follow_up')
    .gte('executed_at', today.toISOString())
    .limit(1);
  
  if (recentFollowUp && recentFollowUp.length > 0) {
    return; // Already followed up today
  }
  
  // Get claim details for email
  const { data: fullClaim } = await supabase
    .from('claims')
    .select('*, claim_adjusters(adjuster_name, adjuster_email)')
    .eq('id', claim.id)
    .single();
  
  const adjuster = fullClaim?.claim_adjusters?.[0];
  const recipientEmail = adjuster?.adjuster_email || fullClaim?.adjuster_email;
  const recipientName = adjuster?.adjuster_name || fullClaim?.adjuster_name || 'Claims Department';
  
  if (!recipientEmail) {
    console.log(`Claim ${claim.claim_number}: No adjuster email for carrier follow-up`);
    return;
  }
  
  // Generate follow-up email using central AI service
  const { callOpenAI } = await import("../_shared/ai/openaiClient.ts");
  
  const daysSinceLastContact = lastCarrierEmail 
    ? Math.floor((Date.now() - new Date(lastCarrierEmail.sent_at).getTime()) / (1000 * 60 * 60 * 24))
    : 'unknown';
  
  const systemPrompt = `You are a professional public adjuster assistant for Freedom Claims. Generate a brief, professional follow-up email to the insurance carrier.

CLAIM CONTEXT:
- Claim Number: ${claim.claim_number || 'N/A'}
- Policyholder: ${fullClaim?.policyholder_name || 'N/A'}
- Insurance Company: ${fullClaim?.insurance_company || 'N/A'}
- Current Status: ${claim.status || 'N/A'}
- Days Since Last Contact: ${daysSinceLastContact}
- Last Email Subject: ${lastCarrierEmail?.subject || 'Initial submission'}

GUIDELINES:
1. Be professional and assertive but polite
2. Reference the claim number and policyholder
3. Request a status update or response timeline
4. Mention relevant state prompt payment laws if applicable
5. Keep it concise (under 150 words)
6. Sign off as "Freedom Claims Team"

Do NOT include a subject line - just the email body.`;

  try {
    const aiResult = await callOpenAI({
      model: 'gpt-4o-mini',
      system: systemPrompt,
      user: 'Generate a carrier follow-up email requesting a status update.',
      temperature: 0.7,
    });

    const emailBody = aiResult.text;
    const subject = `Follow-Up: Claim ${claim.claim_number} - ${fullClaim?.policyholder_name || 'Status Request'}`;

    // Create pending action for review (or auto-send if fully autonomous)
    const isFullyAutonomous = automation.autonomy_level === 'fully_autonomous';
    
    if (isFullyAutonomous) {
      // Auto-send the follow-up
      const sendResponse = await fetch(
        `${Deno.env.get('SUPABASE_URL')}/functions/v1/send-email`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            recipients: [{ email: recipientEmail, name: recipientName, type: 'adjuster' }],
            subject,
            body: emailBody,
            claimId: claim.id,
          }),
        }
      );

      if (sendResponse.ok) {
        await supabase.from('darwin_action_log').insert({
          claim_id: claim.id,
          action_type: 'carrier_follow_up',
          action_details: { 
            to: recipientEmail,
            subject,
            days_since_contact: daysSinceLastContact,
            auto_sent: true
          },
          was_auto_executed: true,
          result: `Auto-sent carrier follow-up to ${recipientEmail}`,
          trigger_source: 'darwin_autonomous_agent',
        });
        results.emails_sent++;
      }
    } else {
      // Queue for human review (semi-autonomous)
      await supabase.from('claim_ai_pending_actions').insert({
        claim_id: claim.id,
        action_type: 'email_response',
        draft_content: {
          to_email: recipientEmail,
          to_name: recipientName,
          subject,
          body: emailBody,
          recipient_type: 'adjuster'
        },
        ai_reasoning: `Automatic carrier follow-up: ${daysSinceLastContact} days since last contact. Status: ${claim.status}`,
        status: 'pending',
      });
      
      await supabase.from('darwin_action_log').insert({
        claim_id: claim.id,
        action_type: 'carrier_follow_up',
        action_details: { 
          to: recipientEmail,
          subject,
          days_since_contact: daysSinceLastContact,
          queued_for_review: true
        },
        was_auto_executed: false,
        result: `Carrier follow-up drafted for review (${daysSinceLastContact} days since contact)`,
        trigger_source: 'darwin_autonomous_agent',
      });
      results.escalations++;
    }
    
    console.log(`Carrier follow-up ${isFullyAutonomous ? 'sent' : 'queued'} for claim ${claim.claim_number}`);
    
  } catch (err) {
    console.error(`Error creating carrier follow-up for claim ${claim.claim_number}:`, err);
  }
}

// Bi-weekly idle claim updates: send client updates when no activity for 2 weeks
async function processIdleClaimUpdates(
  supabase: any,
  claim: any,
  automation: any,
  results: any
) {
  const idleThresholdDays = 14; // 2 weeks
  const idleThreshold = new Date();
  idleThreshold.setDate(idleThreshold.getDate() - idleThresholdDays);

  // Safety: never send idle updates for claims younger than the idle threshold
  const { data: claimAge } = await supabase
    .from('claims')
    .select('created_at')
    .eq('id', claim.id)
    .single();

  if (claimAge?.created_at) {
    const claimCreated = new Date(claimAge.created_at);
    if (claimCreated > idleThreshold) {
      console.log(`Claim ${claim.claim_number}: too new for idle updates (created ${claimCreated.toISOString()})`);
      return;
    }
  }
  
  // Check for any recent activity
  const { data: recentActivity } = await supabase
    .from('claim_updates')
    .select('id')
    .eq('claim_id', claim.id)
    .gte('created_at', idleThreshold.toISOString())
    .limit(1);
  
  const { data: recentEmails } = await supabase
    .from('emails')
    .select('id')
    .eq('claim_id', claim.id)
    .gte('sent_at', idleThreshold.toISOString())
    .limit(1);
  
  const hasRecentActivity = (recentActivity?.length || 0) > 0 || (recentEmails?.length || 0) > 0;
  
  if (hasRecentActivity) {
    return; // Not idle
  }
  
  // Check if we already sent an idle update recently (within past week)
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  
  const { data: recentIdleUpdate } = await supabase
    .from('darwin_action_log')
    .select('id')
    .eq('claim_id', claim.id)
    .eq('action_type', 'idle_claim_update')
    .gte('executed_at', weekAgo.toISOString())
    .limit(1);
  
  if (recentIdleUpdate && recentIdleUpdate.length > 0) {
    return; // Already sent idle update recently
  }
  
  // Get claim details including client email
  const { data: fullClaim } = await supabase
    .from('claims')
    .select('*')
    .eq('id', claim.id)
    .single();
  
  const clientEmail = fullClaim?.policyholder_email;
  const clientName = fullClaim?.policyholder_name || 'there';
  
  if (!clientEmail) {
    console.log(`Claim ${claim.claim_number}: No client email for idle update`);
    return;
  }
  
  // Get open tasks to summarize what we're waiting on
  const { data: openTasks } = await supabase
    .from('tasks')
    .select('title, description, priority')
    .eq('claim_id', claim.id)
    .neq('status', 'completed')
    .order('priority', { ascending: true })
    .limit(5);
  
  // Get recent notes for context
  const { data: recentNotes } = await supabase
    .from('claim_updates')
    .select('content, created_at')
    .eq('claim_id', claim.id)
    .order('created_at', { ascending: false })
    .limit(3);
  
  // Generate client update email using AI
  const openaiApiKey = Deno.env.get('OPENAI_API_KEY');
  if (!openaiApiKey) {
    console.error('OPENAI_API_KEY not configured for idle update');
    return;
  }
  
  const taskSummary = openTasks?.length 
    ? openTasks.map((t: any) => `- ${t.title}`).join('\n')
    : 'No specific pending tasks';
  
  const notesSummary = recentNotes?.length
    ? recentNotes.map((n: any) => `- ${n.content?.substring(0, 100)}...`).join('\n')
    : 'No recent notes';
  
  const systemPrompt = `You are a professional public adjuster assistant for Freedom Claims. Generate a warm, empathetic client update email for a claim that has had no recent activity.

CLAIM CONTEXT:
- Claim Number: ${claim.claim_number || 'N/A'}
- Client Name: ${clientName}
- Insurance Company: ${fullClaim?.insurance_company || 'N/A'}
- Current Status: ${claim.status || 'N/A'}
- Loss Type: ${fullClaim?.loss_type || 'N/A'}

PENDING TASKS:
${taskSummary}

RECENT NOTES:
${notesSummary}

GUIDELINES:
1. Be warm, empathetic, and reassuring - acknowledge this is a stressful time
2. Briefly explain what we're currently waiting on (based on tasks/status)
3. Assure them we're actively monitoring their claim
4. Invite them to reach out with any questions
5. Keep it concise (under 150 words)
6. Use a friendly but professional tone
7. Sign off as "Freedom Claims Team"

Do NOT include a subject line - just the email body.`;

  try {
    const aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Generate a client update email explaining what we\'re waiting on and that we\'re actively monitoring their claim.' }
        ],
        temperature: 0.7,
      }),
    });

    const aiData = await aiResponse.json();
    
    if (!aiResponse.ok) {
      console.error('OpenAI error for idle update:', aiData);
      return;
    }

    const emailBody = aiData.choices[0].message.content;
    const subject = `Claim Update: ${claim.claim_number} - We're Still Working For You`;

    // For semi-autonomous and fully autonomous, auto-send client updates
    // (Client communications are safe to auto-send)
    if (['semi_autonomous', 'fully_autonomous'].includes(automation.autonomy_level)) {
      const sendResponse = await fetch(
        `${Deno.env.get('SUPABASE_URL')}/functions/v1/send-email`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            recipients: [{ email: clientEmail, name: clientName, type: 'policyholder' }],
            subject,
            body: emailBody,
            claimId: claim.id,
          }),
        }
      );

      if (sendResponse.ok) {
        await supabase.from('darwin_action_log').insert({
          claim_id: claim.id,
          action_type: 'idle_claim_update',
          action_details: { 
            to: clientEmail,
            subject,
            open_tasks: openTasks?.length || 0,
            auto_sent: true
          },
          was_auto_executed: true,
          result: `Auto-sent bi-weekly client update to ${clientEmail}`,
          trigger_source: 'darwin_autonomous_agent',
        });
        results.emails_sent++;
        console.log(`Idle claim update sent for claim ${claim.claim_number}`);
      }
    } else {
      // Queue for review (supervised mode)
      await supabase.from('claim_ai_pending_actions').insert({
        claim_id: claim.id,
        action_type: 'email_response',
        draft_content: {
          to_email: clientEmail,
          to_name: clientName,
          subject,
          body: emailBody,
          recipient_type: 'policyholder'
        },
        ai_reasoning: `Bi-weekly idle claim update: No activity for ${idleThresholdDays}+ days. Summarizing ${openTasks?.length || 0} open tasks.`,
        status: 'pending',
      });
      
      await supabase.from('darwin_action_log').insert({
        claim_id: claim.id,
        action_type: 'idle_claim_update',
        action_details: { 
          to: clientEmail,
          subject,
          open_tasks: openTasks?.length || 0,
          queued_for_review: true
        },
        was_auto_executed: false,
        result: `Bi-weekly client update drafted for review`,
        trigger_source: 'darwin_autonomous_agent',
      });
      results.escalations++;
      console.log(`Idle claim update queued for claim ${claim.claim_number}`);
    }
    
  } catch (err) {
    console.error(`Error creating idle update for claim ${claim.claim_number}:`, err);
  }
}
