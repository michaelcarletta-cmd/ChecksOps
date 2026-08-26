import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Validate webhook secret
    const webhookSecret = Deno.env.get('SIGNATURE_WEBHOOK_SECRET');
    const providedSecret = req.headers.get('x-webhook-secret');
    
    if (!webhookSecret || providedSecret !== webhookSecret) {
      console.error("Invalid or missing webhook secret");
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();
    console.log("Received signature webhook:", JSON.stringify(body));

    // Extract data from webhook payload (supports Zapier and Adobe Sign formats)
    const {
      claim_id,
      claim_number,
      policy_number,
      document_name,
      signer_email,
      signer_name,
      signed_at,
      agreement_id,
      status,
      signed_document_url,
      event_type
    } = body;

    // Determine which claim this belongs to
    let targetClaimId = claim_id;
    
    if (!targetClaimId && (claim_number || policy_number)) {
      // Try to find claim by claim_number or policy_number
      const { data: claim } = await supabase
        .from('claims')
        .select('id')
        .or(`claim_number.eq.${claim_number},policy_number.eq.${policy_number}`)
        .maybeSingle();
      
      if (claim) {
        targetClaimId = claim.id;
      }
    }

    if (!targetClaimId) {
      console.log("No claim found for webhook, logging event only");
      return new Response(
        JSON.stringify({ 
          success: true, 
          message: 'Webhook received but no claim matched',
          received: body 
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Log the signature event as a claim update
    const eventDescription = status === 'SIGNED' || event_type === 'AGREEMENT_ALL_SIGNED'
      ? `✅ Document "${document_name || 'Agreement'}" signed by ${signer_name || signer_email || 'signer'}`
      : `📝 Signature event: ${event_type || status || 'update'} for "${document_name || 'Agreement'}"`;

    console.log("[signature-webhook]", targetClaimId, eventDescription);

    // If there's a signed document URL, we could download and store it
    // For now, just log it
    if (signed_document_url) {
      console.log("Signed document available at:", signed_document_url);
      
    }

    // Update the claims table to reflect activity
    await supabase
      .from('claims')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', targetClaimId);

    console.log(`Signature webhook processed for claim ${targetClaimId}`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        claim_id: targetClaimId,
        message: 'Signature event logged to claim'
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('Signature webhook error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
