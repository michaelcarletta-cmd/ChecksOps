import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

const JOBNIMBUS_API_BASE = 'https://app.jobnimbus.com/api1';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Allow calls from pg_cron (with Authorization header) or with CRON_SECRET
  const cronSecret = Deno.env.get('CRON_SECRET');
  const providedSecret = req.headers.get('x-cron-secret');
  const authHeader = req.headers.get('authorization');
  
  const hasCronSecret = cronSecret && providedSecret === cronSecret;
  const hasAuthHeader = !!authHeader; // pg_cron sends anon key
  
  if (!hasCronSecret && !hasAuthHeader) {
    console.error('Invalid or missing authorization');
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log('Processing JobNimbus sync queue...');

    // Get pending sync items
    const { data: pendingItems, error: fetchError } = await supabase
      .from('jobnimbus_sync_queue')
      .select(`
        *,
        claims (*)
      `)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(10);

    if (fetchError) {
      console.error('Error fetching sync queue:', fetchError);
      throw fetchError;
    }

    if (!pendingItems || pendingItems.length === 0) {
      console.log('No pending sync items');
      return new Response(JSON.stringify({ message: 'No pending items' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`Processing ${pendingItems.length} sync items`);

    const results = [];

    for (const item of pendingItems) {
      try {
        // Mark as processing
        await supabase
          .from('jobnimbus_sync_queue')
          .update({ status: 'processing' })
          .eq('id', item.id);

        const apiKey = Deno.env.get('JOBNIMBUS_API_KEY');
        if (!apiKey) {
          throw new Error('No JobNimbus API key configured');
        }

        const claim = item.claims;
        let result;

        switch (item.sync_type) {
          case 'claim':
            result = await syncClaim(apiKey, claim, supabase);
            break;
          case 'task':
            result = await syncTask(apiKey, claim, item.payload);
            break;
          case 'note':
            result = await syncNote(apiKey, claim, item.payload, supabase);
            break;
          case 'file':
            result = await syncFile(apiKey, claim, item.payload, supabase);
            break;
          case 'inspection':
            result = await syncInspection(apiKey, claim, item.payload, supabase);
            break;
          default:
            throw new Error(`Unknown sync type: ${item.sync_type}`);
        }

        // Mark as completed
        await supabase
          .from('jobnimbus_sync_queue')
          .update({ 
            status: 'completed', 
            processed_at: new Date().toISOString() 
          })
          .eq('id', item.id);

        results.push({ id: item.id, status: 'completed', result });

      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`Error processing item ${item.id}:`, error);
        
        await supabase
          .from('jobnimbus_sync_queue')
          .update({ 
            status: 'failed', 
            error_message: errorMessage,
            processed_at: new Date().toISOString() 
          })
          .eq('id', item.id);

        results.push({ id: item.id, status: 'failed', error: errorMessage });
      }
    }

    return new Response(JSON.stringify({ processed: results.length, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error in process-jobnimbus-sync:', error);
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

async function syncClaim(apiKey: string, claim: any, supabase: any) {
  console.log(`Syncing claim ${claim.id} to JobNimbus`);

  let jobId = claim.jobnimbus_job_id;

  const policyholderName = (claim.policyholder_name || '').trim();
  const primaryName = policyholderName || claim.claim_number || 'Unknown';

  // Split name into first/last for contact
  const nameParts = primaryName.split(/\s+/);
  const firstName = nameParts[0] || primaryName;
  const lastName = nameParts.slice(1).join(' ') || '';

  if (jobId) {
    // Update existing job
    const jobData: Record<string, any> = {
      name: primaryName,
      status_name: mapStatusToJobNimbus(claim.status),
      description: claim.loss_description || '',
      location: { address: claim.policyholder_address || '' },
    };
    if (claim.claim_number) jobData.number = claim.claim_number;

    const response = await fetch(`${JOBNIMBUS_API_BASE}/jobs/${jobId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(jobData),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`JobNimbus API error: ${response.status} - ${errorText}`);
    }

    return await response.json();
  }

  // --- Create new: first create/find a contact, then create the job ---
  // Step 1: Create a contact for the policyholder
  const contactData: Record<string, any> = {
    first_name: firstName,
    last_name: lastName,
    display_name: primaryName,
    record_type_name: 'Customer',
  };
  if (claim.policyholder_email) contactData.email = claim.policyholder_email;
  if (claim.policyholder_phone) contactData.home_phone = claim.policyholder_phone;
  if (claim.policyholder_address) {
    contactData.address_line1 = claim.policyholder_address;
  }

  console.log('Creating JN contact:', JSON.stringify(contactData));

  const contactResponse = await fetch(`${JOBNIMBUS_API_BASE}/contacts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(contactData),
  });

  if (!contactResponse.ok) {
    const errorText = await contactResponse.text();
    throw new Error(`JobNimbus contact creation error: ${contactResponse.status} - ${errorText}`);
  }

  const contact = await contactResponse.json();
  const contactId = contact.jnid;
  console.log(`Created JN contact ${contactId}`);

  // Step 2: Create the job linked to the contact
  const jobData: Record<string, any> = {
    name: primaryName,
    status_name: mapStatusToJobNimbus(claim.status),
    description: claim.loss_description || '',
    location: { address: claim.policyholder_address || '' },
    primary: { id: contactId, type: 'contact' },
    related: [{ id: contactId, type: 'contact' }],
  };
  if (claim.claim_number) jobData.number = claim.claim_number;

  console.log('Creating JN job:', JSON.stringify(jobData));

  const jobResponse = await fetch(`${JOBNIMBUS_API_BASE}/jobs`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(jobData),
  });

  if (!jobResponse.ok) {
    const errorText = await jobResponse.text();
    throw new Error(`JobNimbus job creation error: ${jobResponse.status} - ${errorText}`);
  }

  const result = await jobResponse.json();

  // Save JobNimbus job ID back to claim
  if (result.jnid) {
    await supabase
      .from('claims')
      .update({ jobnimbus_job_id: result.jnid })
      .eq('id', claim.id);
    console.log(`Saved JN job ID ${result.jnid} to claim ${claim.id}`);
  }

  return result;
}

async function syncTask(apiKey: string, claim: any, payload: any) {
  console.log(`Syncing task to JobNimbus for claim ${claim?.id}`);
  
  const taskData = payload?.data;
  if (!taskData) return { skipped: true };

  const jobId = claim?.jobnimbus_job_id;
  if (!jobId) {
    console.log('No JobNimbus job ID, skipping task sync');
    return { skipped: true, reason: 'No JobNimbus job ID' };
  }

  const response = await fetch(`${JOBNIMBUS_API_BASE}/tasks`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: taskData.title || 'Task',
      description: taskData.description || '',
      primary: { id: jobId, type: 'job', name: claim?.policyholder_name || '' },
      related: [{ id: jobId, type: 'job', name: claim?.policyholder_name || '' }],
      date_due: taskData.due_date || null,
      is_completed: taskData.status === 'completed',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`JobNimbus task sync error: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

async function syncNote(apiKey: string, claim: any, payload: any, supabase: any) {
  console.log(`Syncing note to JobNimbus for claim ${claim?.id}`);
  
  const noteData = payload?.data;
  if (!noteData) return { skipped: true };

  const jobId = claim?.jobnimbus_job_id;
  if (!jobId) {
    console.log('No JobNimbus job ID, skipping note sync');
    return { skipped: true, reason: 'No JobNimbus job ID' };
  }

  // Look up assigned staff AND contractors' JN user IDs to tag them
  let owners: string[] = [];
  try {
    // Get staff assigned to claim
    const { data: staffRows } = await supabase
      .from('claim_staff')
      .select('staff_id')
      .eq('claim_id', claim.id);

    // Get contractors assigned to claim
    const { data: contractorRows } = await supabase
      .from('claim_contractors')
      .select('contractor_id')
      .eq('claim_id', claim.id);

    const allIds = [
      ...(staffRows || []).map((r: any) => r.staff_id),
      ...(contractorRows || []).map((r: any) => r.contractor_id),
    ];

    if (allIds.length > 0) {
      const uniqueIds = [...new Set(allIds)];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('jobnimbus_user_id')
        .in('id', uniqueIds)
        .not('jobnimbus_user_id', 'is', null);

      if (profiles) {
        owners = profiles.map((p: any) => p.jobnimbus_user_id).filter(Boolean);
      }
    }
    console.log(`Note owners for JN tagging: ${JSON.stringify(owners)}`);
  } catch (err) {
    console.error('Error looking up JN owners, proceeding without:', err);
  }

  const activityBody: Record<string, any> = {
    record_type_name: 'Note',
    note: noteData.content || '',
    primary: { id: jobId, type: 'job', name: claim?.policyholder_name || '' },
    related: [{ id: jobId, type: 'job', name: claim?.policyholder_name || '' }],
  };

  // Add owners to notify them in JN
  if (owners.length > 0) {
    activityBody.owners = owners.map(id => ({ id }));
  }

  const response = await fetch(`${JOBNIMBUS_API_BASE}/activities`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(activityBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`JobNimbus note sync error: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

async function syncFile(apiKey: string, claim: any, payload: any, supabase: any) {
  console.log(`Syncing file to JobNimbus for claim ${claim?.id}`);
  
  const fileData = payload?.data;
  if (!fileData) return { skipped: true };

  const jobId = claim?.jobnimbus_job_id;
  if (!jobId) {
    console.log('No JobNimbus job ID, skipping file sync');
    return { skipped: true, reason: 'No JobNimbus job ID' };
  }

  // Get file URL from Supabase storage
  const { data: signedUrl } = await supabase.storage
    .from('claim-files')
    .createSignedUrl(fileData.file_path, 3600);

  if (!signedUrl?.signedUrl) {
    throw new Error('Could not get signed URL for file');
  }

  // JobNimbus file upload via URL
  const response = await fetch(`${JOBNIMBUS_API_BASE}/documents`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filename: fileData.file_name || 'file',
      url: signedUrl.signedUrl,
      primary: { id: jobId, type: 'job', name: claim?.policyholder_name || '' },
      related: [{ id: jobId, type: 'job', name: claim?.policyholder_name || '' }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`JobNimbus file sync error: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

function mapStatusToJobNimbus(status: string): string {
  const statusMap: Record<string, string> = {
    'open': 'Lead',
    'in_progress': 'Contract Signed',
    'pending': 'Lead',
    'closed': 'Job Completed',
    'lost': 'Lost',
  };
  return statusMap[status?.toLowerCase()] || 'Lead';
}
