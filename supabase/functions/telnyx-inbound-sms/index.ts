import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { parseIntent } from "../_shared/darwin-command-contracts.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/** Normalize phone to last 10 digits for matching */
function last10(phone: string): string {
  return phone.replace(/\D/g, '').slice(-10);
}

/** Send an SMS reply via Telnyx */
async function sendReply(to: string, text: string) {
  const TELNYX_API_KEY = Deno.env.get('TELNYX_API_KEY')!;
  const TELNYX_PHONE_NUMBER = Deno.env.get('TELNYX_PHONE_NUMBER')!;
  const TELNYX_MESSAGING_PROFILE_ID = Deno.env.get('TELNYX_MESSAGING_PROFILE_ID');

  const body: Record<string, string> = {
    from: TELNYX_PHONE_NUMBER,
    to,
    text,
  };
  if (TELNYX_MESSAGING_PROFILE_ID) body.messaging_profile_id = TELNYX_MESSAGING_PROFILE_ID;

  const resp = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TELNYX_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) console.error('Telnyx send error:', data);
  return data;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const payload = await req.json();
    console.log('Telnyx webhook received:', JSON.stringify(payload).slice(0, 500));

    const eventType = payload.data?.event_type;
    const messagePayload = payload.data?.payload;

    // ── Status updates (sent, delivered, failed) ──
    if (eventType?.startsWith('message.') && eventType !== 'message.received') {
      const telnyxMessageId = messagePayload?.id;
      const status = messagePayload?.to?.[0]?.status || eventType?.replace('message.', '');
      if (!telnyxMessageId) {
        return new Response(JSON.stringify({ success: true, ignored: true }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      let mappedStatus = status;
      if (status === 'sending' || status === 'queued') mappedStatus = 'sending';
      else if (status === 'delivery_failed' || status === 'sending_failed') mappedStatus = 'failed';

      await supabase.from('sms_messages')
        .update({ status: mappedStatus, updated_at: new Date().toISOString() })
        .eq('telnyx_message_id', telnyxMessageId);

      return new Response(JSON.stringify({ success: true, status: mappedStatus }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (eventType !== 'message.received') {
      return new Response(JSON.stringify({ success: true, ignored: true }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Inbound message processing ──
    const fromNumber = messagePayload?.from?.phone_number;
    const toNumber = messagePayload?.to?.[0]?.phone_number;
    const messageBody = (messagePayload?.text || '').trim();
    const messageId = messagePayload?.id;

    if (!fromNumber || !messageBody) {
      return new Response(JSON.stringify({ error: 'Missing required message fields' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`Inbound SMS from ${fromNumber}: ${messageBody}`);

    // ── 1. Resolve phone → verified user ──
    const fromLast10 = last10(fromNumber);
    const { data: phoneLink } = await supabase
      .from('user_phone_links')
      .select('user_id, is_verified')
      .eq('phone_number', fromNumber)
      .single();

    // Check for pending verification code
    if (phoneLink && !phoneLink.is_verified) {
      // Check if message is a verification code
      const codeMatch = messageBody.match(/^\d{6}$/);
      if (codeMatch) {
        const { data: linkRow } = await supabase
          .from('user_phone_links')
          .select('*')
          .eq('phone_number', fromNumber)
          .single();

        if (linkRow && linkRow.verification_code === messageBody && 
            new Date(linkRow.verification_expires_at) > new Date()) {
          await supabase.from('user_phone_links')
            .update({ is_verified: true, verified_at: new Date().toISOString(), verification_code: null })
            .eq('id', linkRow.id);
          await sendReply(fromNumber, '✅ Phone verified! You can now text Darwin commands. Reply HELP for a list.');
          return new Response(JSON.stringify({ success: true, action: 'verified' }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } else {
          await sendReply(fromNumber, '❌ Invalid or expired code. Please request a new one from the app.');
          return new Response(JSON.stringify({ success: true, action: 'bad_code' }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }
    }

    const userId = phoneLink?.is_verified ? phoneLink.user_id : null;

    // ── 2. If no verified user, fall back to claim matching (legacy behavior) ──
    if (!userId) {
      // Legacy: match by claim phone numbers
      const { data: claims } = await supabase
        .from('claims')
        .select('id, policyholder_phone, adjuster_phone')
        .or(`policyholder_phone.ilike.%${fromLast10}%,adjuster_phone.ilike.%${fromLast10}%`);

      let claimId = claims?.[0]?.id;
      if (!claimId) {
        const { data: adjusters } = await supabase
          .from('claim_adjusters')
          .select('claim_id')
          .ilike('adjuster_phone', `%${fromLast10}%`);
        claimId = adjusters?.[0]?.claim_id;
      }

      // Store as regular inbound SMS (not Darwin command)
      if (claimId) {
        await supabase.from('sms_messages').insert({
          claim_id: claimId, from_number: fromNumber, to_number: toNumber || '',
          message_body: messageBody, status: 'received', direction: 'inbound',
          telnyx_message_id: messageId,
        });
        await supabase.from('claims')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', claimId);
        await supabase.from('claim_updates').insert({
          claim_id: claimId,
          content: `Inbound SMS from ${fromNumber}: "${messageBody.substring(0, 100)}${messageBody.length > 100 ? '...' : ''}"`,
          update_type: 'sms_received',
        });
      }

      // Log to Darwin activity as unverified
      await supabase.from('darwin_sms_activity').insert({
        phone_number: fromNumber, claim_id: claimId || null,
        direction: 'inbound', message_text: messageBody,
        status: 'completed', parsed_intent: 'legacy_inbound',
        darwin_response: claimId ? 'Routed to claim (unverified user)' : 'No matching claim or user',
      });

      return new Response(JSON.stringify({ success: true, claimId, legacy: true }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── 3. Handle HELP command ──
    if (messageBody.toUpperCase() === 'HELP') {
      const helpText = `Darwin Commands:\n• "Analyze claim" - Run AI analysis\n• "Status" - Get claim status\n• "Switch [claim #]" - Change active claim\n• "Claims" - List your recent claims\n• Financial questions like "What's been paid?"\n\nReply STOP to opt out.`;
      await sendReply(fromNumber, helpText);
      await supabase.from('darwin_sms_activity').insert({
        user_id: userId, phone_number: fromNumber,
        direction: 'inbound', message_text: messageBody,
        parsed_intent: 'help', darwin_response: helpText, status: 'completed',
      });
      return new Response(JSON.stringify({ success: true, action: 'help' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── 4. Get or create conversation state ──
    let { data: convState } = await supabase
      .from('sms_conversation_state')
      .select('*')
      .eq('phone_number', fromNumber)
      .single();

    if (!convState) {
      const { data: newState } = await supabase
        .from('sms_conversation_state')
        .insert({ user_id: userId, phone_number: fromNumber })
        .select()
        .single();
      convState = newState;
    } else if (new Date(convState.expires_at) < new Date()) {
      // Expired — reset
      await supabase.from('sms_conversation_state')
        .update({ active_claim_id: null, expires_at: new Date(Date.now() + 2 * 3600000).toISOString() })
        .eq('id', convState.id);
      convState.active_claim_id = null;
    }

    // ── 5. Handle "switch" / "claims" commands ──
    const switchMatch = messageBody.match(/^switch\s+(.+)/i);
    if (switchMatch) {
      const searchTerm = switchMatch[1].trim();
      const { data: matchedClaims } = await supabase
        .from('claims')
        .select('id, claim_number, policyholder_name')
        .or(`claim_number.ilike.%${searchTerm}%,policyholder_name.ilike.%${searchTerm}%`)
        .limit(1);

      if (matchedClaims && matchedClaims.length > 0) {
        const c = matchedClaims[0];
        await supabase.from('sms_conversation_state')
          .update({ active_claim_id: c.id, expires_at: new Date(Date.now() + 2 * 3600000).toISOString() })
          .eq('id', convState!.id);
        const reply = `✅ Switched to: ${c.claim_number} — ${c.policyholder_name}`;
        await sendReply(fromNumber, reply);
        await supabase.from('darwin_sms_activity').insert({
          user_id: userId, phone_number: fromNumber, claim_id: c.id,
          direction: 'inbound', message_text: messageBody,
          parsed_intent: 'switch_claim', darwin_response: reply, status: 'completed',
        });
        return new Response(JSON.stringify({ success: true, action: 'switched', claimId: c.id }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } else {
        const reply = `No claim found matching "${searchTerm}". Try the claim number or policyholder name.`;
        await sendReply(fromNumber, reply);
        return new Response(JSON.stringify({ success: true, action: 'not_found' }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    if (messageBody.toUpperCase() === 'CLAIMS') {
      const { data: recentClaims } = await supabase
        .from('claims')
        .select('claim_number, policyholder_name, status')
        .order('updated_at', { ascending: false })
        .limit(5);
      
      if (recentClaims && recentClaims.length > 0) {
        const list = recentClaims.map((c, i) => `${i + 1}. ${c.claim_number} — ${c.policyholder_name} (${c.status})`).join('\n');
        const reply = `Recent claims:\n${list}\n\nReply "Switch [claim #]" to select one.`;
        await sendReply(fromNumber, reply);
      } else {
        await sendReply(fromNumber, 'No claims found.');
      }
      return new Response(JSON.stringify({ success: true, action: 'list_claims' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── 6. Resolve active claim context ──
    let activeClaimId = convState?.active_claim_id;
    if (!activeClaimId) {
      // Auto-resolve: most recently updated claim
      const { data: lastClaim } = await supabase
        .from('claims')
        .select('id, claim_number')
        .eq('is_closed', false)
        .order('updated_at', { ascending: false })
        .limit(1)
        .single();

      if (lastClaim) {
        activeClaimId = lastClaim.id;
        await supabase.from('sms_conversation_state')
          .update({ active_claim_id: lastClaim.id, expires_at: new Date(Date.now() + 2 * 3600000).toISOString() })
          .eq('id', convState!.id);
      }
    }

    // ── 7. Parse intent and route to Darwin ──
    const intent = parseIntent(messageBody);

    // Log activity entry
    const { data: activityRow } = await supabase.from('darwin_sms_activity').insert({
      user_id: userId, phone_number: fromNumber, claim_id: activeClaimId || null,
      direction: 'inbound', message_text: messageBody,
      parsed_intent: intent, status: 'processing',
    }).select('id').single();

    if (intent === 'unknown') {
      // For unknown intents, try a generic response
      const reply = activeClaimId
        ? `I didn't understand that command. Reply HELP for options. Active claim context is set.`
        : `I didn't understand that command. Reply HELP for options, or "Switch [claim #]" to select a claim.`;
      await sendReply(fromNumber, reply);
      if (activityRow) {
        await supabase.from('darwin_sms_activity')
          .update({ status: 'completed', darwin_response: reply })
          .eq('id', activityRow.id);
      }
      return new Response(JSON.stringify({ success: true, intent: 'unknown' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!activeClaimId && intent !== 'financial_qa') {
      const reply = 'No active claim. Reply "Switch [claim #]" or "Claims" to select one.';
      await sendReply(fromNumber, reply);
      if (activityRow) {
        await supabase.from('darwin_sms_activity')
          .update({ status: 'needs_context', darwin_response: reply })
          .eq('id', activityRow.id);
      }
      return new Response(JSON.stringify({ success: true, action: 'needs_claim' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Route to darwin-command for execution
    try {
      const cmdResp = await fetch(`${SUPABASE_URL}/functions/v1/darwin-command`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          commandText: messageBody,
          claimId: activeClaimId,
          route: 'sms',
          createdBy: userId,
        }),
      });
      const cmdResult = await cmdResp.json();
      
      // Build a concise SMS-friendly reply
      let reply: string;
      if (cmdResult.error) {
        reply = `⚠️ ${cmdResult.error}`;
      } else if (cmdResult.answer) {
        reply = cmdResult.answer.substring(0, 1500);
      } else if (cmdResult.result) {
        reply = cmdResult.result.substring(0, 1500);
      } else {
        reply = `✅ ${intent.replace(/_/g, ' ')} complete. Check the app for full results.`;
      }

      await sendReply(fromNumber, reply);

      // Update activity log
      if (activityRow) {
        await supabase.from('darwin_sms_activity')
          .update({ status: 'completed', darwin_response: reply, claim_id: activeClaimId })
          .eq('id', activityRow.id);
      }

      // Log outbound reply
      await supabase.from('darwin_sms_activity').insert({
        user_id: userId, phone_number: fromNumber, claim_id: activeClaimId,
        direction: 'outbound', message_text: reply,
        parsed_intent: intent, status: 'completed',
      });

    } catch (cmdErr) {
      console.error('Darwin command routing error:', cmdErr);
      const errorReply = '⚠️ Something went wrong processing your command. Please try again.';
      await sendReply(fromNumber, errorReply);
      if (activityRow) {
        await supabase.from('darwin_sms_activity')
          .update({ status: 'failed', error_message: String(cmdErr), darwin_response: errorReply })
          .eq('id', activityRow.id);
      }
    }

    return new Response(JSON.stringify({ success: true, intent, claimId: activeClaimId }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Error in telnyx-inbound-sms:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
