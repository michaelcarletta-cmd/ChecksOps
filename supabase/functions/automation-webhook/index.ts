import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-signature',
};

// HMAC signature verification using Web Crypto API
async function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    
    const signatureBuffer = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(payload)
    );
    
    const expectedSignature = Array.from(new Uint8Array(signatureBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    
    // Constant-time comparison to prevent timing attacks
    if (signature.length !== expectedSignature.length) {
      return false;
    }
    
    let result = 0;
    for (let i = 0; i < signature.length; i++) {
      result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
    }
    
    return result === 0;
  } catch (error) {
    console.error("Signature verification error:", error);
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const webhookSecret = Deno.env.get('AUTOMATION_WEBHOOK_SECRET');
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get the raw body for signature verification
    const bodyText = await req.text();
    
    // Verify webhook signature if secret is configured
    if (webhookSecret) {
      const signature = req.headers.get('x-webhook-signature');
      
      if (!signature) {
        console.warn("Webhook request missing signature header");
        return new Response(
          JSON.stringify({ error: 'Missing webhook signature' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      const isValid = await verifyWebhookSignature(bodyText, signature, webhookSecret);
      
      if (!isValid) {
        console.warn("Invalid webhook signature");
        return new Response(
          JSON.stringify({ error: 'Invalid webhook signature' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      console.log("Webhook signature verified successfully");
    } else {
      console.warn("AUTOMATION_WEBHOOK_SECRET not configured - webhook signature verification disabled");
    }

    const { automation_id, claim_id, trigger_data } = JSON.parse(bodyText);

    if (!automation_id) {
      return new Response(
        JSON.stringify({ error: 'automation_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Verify automation exists and is active
    const { data: automation, error: automationError } = await supabase
      .from('automations')
      .select('*')
      .eq('id', automation_id)
      .eq('is_active', true)
      .eq('trigger_type', 'webhook')
      .single();

    if (automationError || !automation) {
      return new Response(
        JSON.stringify({ error: 'Automation not found or not active' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Create execution record
    const { data: execution, error: executionError } = await supabase
      .from('automation_executions')
      .insert({
        automation_id,
        claim_id,
        trigger_data: trigger_data || {},
        status: 'pending'
      })
      .select()
      .single();

    if (executionError) throw executionError;

    // Trigger the execution function
    await supabase.functions.invoke('execute-automations');

    return new Response(
      JSON.stringify({ 
        success: true, 
        execution_id: execution.id,
        message: 'Automation triggered successfully'
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('Webhook error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
