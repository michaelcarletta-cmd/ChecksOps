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

    console.log("Processing follow-up emails...");

    // Find all automations with follow-ups due
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
          loss_type
        )
      `)
      .eq('is_enabled', true)
      .eq('follow_up_enabled', true)
      .is('follow_up_stopped_at', null)
      .lte('follow_up_next_at', new Date().toISOString())
      .not('claims.status', 'in', '("Claim Settled","Dead File","Closed")')
      .not('claims.is_closed', 'eq', 'true');

    if (fetchError) {
      console.error("Failed to fetch due follow-ups:", fetchError);
      throw fetchError;
    }

    console.log(`Found ${dueFollowUps?.length || 0} follow-ups due`);

    const results: any[] = [];

    for (const automation of dueFollowUps || []) {
      const claim = (automation as any).claims;
      
      // Check if we've exceeded max follow-ups
      if (automation.follow_up_current_count >= automation.follow_up_max_count) {
        console.log(`Claim ${claim.claim_number}: Max follow-ups reached, stopping`);
        
        await supabase
          .from('claim_automations')
          .update({
            follow_up_stopped_at: new Date().toISOString(),
            follow_up_stop_reason: 'max_count_reached',
          })
          .eq('id', automation.id);
        
        continue;
      }

      // Get the last sent email to follow up on
      const { data: lastEmail } = await supabase
        .from('emails')
        .select('*')
        .eq('claim_id', claim.id)
        .neq('recipient_type', 'inbound')
        .order('sent_at', { ascending: false })
        .limit(1)
        .single();

      // Determine recipient (prefer adjuster, fall back to policyholder)
      let recipientEmail = claim.adjuster_email || claim.policyholder_email;
      let recipientName = claim.adjuster_name || claim.policyholder_name || 'there';

      if (!recipientEmail) {
        console.log(`Claim ${claim.claim_number}: No recipient email found, skipping`);
        continue;
      }

      // Generate follow-up email using central AI service
      const { callOpenAI } = await import("../_shared/ai/openaiClient.ts");

      const followUpNumber = automation.follow_up_current_count + 1;
      
      const systemPrompt = `You are drafting a professional follow-up email for a public adjusting firm.

EXTERNAL CONTENT WRITING RULES:
1. AUTHORSHIP: Never refer to Darwin, AI, or any automated system. Write as if authored by the claims team.
2. PLAIN TEXT: Use clean professional prose with paragraph formatting. No bullet points, emoji, markdown, or special symbols.
3. TONE: Polite, professional follow-up language.

CLAIM CONTEXT:
- Claim Number: ${claim.claim_number || 'N/A'}
- Policyholder: ${claim.policyholder_name || 'N/A'}
- Loss Type: ${claim.loss_type || 'N/A'}
- Status: ${claim.status || 'N/A'}

This is follow-up #${followUpNumber} of ${automation.follow_up_max_count}.

GUIDELINES:
1. Be polite but professional
2. Reference the claim number
3. Ask if they need any additional information
4. Keep it concise (under 150 words)
5. Don't be pushy - just a gentle reminder
6. End with "Regards," or "Sincerely," — do NOT include a team name or signature, it will be added automatically`;

      const userPrompt = lastEmail 
        ? `Generate a follow-up email. The last email sent was about: "${lastEmail.subject}"`
        : `Generate a follow-up email checking on the status of this claim.`;

      let emailBody: string;
      try {
        const aiResult = await callOpenAI({
          model: 'gpt-4o-mini',
          system: systemPrompt,
          user: userPrompt,
          temperature: 0.7,
        });
        emailBody = aiResult.text;
      } catch (aiErr) {
        console.error('AI generation error:', aiErr);
        continue;
      }
      const subject = `${claim.claim_number || claim.id.slice(0, 8)}`;

      // Build claim email for CC
      const sanitizedPolicyNumber = claim.policy_number 
        ? claim.policy_number.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
        : claim.id.slice(0, 8);
      const claimEmail = `claim-${sanitizedPolicyNumber}@freedomclaims.work`;

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
            recipients: [{ email: recipientEmail, name: recipientName, type: 'follow_up' }],
            subject,
            body: emailBody,
            claimId: claim.id,
            claimEmailCc: claimEmail,
          }),
        }
      );

      if (!sendResponse.ok) {
        const errorText = await sendResponse.text();
        console.error(`Failed to send follow-up for claim ${claim.claim_number}:`, errorText);
        continue;
      }

      console.log(`Follow-up #${followUpNumber} sent for claim ${claim.claim_number}`);

      // Update the automation record
      const nextFollowUpAt = new Date();
      nextFollowUpAt.setDate(nextFollowUpAt.getDate() + automation.follow_up_interval_days);

      await supabase
        .from('claim_automations')
        .update({
          follow_up_current_count: followUpNumber,
          follow_up_last_sent_at: new Date().toISOString(),
          follow_up_next_at: nextFollowUpAt.toISOString(),
        })
        .eq('id', automation.id);

      // Add activity note
      await supabase
        .from('claim_updates')
        .insert({
          claim_id: claim.id,
          content: `🤖 Automated follow-up #${followUpNumber} sent to ${recipientName} (${recipientEmail})`,
          update_type: 'follow_up',
        });

      results.push({
        claimId: claim.id,
        claimNumber: claim.claim_number,
        followUpNumber,
        recipient: recipientEmail,
      });
    }

    console.log(`Processed ${results.length} follow-ups successfully`);

    return new Response(
      JSON.stringify({ success: true, processed: results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error processing follow-ups:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});