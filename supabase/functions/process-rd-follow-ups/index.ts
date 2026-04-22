import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { generate } from "../_shared/ai/generate.ts";
import { isWithinBusinessHours, outsideBusinessHoursResponse } from "../_shared/business-hours-gate.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const RD_REQUEST_STATUSES = [
  'Recoverable Depreciation Requested',
  'RD Requested',
  'Awaiting RD Release',
  'RD Pending',
];

const RD_RELEASED_STATUSES = [
  'Waiting on Recoverable Depreciation',
  'Waiting on RD Check',
  'RD Check Pending',
  'Awaiting RD Check',
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const cronSecret = Deno.env.get('CRON_SECRET');
  const providedSecret = req.headers.get('x-cron-secret');
  
  if (cronSecret && providedSecret !== cronSecret) {
    console.error('Invalid or missing cron secret');
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    console.log("Processing Recoverable Depreciation follow-ups...");

    const { data: dueFollowUps, error: fetchError } = await supabase
      .from('claim_automations')
      .select(`
        *,
        claims!inner(
          id,
          claim_number,
          policy_number,
          policyholder_name,
          policyholder_email,
          adjuster_name,
          adjuster_email,
          status,
          loss_type,
          insurance_company
        )
      `)
      .eq('is_enabled', true)
      .eq('rd_follow_up_enabled', true)
      .is('rd_follow_up_stopped_at', null)
      .lte('rd_follow_up_next_at', new Date().toISOString());

    if (fetchError) {
      console.error("Failed to fetch due RD follow-ups:", fetchError);
      throw fetchError;
    }

    const rdClaims: any[] = [];
    
    for (const automation of (dueFollowUps || [])) {
      const claim = (automation as any).claims;
      const claimStatus = claim?.status?.toLowerCase() || '';
      
      const rdWasReleased = RD_RELEASED_STATUSES.some(s => 
        claimStatus.includes(s.toLowerCase()) || s.toLowerCase().includes(claimStatus)
      );
      
      if (rdWasReleased) {
        console.log(`Claim ${claim.claim_number}: Status changed to waiting on RD check - stopping RD request follow-ups`);
        
        const enableCheckTracking = automation.rd_check_tracking_enabled !== false;
        await supabase
          .from('claim_automations')
          .update({
            rd_follow_up_enabled: false,
            rd_follow_up_stopped_at: new Date().toISOString(),
            rd_follow_up_stop_reason: 'rd_released',
            rd_check_tracking_enabled: enableCheckTracking,
            rd_check_released_at: automation.rd_check_released_at || new Date().toISOString(),
          })
          .eq('id', automation.id);
        
        await supabase
          .from('claim_updates')
          .insert({
            claim_id: claim.id,
            content: `✅ RD Request Follow-ups stopped - Status changed to "${claim.status}". RD check tracking activated.`,
            update_type: 'automation_status',
          });
        
        continue;
      }
      
      const isInRdRequestStatus = RD_REQUEST_STATUSES.some(s => 
        claimStatus.includes(s.toLowerCase()) || s.toLowerCase().includes(claimStatus)
      );
      
      if (isInRdRequestStatus) {
        rdClaims.push(automation);
      }
    }

    console.log(`Found ${rdClaims.length} RD follow-ups due (from ${dueFollowUps?.length || 0} total enabled)`);

    const results: any[] = [];

    for (const automation of rdClaims) {
      const claim = (automation as any).claims;
      
      let recipientEmail = claim.adjuster_email;
      let recipientName = claim.adjuster_name || 'Claims Department';

      if (!recipientEmail) {
        const { data: claimAdjuster } = await supabase
          .from('claim_adjusters')
          .select('adjuster_name, adjuster_email')
          .eq('claim_id', claim.id)
          .eq('is_primary', true)
          .limit(1)
          .single();

        if (claimAdjuster?.adjuster_email) {
          recipientEmail = claimAdjuster.adjuster_email;
          recipientName = claimAdjuster.adjuster_name || 'Claims Department';
        }
      }

      if (!recipientEmail && claim.insurance_company) {
        const { data: carrier } = await supabase
          .from('insurance_companies')
          .select('email, name')
          .ilike('name', `%${claim.insurance_company}%`)
          .limit(1)
          .single();

        if (carrier?.email) {
          recipientEmail = carrier.email;
          recipientName = carrier.name || claim.insurance_company;
        }
      }

      if (!recipientEmail) {
        console.log(`Claim ${claim.claim_number}: No adjuster or carrier email found for RD follow-up, skipping`);
        continue;
      }

      const followUpNumber = automation.rd_follow_up_current_count + 1;
      
      const systemPrompt = `You are a professional public adjuster assistant for Freedom Claims. Generate a polite but firm follow-up email specifically about Recoverable Depreciation release.

CLAIM CONTEXT:
- Claim Number: ${claim.claim_number || 'N/A'}
- Policyholder: ${claim.policyholder_name || 'N/A'}
- Insurance Company: ${claim.insurance_company || 'the carrier'}
- Loss Type: ${claim.loss_type || 'N/A'}
- Current Status: ${claim.status || 'Recoverable Depreciation Requested'}

This is RD follow-up #${followUpNumber}.

PURPOSE:
This email is specifically about Recoverable Depreciation (RD) release. The policyholder has completed work and submitted invoices. We need confirmation that:
1. The invoices and documentation were received
2. The recoverable depreciation is being processed for release
3. When the RD payment will be issued

GUIDELINES:
1. Be professional and courteous but persistent
2. Reference the claim number prominently
3. Ask specifically about confirmation of receipt, RD release processing status, and expected timeline
4. Keep it concise (under 150 words)
5. If this is follow-up #2 or later, mention that you've previously requested this information
6. Sign off as "Freedom Claims Team"
7. Use plain text only - no markdown formatting
8. Do NOT use aggressive language, but be firm about needing a response`;

      const userPrompt = followUpNumber === 1
        ? `Generate the first RD follow-up email requesting confirmation that invoices were received and asking when recoverable depreciation will be released.`
        : `Generate follow-up #${followUpNumber} for RD release. Previous follow-ups have not received a response. Politely but firmly request an update on the recoverable depreciation release status.`;

      const aiResult = await generate({
        task: 'copilot_drafting',
        system: systemPrompt,
        user: userPrompt,
        claimId: claim.id,
        searchMode: 'off',
      });
      console.log(`[process-rd-follow-ups] model=${aiResult.model}, cached=${aiResult.cached}`);

      const emailBody = aiResult.text;
      const subject = `Recoverable Depreciation Status - Claim ${claim.claim_number || claim.id.slice(0, 8)}`;

      const sanitizedPolicyNumber = claim.policy_number 
        ? claim.policy_number.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
        : claim.id.slice(0, 8);
      const claimEmail = `claim-${sanitizedPolicyNumber}@freedomclaims.work`;

      const sendResponse = await fetch(
        `${Deno.env.get('SUPABASE_URL')}/functions/v1/send-email`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            recipients: [{ email: recipientEmail, name: recipientName, type: 'rd_follow_up' }],
            subject,
            body: emailBody,
            claimId: claim.id,
            claimEmailCc: claimEmail,
          }),
        }
      );

      if (!sendResponse.ok) {
        const errorText = await sendResponse.text();
        console.error(`Failed to send RD follow-up for claim ${claim.claim_number}:`, errorText);
        continue;
      }

      console.log(`RD Follow-up #${followUpNumber} sent for claim ${claim.claim_number} to ${recipientEmail}`);

      const nextFollowUpAt = new Date();
      nextFollowUpAt.setDate(nextFollowUpAt.getDate() + automation.rd_follow_up_interval_days);

      await supabase
        .from('claim_automations')
        .update({
          rd_follow_up_current_count: followUpNumber,
          rd_follow_up_last_sent_at: new Date().toISOString(),
          rd_follow_up_next_at: nextFollowUpAt.toISOString(),
        })
        .eq('id', automation.id);

      await supabase
        .from('claim_updates')
        .insert({
          claim_id: claim.id,
          content: `💰 **Darwin RD Follow-up #${followUpNumber}**\n\n**Sent to:** ${recipientName} (${recipientEmail})\n**Subject:** ${subject}\n**Purpose:** Requesting confirmation of invoice receipt and RD release status\n\n_Next follow-up scheduled in ${automation.rd_follow_up_interval_days} days if no response._`,
          update_type: 'rd_follow_up',
        });

      await supabase
        .from('claim_notes')
        .insert({
          claim_id: claim.id,
          content: `[Darwin Auto] RD Follow-up #${followUpNumber} sent to ${recipientName} at ${claim.insurance_company || 'carrier'}. Awaiting response on invoice receipt and RD release timeline.`,
        });

      const taskDueDate = new Date();
      taskDueDate.setDate(taskDueDate.getDate() + Math.min(automation.rd_follow_up_interval_days, 3));
      
      const { data: existingTask } = await supabase
        .from('tasks')
        .select('id')
        .eq('claim_id', claim.id)
        .ilike('title', '%RD%')
        .ilike('title', '%response%')
        .eq('status', 'pending')
        .limit(1)
        .single();

      if (existingTask) {
        await supabase
          .from('tasks')
          .update({
            description: `Darwin sent RD Follow-up #${followUpNumber} to ${recipientName}. Check for carrier response and update claim status when RD is released.`,
            due_date: taskDueDate.toISOString().split('T')[0],
            updated_at: new Date().toISOString(),
          })
          .eq('id', existingTask.id);
      } else {
        await supabase
          .from('tasks')
          .insert({
            claim_id: claim.id,
            title: `Check for RD response from ${claim.insurance_company || 'carrier'}`,
            description: `Darwin sent RD Follow-up #${followUpNumber} to ${recipientName}. Monitor for carrier response and update claim status when RD is released.`,
            due_date: taskDueDate.toISOString().split('T')[0],
            priority: 'high',
            status: 'pending',
          });
      }

      results.push({
        claimId: claim.id,
        claimNumber: claim.claim_number,
        followUpNumber,
        recipient: recipientEmail,
        type: 'rd_follow_up',
      });
    }

    console.log(`Processed ${results.length} RD follow-ups successfully`);

    return new Response(
      JSON.stringify({ success: true, processed: results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error processing RD follow-ups:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
