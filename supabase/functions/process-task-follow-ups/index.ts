import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { generate } from "../_shared/ai/generate.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

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

    console.log("Processing task follow-ups...");

    const { data: dueTasks, error: fetchError } = await supabase
      .from('tasks')
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
          loss_type
        )
      `)
      .eq('follow_up_enabled', true)
      .is('follow_up_stopped_at', null)
      .neq('status', 'completed')
      .lte('follow_up_next_at', new Date().toISOString());

    if (fetchError) {
      console.error("Failed to fetch due task follow-ups:", fetchError);
      throw fetchError;
    }

    console.log(`Found ${dueTasks?.length || 0} task follow-ups due`);

    const results: any[] = [];

    for (const task of dueTasks || []) {
      const claim = (task as any).claims;
      
      if (task.follow_up_current_count >= task.follow_up_max_count) {
        console.log(`Task "${task.title}": Max follow-ups reached, stopping`);
        
        await supabase
          .from('tasks')
          .update({
            follow_up_stopped_at: new Date().toISOString(),
            follow_up_stop_reason: 'max_count_reached',
          })
          .eq('id', task.id);
        
        continue;
      }

      let recipientEmail = claim.adjuster_email || claim.policyholder_email;
      let recipientName = claim.adjuster_name || claim.policyholder_name || 'there';

      if (!recipientEmail) {
        console.log(`Task "${task.title}": No recipient email found, skipping`);
        continue;
      }

      const followUpNumber = task.follow_up_current_count + 1;
      
      const systemPrompt = `You are a professional public adjuster assistant for Freedom Claims. Generate a brief, professional follow-up email for a task.

TASK CONTEXT:
- Task: ${task.title}
- Description: ${task.description || 'N/A'}

CLAIM CONTEXT:
- Claim Number: ${claim.claim_number || 'N/A'}
- Policyholder: ${claim.policyholder_name || 'N/A'}
- Loss Type: ${claim.loss_type || 'N/A'}
- Status: ${claim.status || 'N/A'}

This is follow-up #${followUpNumber} of ${task.follow_up_max_count}.

GUIDELINES:
1. Be polite but professional
2. Reference the claim number and task subject
3. Ask if they need any additional information or if there are updates
4. Keep it concise (under 150 words)
5. Don't be pushy - just a gentle reminder
6. Sign off as "Freedom Claims Team"
7. Use plain text only - no markdown formatting`;

      const aiResult = await generate({
        task: 'copilot_drafting',
        system: systemPrompt,
        user: `Generate a follow-up email for the task: "${task.title}"`,
        claimId: claim.id,
        searchMode: 'off',
      });
      console.log(`[process-task-follow-ups] model=${aiResult.model}, cached=${aiResult.cached}`);

      const emailBody = aiResult.text;
      const subject = `Follow-up: ${task.title} - Claim ${claim.claim_number || claim.id.slice(0, 8)}`;

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
            recipients: [{ email: recipientEmail, name: recipientName, type: 'task_follow_up' }],
            subject,
            body: emailBody,
            claimId: claim.id,
            claimEmailCc: claimEmail,
          }),
        }
      );

      if (!sendResponse.ok) {
        const errorText = await sendResponse.text();
        console.error(`Failed to send follow-up for task "${task.title}":`, errorText);
        continue;
      }

      console.log(`Follow-up #${followUpNumber} sent for task "${task.title}"`);

      const nextFollowUpAt = new Date();
      nextFollowUpAt.setDate(nextFollowUpAt.getDate() + task.follow_up_interval_days);
      
      const newDueDate = nextFollowUpAt.toISOString().split('T')[0];

      await supabase
        .from('tasks')
        .update({
          follow_up_current_count: followUpNumber,
          follow_up_last_sent_at: new Date().toISOString(),
          follow_up_next_at: nextFollowUpAt.toISOString(),
          due_date: newDueDate,
        })
        .eq('id', task.id);

      await supabase
        .from('claim_updates')
        .insert({
          claim_id: claim.id,
          content: `Automated follow-up #${followUpNumber} sent for task "${task.title}" to ${recipientName} (${recipientEmail})`,
          update_type: 'task_follow_up',
        });

      if (followUpNumber < task.follow_up_max_count) {
        const nextTaskDueDate = new Date();
        nextTaskDueDate.setDate(nextTaskDueDate.getDate() + task.follow_up_interval_days);
        
        await supabase
          .from('tasks')
          .insert({
            claim_id: claim.id,
            title: `Follow-up #${followUpNumber + 1}: ${task.title}`,
            description: `Automated follow-up task created after sending follow-up #${followUpNumber}. Original task: ${task.description || task.title}`,
            due_date: nextTaskDueDate.toISOString().split('T')[0],
            priority: task.priority || 'medium',
            status: 'pending',
            assigned_to: task.assigned_to,
          });
        
        console.log(`Created follow-up task #${followUpNumber + 1} for claim ${claim.claim_number}`);
      }

      results.push({
        taskId: task.id,
        taskTitle: task.title,
        claimNumber: claim.claim_number,
        followUpNumber,
        recipient: recipientEmail,
      });
    }

    console.log(`Processed ${results.length} task follow-ups successfully`);

    return new Response(
      JSON.stringify({ success: true, processed: results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error processing task follow-ups:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
