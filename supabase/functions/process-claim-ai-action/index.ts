import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { action, claimId, emailId, pendingActionId } = await req.json();
    console.log(`Processing action: ${action} for claim: ${claimId}`);

    if (action === 'draft_email_response') {
      // Fetch the inbound email that triggered this
      const { data: email, error: emailError } = await supabase
        .from('emails')
        .select('*')
        .eq('id', emailId)
        .single();

      if (emailError || !email) {
        throw new Error('Email not found');
      }

      // Fetch claim data for context
      const { data: claim, error: claimError } = await supabase
        .from('claims')
        .select('*')
        .eq('id', claimId)
        .single();

      if (claimError || !claim) {
        throw new Error('Claim not found');
      }

      // Get recent emails for context
      const { data: recentEmails } = await supabase
        .from('emails')
        .select('subject, body, recipient_type, sent_at')
        .eq('claim_id', claimId)
        .order('sent_at', { ascending: false })
        .limit(10);

      // Get claim notes for context
      const { data: notes } = await supabase
        .from('claim_updates')
        .select('content, created_at')
        .eq('claim_id', claimId)
        .order('created_at', { ascending: false })
        .limit(10);

      // Build AI prompt
      const systemPrompt = `You are a professional public adjuster assistant for Freedom Claims. Your job is to help draft professional, helpful email responses to claim-related inquiries.

CLAIM CONTEXT:
- Claim Number: ${claim.claim_number || 'N/A'}
- Policyholder: ${claim.policyholder_name || 'N/A'}
- Policy Number: ${claim.policy_number || 'N/A'}
- Loss Type: ${claim.loss_type || 'N/A'}
- Loss Date: ${claim.loss_date || 'N/A'}
- Loss Description: ${claim.loss_description || 'N/A'}
- Insurance Company: ${claim.insurance_company || 'N/A'}
- Current Status: ${claim.status || 'N/A'}
- Adjuster: ${claim.adjuster_name || 'N/A'}

RECENT CLAIM NOTES:
${notes?.map(n => `- ${n.content}`).join('\n') || 'No recent notes'}

RECENT EMAIL COMMUNICATIONS:
${recentEmails?.map(e => `- [${e.recipient_type}] ${e.subject}`).join('\n') || 'No recent emails'}

GUIDELINES:
1. Be professional and courteous
2. Reference specific claim details when relevant
3. Provide accurate information based on claim context
4. If you don't have enough information, acknowledge that and suggest next steps
5. Sign off as "Freedom Claims Team"
6. Keep responses concise but thorough`;

      const userPrompt = `Please draft a professional email response to the following inbound email:

FROM: ${email.recipient_name} <${email.recipient_email}>
SUBJECT: ${email.subject}
BODY:
${email.body}

Draft a clear, professional response addressing their inquiry. The response should be helpful and reference the claim context where appropriate.`;

      // Call Lovable AI
      const lovableApiKey = Deno.env.get('LOVABLE_API_KEY');
      if (!lovableApiKey) {
        throw new Error('LOVABLE_API_KEY not configured');
      }

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
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7,
        }),
      });

      if (!aiResponse.ok) {
        if (aiResponse.status === 429) {
          throw new Error('Rate limit exceeded. Please try again later.');
        }
        if (aiResponse.status === 402) {
          throw new Error('AI credits exhausted. Please add credits.');
        }
        const errorText = await aiResponse.text();
        console.error('AI error:', aiResponse.status, errorText);
        throw new Error('Failed to generate AI response');
      }

      const aiData = await aiResponse.json();

      const draftResponse = aiData.choices[0].message.content;

      // Generate suggested subject line
      const subjectResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${lovableApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'google/gemini-2.5-flash',
          messages: [
            { role: 'system', content: 'Generate a brief, professional email subject line for a reply. Return only the subject line, nothing else.' },
            { role: 'user', content: `Original subject: ${email.subject}\n\nResponse content: ${draftResponse.substring(0, 500)}` }
          ],
          temperature: 0.5,
        }),
      });

      const subjectData = await subjectResponse.json();
      const suggestedSubject = subjectData.choices?.[0]?.message?.content || `Re: ${email.subject}`;

      // Determine recipient type based on email address
      let recipientType = 'unknown';
      if (email.recipient_email) {
        const recipientLower = email.recipient_email.toLowerCase();
        // Check if it's the policyholder
        if (claim.policyholder_email && recipientLower === claim.policyholder_email.toLowerCase()) {
          recipientType = 'policyholder';
        }
        // Check if it's the adjuster or insurance
        else if (claim.adjuster_email && recipientLower === claim.adjuster_email.toLowerCase()) {
          recipientType = 'adjuster';
        }
        else if (claim.insurance_email && recipientLower === claim.insurance_email.toLowerCase()) {
          recipientType = 'insurance';
        }
        // Could also check claim_adjusters table but keeping it simple for now
      }

      // Create pending action for approval
      const { data: pendingAction, error: insertError } = await supabase
        .from('claim_ai_pending_actions')
        .insert({
          claim_id: claimId,
          action_type: 'email_response',
          trigger_email_id: emailId,
          draft_content: {
            to_email: email.recipient_email,
            to_name: email.recipient_name,
            recipient_type: recipientType, // Include recipient type for filtering
            subject: suggestedSubject.trim(),
            body: draftResponse,
            original_subject: email.subject,
            original_body: email.body,
          },
          ai_reasoning: `Drafted in response to inbound email from ${email.recipient_name}. Considered claim context including ${claim.policyholder_name}'s ${claim.loss_type || 'claim'} and recent communications.`,
        })
        .select()
        .single();

      if (insertError) {
        console.error('Failed to create pending action:', insertError);
        throw new Error('Failed to save draft');
      }

      // Also add a note to the claim activity
      await supabase
        .from('claim_updates')
        .insert({
          claim_id: claimId,
          content: `🤖 AI Assistant drafted a response to email from ${email.recipient_name}. Awaiting approval in Inbox.`,
          update_type: 'ai_action',
        });

      return new Response(
        JSON.stringify({ success: true, pendingActionId: pendingAction.id }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );

    } else if (action === 'draft_sms') {
      // Draft an SMS message based on claim context
      const { recipientType, recipientPhone } = await req.json();
      
      // Fetch claim data for context
      const { data: claim, error: claimError } = await supabase
        .from('claims')
        .select('*')
        .eq('id', claimId)
        .single();

      if (claimError || !claim) {
        throw new Error('Claim not found');
      }

      // Get recent activity for context
      const { data: notes } = await supabase
        .from('claim_updates')
        .select('content, created_at')
        .eq('claim_id', claimId)
        .order('created_at', { ascending: false })
        .limit(5);

      // Get recent emails
      const { data: recentEmails } = await supabase
        .from('emails')
        .select('subject, body, sent_at')
        .eq('claim_id', claimId)
        .order('sent_at', { ascending: false })
        .limit(3);

      const lovableApiKey = Deno.env.get('LOVABLE_API_KEY');
      if (!lovableApiKey) {
        throw new Error('LOVABLE_API_KEY not configured');
      }

      const systemPrompt = `You are a professional public adjuster assistant for Freedom Claims. Draft a brief, professional SMS message.

CLAIM CONTEXT:
- Claim Number: ${claim.claim_number || 'N/A'}
- Policyholder: ${claim.policyholder_name || 'N/A'}
- Loss Type: ${claim.loss_type || 'N/A'}
- Loss Date: ${claim.loss_date || 'N/A'}
- Current Status: ${claim.status || 'N/A'}

RECENT ACTIVITY:
${notes?.map(n => `- ${n.content}`).join('\n') || 'No recent notes'}

RECENT EMAILS:
${recentEmails?.map(e => `- ${e.subject}`).join('\n') || 'No recent emails'}

GUIDELINES:
1. Keep SMS under 160 characters when possible
2. Be professional but friendly
3. Include relevant claim updates
4. End with "- Freedom Claims" signature
5. No URLs or special characters that may not render properly`;

      const userPrompt = `Draft a brief SMS update for the ${recipientType || 'policyholder'} about this claim. Provide a helpful status update or next steps based on recent activity.`;

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
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7,
        }),
      });

      if (!aiResponse.ok) {
        if (aiResponse.status === 429) {
          throw new Error('Rate limit exceeded. Please try again later.');
        }
        if (aiResponse.status === 402) {
          throw new Error('AI credits exhausted. Please add credits.');
        }
        const errorText = await aiResponse.text();
        console.error('AI error:', aiResponse.status, errorText);
        throw new Error('Failed to generate AI response');
      }

      const aiData = await aiResponse.json();

      const draftMessage = aiData.choices[0].message.content;

      // Determine phone number
      let toNumber = recipientPhone;
      if (!toNumber) {
        if (recipientType === 'adjuster') {
          toNumber = claim.adjuster_phone;
        } else {
          toNumber = claim.policyholder_phone;
        }
      }

      // Create pending action for approval
      const { data: pendingAction, error: insertError } = await supabase
        .from('claim_ai_pending_actions')
        .insert({
          claim_id: claimId,
          action_type: 'sms',
          draft_content: {
            to_number: toNumber,
            recipient_type: recipientType || 'policyholder',
            message: draftMessage,
          },
          ai_reasoning: `Drafted SMS update for ${recipientType || 'policyholder'} based on recent claim activity.`,
        })
        .select()
        .single();

      if (insertError) {
        console.error('Failed to create pending action:', insertError);
        throw new Error('Failed to save SMS draft');
      }

      // Add activity note
      await supabase
        .from('claim_updates')
        .insert({
          claim_id: claimId,
          content: `🤖 AI Assistant drafted an SMS for ${recipientType || 'policyholder'}. Awaiting approval in Inbox.`,
          update_type: 'ai_action',
        });

      return new Response(
        JSON.stringify({ success: true, pendingActionId: pendingAction.id }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );

    } else if (action === 'approve_and_send') {
      // Fetch the pending action
      const { data: pendingAction, error: fetchError } = await supabase
        .from('claim_ai_pending_actions')
        .select('*')
        .eq('id', pendingActionId)
        .single();

      if (fetchError || !pendingAction) {
        throw new Error('Pending action not found');
      }

      const authHeader = req.headers.get('Authorization');
      
      if (pendingAction.action_type === 'email_response') {
        const draft = pendingAction.draft_content as any;
        
        // Fetch claim to get policy number for CC email
        const { data: claim } = await supabase
          .from('claims')
          .select('policy_number, id')
          .eq('id', pendingAction.claim_id)
          .single();

        // Build claim-specific email for CC
        const sanitizedPolicyNumber = claim?.policy_number 
          ? claim.policy_number.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
          : pendingAction.claim_id.slice(0, 8);
        const claimEmail = `claim-${sanitizedPolicyNumber}@freedomclaims.work`;
        
        // Send the email via send-email function
        const emailPayload = {
          recipients: [{ email: draft.to_email, name: draft.to_name }],
          subject: draft.subject,
          body: draft.body,
          claimId: pendingAction.claim_id,
          claimEmailCc: claimEmail,
        };

        const sendResponse = await fetch(
          `${Deno.env.get('SUPABASE_URL')}/functions/v1/send-email`,
          {
            method: 'POST',
            headers: {
              'Authorization': authHeader || '',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(emailPayload),
          }
        );

        if (!sendResponse.ok) {
          const errorText = await sendResponse.text();
          console.error('Send email failed:', errorText);
          throw new Error('Failed to send email');
        }

        // Update pending action status
        const { error: updateError } = await supabase
          .from('claim_ai_pending_actions')
          .update({
            status: 'sent',
            reviewed_at: new Date().toISOString(),
          })
          .eq('id', pendingActionId);

        if (updateError) {
          console.error('Failed to update pending action:', updateError);
        }

        // Add activity note
        await supabase
          .from('claim_updates')
          .insert({
            claim_id: pendingAction.claim_id,
            content: `✅ AI-drafted email approved and sent to ${draft.to_email}`,
            update_type: 'ai_action',
          });

        return new Response(
          JSON.stringify({ success: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );

      } else if (pendingAction.action_type === 'sms') {
        const draft = pendingAction.draft_content as any;
        
        // Send SMS via send-sms function
        const smsResponse = await fetch(
          `${Deno.env.get('SUPABASE_URL')}/functions/v1/send-sms`,
          {
            method: 'POST',
            headers: {
              'Authorization': authHeader || '',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              claimId: pendingAction.claim_id,
              toNumber: draft.to_number,
              messageBody: draft.message,
            }),
          }
        );

        if (!smsResponse.ok) {
          throw new Error('Failed to send SMS');
        }

        // Update pending action status
        await supabase
          .from('claim_ai_pending_actions')
          .update({
            status: 'sent',
            reviewed_at: new Date().toISOString(),
          })
          .eq('id', pendingActionId);

        return new Response(
          JSON.stringify({ success: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

    } else if (action === 'reject') {
      const { error: updateError } = await supabase
        .from('claim_ai_pending_actions')
        .update({
          status: 'rejected',
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', pendingActionId);

      if (updateError) {
        throw new Error('Failed to reject action');
      }

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );

    } else if (action === 'add_note') {
      const { content } = await req.json();
      
      await supabase
        .from('claim_updates')
        .insert({
          claim_id: claimId,
          content: `🤖 AI Note: ${content}`,
          update_type: 'ai_action',
        });

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: 'Unknown action' }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error processing claim AI action:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
