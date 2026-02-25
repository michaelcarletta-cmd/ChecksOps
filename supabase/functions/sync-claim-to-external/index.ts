import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const syncSecret = Deno.env.get('CLAIM_SYNC_SECRET');

    if (!syncSecret) {
      throw new Error('CLAIM_SYNC_SECRET not configured');
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { claim_id, target_instance_url, instance_name, include_accounting } = await req.json();

    // Normalize the URL - strip trailing slashes and remove webhook path if included
    let baseUrl = target_instance_url.replace(/\/+$/, '');
    if (baseUrl.includes('/functions/v1/claim-sync-webhook')) {
      baseUrl = baseUrl.replace('/functions/v1/claim-sync-webhook', '');
    }

    console.log(`Syncing claim ${claim_id} to ${baseUrl}`);

    // Fetch the claim data
    const { data: claim, error: claimError } = await supabase
      .from('claims')
      .select('*')
      .eq('id', claim_id)
      .single();

    if (claimError || !claim) {
      console.error('Error fetching claim:', claimError);
      throw new Error('Claim not found');
    }

    // Prepare claim data for sync
    const claimData = {
      claim_number: claim.claim_number,
      policyholder_name: claim.policyholder_name,
      policyholder_email: claim.policyholder_email,
      policyholder_phone: claim.policyholder_phone,
      policyholder_address: claim.policyholder_address,
      insurance_company: claim.insurance_company,
      insurance_phone: claim.insurance_phone,
      insurance_email: claim.insurance_email,
      loss_type: claim.loss_type,
      loss_date: claim.loss_date,
      loss_description: claim.loss_description,
      policy_number: claim.policy_number,
      status: claim.status,
      claim_amount: claim.claim_amount,
      instance_name: 'Freedom Claims', // Our instance name
    };

    // Fetch accounting data if requested
    let accountingData = null;
    if (include_accounting) {
      const { data: settlements } = await supabase
        .from('claim_settlements')
        .select('*')
        .eq('claim_id', claim_id);

      const { data: checks } = await supabase
        .from('claim_checks')
        .select('*')
        .eq('claim_id', claim_id);

      const { data: expenses } = await supabase
        .from('claim_expenses')
        .select('*')
        .eq('claim_id', claim_id);

      const { data: fees } = await supabase
        .from('claim_fees')
        .select('*')
        .eq('claim_id', claim_id);

      accountingData = {
        settlements: settlements || [],
        checks: checks || [],
        expenses: expenses || [],
        fees: fees || [],
      };
    }

    // Send to external instance
    const syncUrl = `${baseUrl}/functions/v1/claim-sync-webhook`;
    console.log(`Sending sync request to: ${syncUrl}`);
    console.log(`CLAIM_SYNC_SECRET exists: ${!!syncSecret}, length: ${syncSecret?.length}, value starts with: "${syncSecret?.substring(0, 8)}"`);
    
    const headers = {
      'Content-Type': 'application/json',
      'x-claim-sync-secret': syncSecret,
    };
    console.log('Request headers being sent:', JSON.stringify(headers));

    const response = await fetch(syncUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-claim-sync-secret': syncSecret,
      },
      body: JSON.stringify({
        action: 'create_or_update',
        claim_data: claimData,
        external_claim_id: claim_id,
        source_instance_url: supabaseUrl,
        accounting_data: accountingData,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('External sync failed:', errorText);
      throw new Error(`External sync failed: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    console.log('Sync response:', result);

    // Check if linked_claims record exists
    const { data: existingLink } = await supabase
      .from('linked_claims')
      .select('id')
      .eq('claim_id', claim_id)
      .eq('external_instance_url', target_instance_url)
      .single();

    if (existingLink) {
      // Update existing link
      await supabase
        .from('linked_claims')
        .update({
          external_claim_id: result.claim_id,
          sync_status: 'synced',
          last_synced_at: new Date().toISOString(),
        })
        .eq('id', existingLink.id);
    } else {
      // Create new link
      await supabase
        .from('linked_claims')
        .insert({
          claim_id: claim_id,
          external_instance_url: target_instance_url,
          external_claim_id: result.claim_id,
          instance_name: instance_name || 'External Instance',
          sync_status: 'synced',
          last_synced_at: new Date().toISOString(),
        });
    }

    // Log activity
    await supabase
      .from('claim_updates')
      .insert({
        claim_id: claim_id,
        content: `Claim synced to ${instance_name || target_instance_url}`,
        update_type: 'sync',
      });

    console.log(`Successfully synced claim ${claim_id} to ${target_instance_url}`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        external_claim_id: result.claim_id,
        message: 'Claim synced successfully'
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    console.error('Sync to external error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
