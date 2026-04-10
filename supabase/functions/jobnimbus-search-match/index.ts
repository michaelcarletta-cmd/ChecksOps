import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const JOBNIMBUS_API_BASE = 'https://app.jobnimbus.com/api1';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { claimId, action } = await req.json();

    if (!claimId) {
      return new Response(JSON.stringify({ error: 'claimId is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get claim details
    const { data: claim, error: claimError } = await supabase
      .from('claims')
      .select('id, policyholder_name, policyholder_address, claim_number, contractor_id, jobnimbus_job_id')
      .eq('id', claimId)
      .single();

    console.log('Claim query result:', JSON.stringify({ claim, claimError }));
    if (claimError || !claim) {
      return new Response(JSON.stringify({ error: 'Claim not found', details: claimError?.message }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get API key - try contractor's key first, then fall back to company key
    let apiKey: string | undefined;
    if (claim.contractor_id) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('jobnimbus_api_key')
        .eq('id', claim.contractor_id)
        .single();
      apiKey = profile?.jobnimbus_api_key;
    }
    if (!apiKey) {
      apiKey = Deno.env.get('JOBNIMBUS_API_KEY');
    }

    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'No JobNimbus API key configured' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // If action is "link", link the claim to a specific JN job
    if (action === 'link') {
      const { jobnimbusJobId } = await req.json().catch(() => ({}));
      // Re-parse since we already consumed the body - use the full body
      return new Response(JSON.stringify({ error: 'Use the link endpoint with jobnimbusJobId' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Search JobNimbus for potential matches
    const candidates = await searchJobNimbus(apiKey, claim);

    return new Response(JSON.stringify({ 
      claim: {
        id: claim.id,
        name: claim.policyholder_name,
        address: claim.policyholder_address,
        claimNumber: claim.claim_number,
        linkedJobId: claim.jobnimbus_job_id,
      },
      candidates,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error in jobnimbus-search-match:', error);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

async function searchJobNimbus(apiKey: string, claim: any) {
  const candidates: any[] = [];
  const seenIds = new Set<string>();

  // Search by name
  if (claim.policyholder_name) {
    const nameResults = await queryJN(apiKey, claim.policyholder_name);
    for (const job of nameResults) {
      if (!seenIds.has(job.jnid)) {
        seenIds.add(job.jnid);
        candidates.push(formatCandidate(job, claim));
      }
    }
  }

  // Search by claim number in custom fields
  if (claim.claim_number) {
    const claimResults = await queryJN(apiKey, claim.claim_number);
    for (const job of claimResults) {
      if (!seenIds.has(job.jnid)) {
        seenIds.add(job.jnid);
        candidates.push(formatCandidate(job, claim));
      }
    }
  }

  // Sort by match confidence (highest first)
  candidates.sort((a, b) => b.confidence - a.confidence);

  return candidates.slice(0, 10);
}

async function queryJN(apiKey: string, searchTerm: string) {
  try {
    const url = `${JOBNIMBUS_API_BASE}/jobs?filter=contains(display_name,"${encodeURIComponent(searchTerm)}")&count=20`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      // Try alternative search
      const altUrl = `${JOBNIMBUS_API_BASE}/jobs?keyword=${encodeURIComponent(searchTerm)}&count=20`;
      const altResponse = await fetch(altUrl, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      if (!altResponse.ok) {
        console.error(`JN search failed for "${searchTerm}": ${altResponse.status}`);
        return [];
      }
      const altData = await altResponse.json();
      return altData.results || altData || [];
    }

    const data = await response.json();
    return data.results || data || [];
  } catch (err) {
    console.error(`JN query error for "${searchTerm}":`, err);
    return [];
  }
}

function formatCandidate(job: any, claim: any) {
  let confidence = 0;

  const jnName = (job.primary?.name || job.display_name || '').toLowerCase().trim();
  const claimName = (claim.policyholder_name || '').toLowerCase().trim();

  // Name matching
  if (jnName && claimName) {
    if (jnName === claimName) {
      confidence += 50;
    } else if (jnName.includes(claimName) || claimName.includes(jnName)) {
      confidence += 35;
    } else {
      // Check last name match
      const jnParts = jnName.split(/\s+/);
      const claimParts = claimName.split(/\s+/);
      const jnLast = jnParts[jnParts.length - 1];
      const claimLast = claimParts[claimParts.length - 1];
      if (jnLast && claimLast && jnLast === claimLast) {
        confidence += 25;
      }
    }
  }

  // Address matching
  const jnAddress = (job.location?.address || job.address_line1 || '').toLowerCase();
  const claimAddress = (claim.policyholder_address || '').toLowerCase();
  if (jnAddress && claimAddress) {
    // Extract street number for quick comparison
    const jnNum = jnAddress.match(/^\d+/)?.[0];
    const claimNum = claimAddress.match(/^\d+/)?.[0];
    if (jnNum && claimNum && jnNum === claimNum) {
      confidence += 30;
    }
    if (jnAddress.includes(claimAddress) || claimAddress.includes(jnAddress)) {
      confidence += 20;
    }
  }

  // Claim number match
  const jnClaimNum = (job.cf_claim_number || job.number || '').toLowerCase();
  const claimNum = (claim.claim_number || '').toLowerCase();
  if (jnClaimNum && claimNum && jnClaimNum === claimNum) {
    confidence += 30;
  }

  return {
    jnid: job.jnid,
    name: job.primary?.name || job.display_name || 'Unknown',
    address: job.location?.address || job.address_line1 || '',
    status: job.status_name || job.status || '',
    claimNumber: job.cf_claim_number || job.number || '',
    created: job.date_created || '',
    confidence: Math.min(confidence, 100),
  };
}
