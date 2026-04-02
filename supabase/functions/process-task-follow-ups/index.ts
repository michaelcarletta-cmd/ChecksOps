import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Validate CRON_SECRET for security
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

    // Find all tasks with follow-ups due
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
      
      // Check if we've exceeded max follow-ups
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

      // Determine recipient - prefer adjuster email
      let recipientEmail = claim.adjuster_email || claim.policyholder_email;
      let recipientName = claim.adjuster_name || claim.policyholder_name || 'there';

      if (!recipientEmail) {
        console.log(`Task "${task.title}": No recipient email found, skipping`);
        continue;
      }

      // Generate follow-up email using AI
      const lovableApiKey = Deno.env.get('LOVABLE_API_KEY');
      if (!lovableApiKey) {
        console.error('LOVABLE_API_KEY not configured');
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

      const aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${lovableApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'google/gemini-2.5-flash',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Generate a follow-up email for the task: "${task.title}"` }
          ],
        }),
      });

      const aiData = await aiResponse.json();
      
      if (!aiResponse.ok) {
        console.error('AI gateway error:', aiData);
        continue;
      }

      const emailBody = aiData.choices[0].message.content;
      const subject = `Follow-up: ${task.title} - Claim ${claim.claim_number || claim.id.slice(0, 8)}`;

      // Build claim email for CC
      const sanitizedPolicyNumber = claim.policy_number 
        ? claim.policy_number.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
        : claim.id.slice(0, 8);
      const claimEmail = `claim-${sanitizedPolicyNumber}@claims.freedomclaims.work`;

      // Send the follow-up email
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

      // Update the task record - reset due_date so it doesn't show as overdue
      const nextFollowUpAt = new Date();
      nextFollowUpAt.setDate(nextFollowUpAt.getDate() + task.follow_up_interval_days);
      
      // Reset due_date to the next follow-up date so the task doesn't appear overdue
      const newDueDate = nextFollowUpAt.toISOString().split('T')[0];

      await supabase
        .from('tasks')
        .update({
          follow_up_current_count: followUpNumber,
          follow_up_last_sent_at: new Date().toISOString(),
          follow_up_next_at: nextFollowUpAt.toISOString(),
          due_date: newDueDate, // Reset due date when AI sends follow-up
        })
        .eq('id', task.id);

      // Add activity note to claim
      await supabase
        .from('claim_updates')
        .insert({
          claim_id: claim.id,
          content: `Automated follow-up #${followUpNumber} sent for task "${task.title}" to ${recipientName} (${recipientEmail})`,
          update_type: 'task_follow_up',
        });

      // Create next follow-up task if not at max
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
