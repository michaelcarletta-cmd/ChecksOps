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

/** Decode a string that may be hex or base64 into Uint8Array */
function smartDecode(input: string): Uint8Array {
  // If it looks like hex (only hex chars, even length), decode as hex
  if (/^[0-9a-fA-F]+$/.test(input) && input.length % 2 === 0) {
    const bytes = new Uint8Array(input.length / 2);
    for (let i = 0; i < input.length; i += 2) {
      bytes[i / 2] = parseInt(input.substring(i, i + 2), 16);
    }
    return bytes;
  }
  // Otherwise decode as base64
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Verify Telnyx webhook signature (ed25519) */
async function verifyTelnyxSignature(req: Request, body: string): Promise<boolean> {
  const signature = req.headers.get('telnyx-signature-ed25519');
  const timestamp = req.headers.get('telnyx-timestamp');
  if (!signature || !timestamp) {
    console.warn('Missing Telnyx signature headers');
    return false;
  }
  const timestampMs = parseInt(timestamp, 10) * 1000;
  if (Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) {
    console.warn('Telnyx timestamp outside tolerance window');
    return false;
  }
  try {
    const TELNYX_PUBLIC_KEY = Deno.env.get('TELNYX_PUBLIC_KEY');
    if (!TELNYX_PUBLIC_KEY) {
      console.error('TELNYX_PUBLIC_KEY env var not set — cannot verify webhook');
      return false;
    }
    const signedPayload = `${timestamp}|${body}`;
    const signatureBytes = smartDecode(signature);
    const publicKeyBytes = smartDecode(TELNYX_PUBLIC_KEY);

    console.log(`Sig verify: pubkey ${publicKeyBytes.length}B, sig ${signatureBytes.length}B`);

    const key = await crypto.subtle.importKey('raw', publicKeyBytes, { name: 'Ed25519' }, false, ['verify']);
    const encoder = new TextEncoder();
    return await crypto.subtle.verify('Ed25519', key, signatureBytes, encoder.encode(signedPayload));
  } catch (err) {
    console.error('Signature verification error:', err.message || err);
    return false;
  }
}

/** Send an SMS reply via Telnyx */
async function sendReply(to: string, text: string) {
  const TELNYX_API_KEY = Deno.env.get('TELNYX_API_KEY')!;
  const TELNYX_PHONE_NUMBER = Deno.env.get('TELNYX_PHONE_NUMBER')!;
  const TELNYX_MESSAGING_PROFILE_ID = Deno.env.get('TELNYX_MESSAGING_PROFILE_ID');
  const body: Record<string, string> = { from: TELNYX_PHONE_NUMBER, to, text };
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

/** Send SMS to a client (not the Darwin user, but a claim contact) */
async function sendClientSMS(supabase: any, to: string, body: string, claimId: string, userId: string) {
  const telnyxResp = await sendReply(to, body);
  const telnyxId = telnyxResp?.data?.id || null;
  await supabase.from('sms_messages').insert({
    claim_id: claimId,
    from_number: Deno.env.get('TELNYX_PHONE_NUMBER')!,
    to_number: to,
    message_body: body,
    status: 'sent',
    direction: 'outbound',
    telnyx_message_id: telnyxId,
    created_by: userId,
  });
  return { telnyxId };
}

/** Get claims scoped to user's org (uses claims.org_id for reliable scoping) */
async function getUserOrgClaims(supabase: any, userId: string, options: { search?: string; limit?: number; openOnly?: boolean } = {}) {
  const { search, limit = 5, openOnly = false } = options;
  const { data: orgMember } = await supabase
    .from('org_members').select('org_id').eq('user_id', userId).limit(1).single();
  if (!orgMember?.org_id) return [];
  let query = supabase
    .from('claims')
    .select('id, claim_number, policyholder_name, policyholder_phone, policyholder_email, status, updated_at')
    .eq('org_id', orgMember.org_id);
  if (openOnly) query = query.eq('is_closed', false);
  if (search) query = query.or(`claim_number.ilike.%${search}%,policyholder_name.ilike.%${search}%`);
  query = query.order('updated_at', { ascending: false }).limit(limit);
  const { data } = await query;
  return data || [];
}

/** Get contacts for a claim (policyholder + adjusters) */
async function getClaimContacts(supabase: any, claimId: string) {
  const { data: claim } = await supabase
    .from('claims')
    .select('policyholder_name, policyholder_phone, policyholder_email')
    .eq('id', claimId)
    .single();
  const contacts: Array<{ name: string; phone: string | null; email: string | null; role: string }> = [];
  if (claim) {
    contacts.push({
      name: claim.policyholder_name || 'Policyholder',
      phone: claim.policyholder_phone || null,
      email: claim.policyholder_email || null,
      role: 'Policyholder',
    });
  }
  const { data: adjusters } = await supabase
    .from('claim_adjusters')
    .select('adjuster_name, adjuster_phone, adjuster_email, company')
    .eq('claim_id', claimId);
  for (const adj of (adjusters || [])) {
    contacts.push({
      name: adj.adjuster_name || adj.company || 'Adjuster',
      phone: adj.adjuster_phone || null,
      email: adj.adjuster_email || null,
      role: 'Adjuster',
    });
  }
  return contacts;
}

/** Get the org send_mode setting for a user */
async function getOrgSendMode(supabase: any, userId: string): Promise<{ mode: string; autoSendRoles: string[] }> {
  const { data: orgMember } = await supabase
    .from('org_members').select('org_id, role').eq('user_id', userId).limit(1).single();
  if (!orgMember) return { mode: 'draft', autoSendRoles: ['admin'] };
  const { data: settings } = await supabase
    .from('darwin_sms_settings').select('*').eq('org_id', orgMember.org_id).single();
  if (!settings) return { mode: 'draft', autoSendRoles: ['admin'] };
  return { mode: settings.send_mode, autoSendRoles: settings.auto_send_roles || ['admin'] };
}

/** Check if user has a specific role */
async function userHasRole(supabase: any, userId: string, role: string): Promise<boolean> {
  const { data } = await supabase
    .from('user_roles').select('id').eq('user_id', userId).eq('role', role).limit(1).single();
  return !!data;
}

/** Parse a task from SMS text: extract title and due date */
function parseTaskFromSMS(text: string): { title: string; dueDate: string | null } {
  // Strip intent prefixes
  let cleaned = text
    .replace(/^(task[:\s]+|create\s+task[:\s]*|add\s+task[:\s]*|remind\s+me\s+(to\s+)?|create\s+task\s+for\s+(this\s+claim[:\s]*)?)/i, '')
    .trim();

  let dueDate: string | null = null;
  const now = new Date();

  // "tomorrow"
  if (/\btomorrow\b/i.test(cleaned)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    dueDate = d.toISOString().split('T')[0];
    cleaned = cleaned.replace(/\btomorrow\b/i, '').trim();
  }

  // Day names: "Monday", "Friday", etc.
  const dayMatch = cleaned.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (dayMatch && !dueDate) {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const targetDay = days.indexOf(dayMatch[1].toLowerCase());
    const currentDay = now.getDay();
    let diff = targetDay - currentDay;
    if (diff <= 0) diff += 7;
    const d = new Date(now);
    d.setDate(d.getDate() + diff);
    dueDate = d.toISOString().split('T')[0];
    cleaned = cleaned.replace(dayMatch[0], '').trim();
  }

  // "next week" / "in X days"
  const inDaysMatch = cleaned.match(/\bin\s+(\d+)\s+days?\b/i);
  if (inDaysMatch && !dueDate) {
    const d = new Date(now);
    d.setDate(d.getDate() + parseInt(inDaysMatch[1]));
    dueDate = d.toISOString().split('T')[0];
    cleaned = cleaned.replace(inDaysMatch[0], '').trim();
  }

  // MM/DD or M/D format
  const dateMatch = cleaned.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (dateMatch && !dueDate) {
    const month = parseInt(dateMatch[1]) - 1;
    const day = parseInt(dateMatch[2]);
    const year = now.getFullYear();
    const d = new Date(year, month, day);
    if (d < now) d.setFullYear(year + 1);
    dueDate = d.toISOString().split('T')[0];
    cleaned = cleaned.replace(dateMatch[0], '').trim();
  }

  // Strip trailing time references like "10am", "at 3pm"
  cleaned = cleaned.replace(/\b(at\s+)?\d{1,2}(:\d{2})?\s*(am|pm)\b/gi, '').trim();
  // Clean up extra whitespace and trailing punctuation
  cleaned = cleaned.replace(/\s{2,}/g, ' ').replace(/^[,\s]+|[,\s]+$/g, '');

  // Default: tomorrow if no date found
  if (!dueDate) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    dueDate = d.toISOString().split('T')[0];
  }

  return { title: cleaned || 'Untitled task', dueDate };
}

/** Extract message body from client SMS/email command text */
function extractClientMessageBody(text: string): string {
  return text
    .replace(/^(text\s+client[:\s]*|send\s+sms[:\s]*(client|update|to)?[:\s]*|sms\s+(client|update)[:\s]*|email\s+client[:\s]*(update)?[:\s]*|send\s+email[:\s]*(client|update|to)?[:\s]*|email\s+update[:\s]*)/i, '')
    .trim();
}

/** Mask phone number to last 4 */
function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `...${digits.slice(-4)}`;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const rawBody = await req.text();
    const isValid = await verifyTelnyxSignature(req, rawBody);
    if (!isValid) {
      console.error('Invalid Telnyx webhook signature — rejecting request');
      return new Response(JSON.stringify({ error: 'Invalid signature' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const payload = JSON.parse(rawBody);
    console.log('Telnyx webhook received (verified):', JSON.stringify(payload).slice(0, 500));

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
      .from('user_phone_links').select('user_id, is_verified').eq('phone_number', fromNumber).single();

    // Check for pending verification code
    if (phoneLink && !phoneLink.is_verified) {
      const codeMatch = messageBody.match(/^\d{6}$/);
      if (codeMatch) {
        const { data: linkRow } = await supabase
          .from('user_phone_links').select('*').eq('phone_number', fromNumber).single();
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
      const { data: claims } = await supabase
        .from('claims').select('id, policyholder_phone, adjuster_phone')
        .or(`policyholder_phone.ilike.%${fromLast10}%,adjuster_phone.ilike.%${fromLast10}%`);
      let claimId = claims?.[0]?.id;
      if (!claimId) {
        const { data: adjusters } = await supabase
          .from('claim_adjusters').select('claim_id').ilike('adjuster_phone', `%${fromLast10}%`);
        claimId = adjusters?.[0]?.claim_id;
      }
      if (claimId) {
        await supabase.from('sms_messages').insert({
          claim_id: claimId, from_number: fromNumber, to_number: toNumber || '',
          message_body: messageBody, status: 'received', direction: 'inbound',
          telnyx_message_id: messageId,
        });
        await supabase.from('claims').update({ updated_at: new Date().toISOString() }).eq('id', claimId);
        await supabase.from('claim_updates').insert({
          claim_id: claimId,
          content: `Inbound SMS from ${fromNumber}: "${messageBody.substring(0, 100)}${messageBody.length > 100 ? '...' : ''}"`,
          update_type: 'sms_received',
        });
      }
      await supabase.from('darwin_sms_activity').insert({
        phone_number: fromNumber, claim_id: claimId || null,
        direction: 'inbound', message_text: messageBody,
        status: 'completed', parsed_intent: 'legacy_inbound',
        darwin_response: claimId ? 'Routed to claim (unverified user)' : 'No matching claim or user',
        action_type: 'system',
      });
      return new Response(JSON.stringify({ success: true, claimId, legacy: true }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── 3. Handle HELP command ──
    if (messageBody.toUpperCase() === 'HELP') {
      const helpText = `Darwin Commands:\n• "Analyze claim" - Run AI analysis\n• "Task: <description>" - Create a task\n• "Text client: <msg>" - Send SMS to client\n• "Email client: <msg>" - Send email to client\n• "Switch [claim #]" - Change active claim\n• "Claims" - List your recent claims\n• Financial questions like "What's been paid?"\n\nReply STOP to opt out.`;
      await sendReply(fromNumber, helpText);
      await supabase.from('darwin_sms_activity').insert({
        user_id: userId, phone_number: fromNumber,
        direction: 'inbound', message_text: messageBody,
        parsed_intent: 'help', darwin_response: helpText, status: 'completed',
        action_type: 'command',
      });
      return new Response(JSON.stringify({ success: true, action: 'help' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── 4. Get or create conversation state ──
    let { data: convState } = await supabase
      .from('sms_conversation_state').select('*').eq('phone_number', fromNumber).single();

    if (!convState) {
      const { data: newState } = await supabase
        .from('sms_conversation_state')
        .insert({ user_id: userId, phone_number: fromNumber })
        .select().single();
      convState = newState;
    } else if (new Date(convState.expires_at) < new Date()) {
      await supabase.from('sms_conversation_state')
        .update({ active_claim_id: null, pending_action: null, expires_at: new Date(Date.now() + 2 * 3600000).toISOString() })
        .eq('id', convState.id);
      convState.active_claim_id = null;
      convState.pending_action = null;
    }

    // ── 4a. Handle pending action confirmations (SEND / EDIT / CANCEL / number selection) ──
    const pendingAction = convState?.pending_action;
    if (pendingAction) {
      const upperMsg = messageBody.toUpperCase().trim();

      // CANCEL
      if (upperMsg === 'CANCEL') {
        await supabase.from('sms_conversation_state')
          .update({ pending_action: null }).eq('id', convState!.id);
        await sendReply(fromNumber, '❌ Cancelled.');
        await supabase.from('darwin_sms_activity').insert({
          user_id: userId, phone_number: fromNumber, claim_id: pendingAction.claimId,
          direction: 'inbound', message_text: messageBody, parsed_intent: pendingAction.type,
          darwin_response: 'Cancelled by user.', status: 'completed', action_type: pendingAction.type,
        });
        return new Response(JSON.stringify({ success: true, action: 'cancelled' }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Number selection for recipient disambiguation
      const numMatch = upperMsg.match(/^(\d)$/);
      if (numMatch && pendingAction.recipientPending && pendingAction.candidates) {
        const idx = parseInt(numMatch[1]) - 1;
        const candidates = pendingAction.candidates as Array<{ name: string; phone?: string; email?: string; role: string }>;
        if (idx >= 0 && idx < candidates.length) {
          const selected = candidates[idx];
          const updatedAction = {
            ...pendingAction,
            recipientPending: false,
            to: pendingAction.type === 'send_client_sms' ? selected.phone : selected.email,
            recipientName: selected.name,
          };
          // Now show the draft preview
          const channel = pendingAction.type === 'send_client_sms' ? 'SMS' : 'Email';
          const toDisplay = pendingAction.type === 'send_client_sms'
            ? `${selected.name} (${maskPhone(selected.phone || '')})`
            : `${selected.name} (${selected.email})`;
          const draftReply = `📝 Draft ${channel} to ${toDisplay}:\n"${updatedAction.body}"\n\nReply SEND to send, EDIT <new text> to modify, or CANCEL.`;
          await supabase.from('sms_conversation_state')
            .update({ pending_action: updatedAction }).eq('id', convState!.id);
          await sendReply(fromNumber, draftReply);
          return new Response(JSON.stringify({ success: true, action: 'recipient_selected' }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // EDIT <new text>
      const editMatch = messageBody.match(/^edit\s+(.+)/i);
      if (editMatch) {
        const newBody = editMatch[1].trim();
        const updatedAction = { ...pendingAction, body: newBody };
        await supabase.from('sms_conversation_state')
          .update({ pending_action: updatedAction }).eq('id', convState!.id);
        const channel = pendingAction.type === 'send_client_sms' ? 'SMS' : 'Email';
        const toDisplay = pendingAction.recipientName || 'client';
        const reply = `📝 Updated draft ${channel} to ${toDisplay}:\n"${newBody}"\n\nReply SEND to send, or CANCEL.`;
        await sendReply(fromNumber, reply);
        return new Response(JSON.stringify({ success: true, action: 'edited' }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // SEND
      if (upperMsg === 'SEND') {
        try {
          if (pendingAction.type === 'send_client_sms') {
            await sendClientSMS(supabase, pendingAction.to, pendingAction.body, pendingAction.claimId, userId);
            const reply = `✅ SMS sent to ${pendingAction.recipientName}.`;
            await sendReply(fromNumber, reply);
            await supabase.from('darwin_sms_activity').insert({
              user_id: userId, phone_number: fromNumber, claim_id: pendingAction.claimId,
              direction: 'outbound', message_text: reply, parsed_intent: 'send_client_sms',
              status: 'completed', action_type: 'client_sms', needs_approval: false,
              approved_at: new Date().toISOString(), approved_by: userId,
            });
          } else if (pendingAction.type === 'send_client_email') {
            // Call the send-email edge function
            await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                to: pendingAction.to,
                subject: pendingAction.subject || 'Claim Update',
                body: pendingAction.body,
                claimId: pendingAction.claimId,
              }),
            });
            const reply = `✅ Email sent to ${pendingAction.recipientName}.`;
            await sendReply(fromNumber, reply);
            await supabase.from('darwin_sms_activity').insert({
              user_id: userId, phone_number: fromNumber, claim_id: pendingAction.claimId,
              direction: 'outbound', message_text: reply, parsed_intent: 'send_client_email',
              status: 'completed', action_type: 'client_email', needs_approval: false,
              approved_at: new Date().toISOString(), approved_by: userId,
            });
          }
        } catch (sendErr) {
          const errReply = `⚠️ Failed to send: ${sendErr instanceof Error ? sendErr.message : 'Unknown error'}`;
          await sendReply(fromNumber, errReply);
          await supabase.from('darwin_sms_activity').insert({
            user_id: userId, phone_number: fromNumber, claim_id: pendingAction.claimId,
            direction: 'outbound', message_text: errReply, parsed_intent: pendingAction.type,
            status: 'failed', action_type: pendingAction.type, error_message: String(sendErr),
          });
        }
        // Clear pending action
        await supabase.from('sms_conversation_state')
          .update({ pending_action: null }).eq('id', convState!.id);
        return new Response(JSON.stringify({ success: true, action: 'sent' }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // ── 5. Handle "switch" / "claims" commands (org-scoped) ──
    const switchMatch = messageBody.match(/^switch\s+(.+)/i);
    if (switchMatch) {
      const searchTerm = switchMatch[1].trim();
      const matchedClaims = await getUserOrgClaims(supabase, userId, { search: searchTerm, limit: 1 });
      if (matchedClaims.length > 0) {
        const c = matchedClaims[0];
        await supabase.from('sms_conversation_state')
          .update({ active_claim_id: c.id, pending_action: null, expires_at: new Date(Date.now() + 2 * 3600000).toISOString() })
          .eq('id', convState!.id);
        const reply = `✅ Switched to: ${c.claim_number} — ${c.policyholder_name}`;
        await sendReply(fromNumber, reply);
        await supabase.from('darwin_sms_activity').insert({
          user_id: userId, phone_number: fromNumber, claim_id: c.id,
          direction: 'inbound', message_text: messageBody,
          parsed_intent: 'switch_claim', darwin_response: reply, status: 'completed',
          action_type: 'command',
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
      const recentClaims = await getUserOrgClaims(supabase, userId, { limit: 5 });
      if (recentClaims.length > 0) {
        const list = recentClaims.map((c: any, i: number) => `${i + 1}. ${c.claim_number} — ${c.policyholder_name} (${c.status})`).join('\n');
        const reply = `Recent claims:\n${list}\n\nReply "Switch [claim #]" to select one.`;
        await sendReply(fromNumber, reply);
      } else {
        await sendReply(fromNumber, 'No claims found.');
      }
      return new Response(JSON.stringify({ success: true, action: 'list_claims' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── 6. Resolve active claim context (org-scoped) ──
    let activeClaimId = convState?.active_claim_id;
    if (!activeClaimId) {
      const recentOrgClaims = await getUserOrgClaims(supabase, userId, { limit: 1, openOnly: true });
      if (recentOrgClaims.length > 0) {
        activeClaimId = recentOrgClaims[0].id;
        await supabase.from('sms_conversation_state')
          .update({ active_claim_id: activeClaimId, expires_at: new Date(Date.now() + 2 * 3600000).toISOString() })
          .eq('id', convState!.id);
      }
    }

    // ── 7. Parse intent and route ──
    const intent = parseIntent(messageBody);

    const { data: activityRow } = await supabase.from('darwin_sms_activity').insert({
      user_id: userId, phone_number: fromNumber, claim_id: activeClaimId || null,
      direction: 'inbound', message_text: messageBody,
      parsed_intent: intent, status: 'processing',
      action_type: intent === 'create_task' ? 'task_create' : intent.startsWith('send_client_') ? intent.replace('send_client_', 'client_') : 'command',
    }).select('id').single();

    if (intent === 'unknown') {
      const reply = activeClaimId
        ? `I didn't understand that command. Reply HELP for options. Active claim context is set.`
        : `I didn't understand that command. Reply HELP for options, or "Switch [claim #]" to select a claim.`;
      await sendReply(fromNumber, reply);
      if (activityRow) {
        await supabase.from('darwin_sms_activity')
          .update({ status: 'completed', darwin_response: reply }).eq('id', activityRow.id);
      }
      return new Response(JSON.stringify({ success: true, intent: 'unknown' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Require active claim for most intents
    if (!activeClaimId && intent !== 'financial_qa') {
      const reply = 'No active claim. Reply "Switch [claim #]" or "Claims" to select one.';
      await sendReply(fromNumber, reply);
      if (activityRow) {
        await supabase.from('darwin_sms_activity')
          .update({ status: 'needs_context', darwin_response: reply }).eq('id', activityRow.id);
      }
      return new Response(JSON.stringify({ success: true, action: 'needs_claim' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── 8. CREATE TASK ──
    if (intent === 'create_task') {
      const { title, dueDate } = parseTaskFromSMS(messageBody);
      const { data: task, error: taskErr } = await supabase.from('tasks').insert({
        claim_id: activeClaimId,
        title,
        due_date: dueDate,
        status: 'pending',
        created_by: userId,
      }).select('id, title, due_date').single();

      if (taskErr) {
        const errReply = `⚠️ Failed to create task: ${taskErr.message}`;
        await sendReply(fromNumber, errReply);
        if (activityRow) {
          await supabase.from('darwin_sms_activity')
            .update({ status: 'failed', error_message: taskErr.message, darwin_response: errReply }).eq('id', activityRow.id);
        }
      } else {
        const reply = `✅ Task created: "${task.title}" due ${task.due_date}. Visible in CRM.`;
        await sendReply(fromNumber, reply);
        if (activityRow) {
          await supabase.from('darwin_sms_activity')
            .update({ status: 'completed', darwin_response: reply, result_id: task.id, action_type: 'task_create' }).eq('id', activityRow.id);
        }
        // Log to claim activity
        await supabase.from('claim_updates').insert({
          claim_id: activeClaimId,
          content: `Task created via SMS: "${task.title}" due ${task.due_date}`,
          update_type: 'task_created',
          created_by: userId,
        });
      }
      return new Response(JSON.stringify({ success: true, action: 'task_created', taskId: task?.id }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── 9. SEND CLIENT SMS ──
    if (intent === 'send_client_sms') {
      const body = extractClientMessageBody(messageBody);
      if (!body) {
        const reply = 'Please include a message. Example: "Text client: We\'re scheduled Tuesday at 9am"';
        await sendReply(fromNumber, reply);
        if (activityRow) await supabase.from('darwin_sms_activity').update({ status: 'completed', darwin_response: reply }).eq('id', activityRow.id);
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const contacts = await getClaimContacts(supabase, activeClaimId!);
      const smsContacts = contacts.filter(c => c.phone);

      if (smsContacts.length === 0) {
        const reply = '⚠️ No phone numbers found on this claim. Add a policyholder or adjuster phone first.';
        await sendReply(fromNumber, reply);
        if (activityRow) await supabase.from('darwin_sms_activity').update({ status: 'failed', darwin_response: reply }).eq('id', activityRow.id);
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // Check send mode
      const { mode: sendMode } = await getOrgSendMode(supabase, userId);
      const isAdmin = await userHasRole(supabase, userId, 'admin');
      const autoSend = sendMode === 'auto_send' && isAdmin;

      if (smsContacts.length > 1 && !autoSend) {
        // Disambiguation
        const list = smsContacts.map((c, i) => `${i + 1}. ${c.name} (${c.role}) ${maskPhone(c.phone!)}`).join('\n');
        const reply = `Multiple contacts found:\n${list}\n\nReply with a number to select.`;
        await supabase.from('sms_conversation_state').update({
          pending_action: { type: 'send_client_sms', claimId: activeClaimId, body, recipientPending: true, candidates: smsContacts },
        }).eq('id', convState!.id);
        await sendReply(fromNumber, reply);
        if (activityRow) await supabase.from('darwin_sms_activity').update({ status: 'completed', darwin_response: reply, needs_approval: true }).eq('id', activityRow.id);
        return new Response(JSON.stringify({ success: true, action: 'disambiguation' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const target = smsContacts[0];

      if (autoSend) {
        // Auto-send mode
        await sendClientSMS(supabase, target.phone!, body, activeClaimId!, userId);
        const reply = `✅ SMS sent to ${target.name}.`;
        await sendReply(fromNumber, reply);
        if (activityRow) await supabase.from('darwin_sms_activity').update({ status: 'completed', darwin_response: reply, action_type: 'client_sms', result_id: target.phone }).eq('id', activityRow.id);
      } else {
        // Draft mode
        const draftReply = `📝 Draft SMS to ${target.name} (${maskPhone(target.phone!)}):\n"${body}"\n\nReply SEND to send, EDIT <new text> to modify, or CANCEL.`;
        await supabase.from('sms_conversation_state').update({
          pending_action: { type: 'send_client_sms', claimId: activeClaimId, to: target.phone, body, recipientName: target.name, recipientPending: false },
        }).eq('id', convState!.id);
        await sendReply(fromNumber, draftReply);
        if (activityRow) await supabase.from('darwin_sms_activity').update({ status: 'completed', darwin_response: draftReply, needs_approval: true, action_type: 'client_sms' }).eq('id', activityRow.id);
      }
      return new Response(JSON.stringify({ success: true, action: autoSend ? 'sent' : 'draft' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── 10. SEND CLIENT EMAIL ──
    if (intent === 'send_client_email') {
      const body = extractClientMessageBody(messageBody);
      if (!body) {
        const reply = 'Please include a message. Example: "Email client: carrier approved the estimate"';
        await sendReply(fromNumber, reply);
        if (activityRow) await supabase.from('darwin_sms_activity').update({ status: 'completed', darwin_response: reply }).eq('id', activityRow.id);
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const contacts = await getClaimContacts(supabase, activeClaimId!);
      const emailContacts = contacts.filter(c => c.email);

      if (emailContacts.length === 0) {
        const reply = '⚠️ No email addresses found on this claim. Add a policyholder or adjuster email first.';
        await sendReply(fromNumber, reply);
        if (activityRow) await supabase.from('darwin_sms_activity').update({ status: 'failed', darwin_response: reply }).eq('id', activityRow.id);
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const { mode: sendMode } = await getOrgSendMode(supabase, userId);
      const isAdmin = await userHasRole(supabase, userId, 'admin');
      const autoSend = sendMode === 'auto_send' && isAdmin;

      if (emailContacts.length > 1 && !autoSend) {
        const list = emailContacts.map((c, i) => `${i + 1}. ${c.name} (${c.role}) ${c.email}`).join('\n');
        const reply = `Multiple email contacts found:\n${list}\n\nReply with a number to select.`;
        await supabase.from('sms_conversation_state').update({
          pending_action: { type: 'send_client_email', claimId: activeClaimId, body, subject: 'Claim Update', recipientPending: true, candidates: emailContacts },
        }).eq('id', convState!.id);
        await sendReply(fromNumber, reply);
        if (activityRow) await supabase.from('darwin_sms_activity').update({ status: 'completed', darwin_response: reply, needs_approval: true }).eq('id', activityRow.id);
        return new Response(JSON.stringify({ success: true, action: 'disambiguation' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const target = emailContacts[0];

      if (autoSend) {
        await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: target.email, subject: 'Claim Update', body, claimId: activeClaimId }),
        });
        const reply = `✅ Email sent to ${target.name}.`;
        await sendReply(fromNumber, reply);
        if (activityRow) await supabase.from('darwin_sms_activity').update({ status: 'completed', darwin_response: reply, action_type: 'client_email' }).eq('id', activityRow.id);
      } else {
        const draftReply = `📝 Draft Email to ${target.name} (${target.email}):\nSubject: Claim Update\n"${body}"\n\nReply SEND to send, EDIT <new text> to modify, or CANCEL.`;
        await supabase.from('sms_conversation_state').update({
          pending_action: { type: 'send_client_email', claimId: activeClaimId, to: target.email, body, subject: 'Claim Update', recipientName: target.name, recipientPending: false },
        }).eq('id', convState!.id);
        await sendReply(fromNumber, draftReply);
        if (activityRow) await supabase.from('darwin_sms_activity').update({ status: 'completed', darwin_response: draftReply, needs_approval: true, action_type: 'client_email' }).eq('id', activityRow.id);
      }
      return new Response(JSON.stringify({ success: true, action: autoSend ? 'sent' : 'draft' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── 11. Route remaining intents to darwin-command ──
    try {
      const cmdResp = await fetch(`${SUPABASE_URL}/functions/v1/darwin-command`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ commandText: messageBody, claimId: activeClaimId, route: 'sms', createdBy: userId }),
      });
      const cmdResult = await cmdResp.json();

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
      if (activityRow) {
        await supabase.from('darwin_sms_activity')
          .update({ status: 'completed', darwin_response: reply, claim_id: activeClaimId }).eq('id', activityRow.id);
      }
      await supabase.from('darwin_sms_activity').insert({
        user_id: userId, phone_number: fromNumber, claim_id: activeClaimId,
        direction: 'outbound', message_text: reply,
        parsed_intent: intent, status: 'completed', action_type: 'command',
      });
    } catch (cmdErr) {
      console.error('Darwin command routing error:', cmdErr);
      const errorReply = '⚠️ Something went wrong processing your command. Please try again.';
      await sendReply(fromNumber, errorReply);
      if (activityRow) {
        await supabase.from('darwin_sms_activity')
          .update({ status: 'failed', error_message: String(cmdErr), darwin_response: errorReply }).eq('id', activityRow.id);
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
