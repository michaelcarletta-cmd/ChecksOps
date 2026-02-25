import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const payload = await req.json();
    console.log('Telnyx status webhook received:', JSON.stringify(payload));

    const eventType = payload.data?.event_type;
    const messagePayload = payload.data?.payload;
    
    // Handle message status events
    if (!eventType?.startsWith('message.')) {
      console.log('Ignoring non-message event:', eventType);
      return new Response(JSON.stringify({ success: true, ignored: true }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const telnyxMessageId = messagePayload?.id;
    const status = messagePayload?.to?.[0]?.status || eventType?.replace('message.', '');
    
    if (!telnyxMessageId) {
      console.log('No message ID in payload');
      return new Response(JSON.stringify({ success: true, ignored: true }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`Status update for message ${telnyxMessageId}: ${status}`);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Map Telnyx status to our status
    let mappedStatus = status;
    if (status === 'delivered' || status === 'sent') {
      mappedStatus = status;
    } else if (status === 'sending' || status === 'queued') {
      mappedStatus = 'sending';
    } else if (status === 'delivery_failed' || status === 'sending_failed') {
      mappedStatus = 'failed';
    }

    // Update the SMS message status
    const { data, error } = await supabase
      .from('sms_messages')
      .update({ 
        status: mappedStatus,
        updated_at: new Date().toISOString()
      })
      .eq('telnyx_message_id', telnyxMessageId)
      .select()
      .single();

    if (error) {
      console.log('Could not update message status:', error.message);
      // Don't fail - message might not exist yet or already processed
    } else {
      console.log('Updated SMS status:', data?.id, mappedStatus);
    }

    return new Response(
      JSON.stringify({ success: true, status: mappedStatus }),
      { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  } catch (error: any) {
    console.error('Error in telnyx-sms-status function:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  }
});
