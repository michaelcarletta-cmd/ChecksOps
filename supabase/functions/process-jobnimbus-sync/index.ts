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

        const apiKey = item.profiles?.jobnimbus_api_key;
        if (!apiKey) {
          throw new Error('No JobNimbus API key found for contractor');
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
            result = await syncNote(apiKey, claim, item.payload);
            break;
          case 'file':
            result = await syncFile(apiKey, claim, item.payload, supabase);
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

  // Check if job already exists in JobNimbus
  let jobId = claim.jobnimbus_job_id;

  const jobData = {
    record_type_name: 'Job',
    primary: {
      name: claim.policyholder_name || 'Unknown',
    },
    status_name: mapStatusToJobNimbus(claim.status),
    description: claim.loss_description || '',
    location: {
      address: claim.policyholder_address || '',
    },
    // Custom fields
    cf_claim_number: claim.claim_number || '',
    cf_policy_number: claim.policy_number || '',
    cf_loss_date: claim.loss_date || '',
    cf_loss_type: claim.loss_type || '',
    cf_insurance_company: claim.insurance_company || '',
  };

  let response;
  if (jobId) {
    // Update existing job
    response = await fetch(`${JOBNIMBUS_API_BASE}/jobs/${jobId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(jobData),
    });
  } else {
    // Create new job
    response = await fetch(`${JOBNIMBUS_API_BASE}/jobs`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(jobData),
    });
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`JobNimbus API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  
  // Save JobNimbus job ID back to claim if new
  if (!jobId && result.jnid) {
    await supabase
      .from('claims')
      .update({ jobnimbus_job_id: result.jnid })
      .eq('id', claim.id);
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
      record_type_name: 'Task',
      title: taskData.title || 'Task',
      description: taskData.description || '',
      related: [{ jnid: jobId }],
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

async function syncNote(apiKey: string, claim: any, payload: any) {
  console.log(`Syncing note to JobNimbus for claim ${claim?.id}`);
  
  const noteData = payload?.data;
  if (!noteData) return { skipped: true };

  const jobId = claim?.jobnimbus_job_id;
  if (!jobId) {
    console.log('No JobNimbus job ID, skipping note sync');
    return { skipped: true, reason: 'No JobNimbus job ID' };
  }

  const response = await fetch(`${JOBNIMBUS_API_BASE}/activities`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      record_type_name: 'Activity',
      note: noteData.content || '',
      related: [{ jnid: jobId }],
    }),
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
      record_type_name: 'Document',
      filename: fileData.file_name || 'file',
      url: signedUrl.signedUrl,
      related: [{ jnid: jobId }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`JobNimbus file sync error: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

function mapStatusToJobNimbus(status: string): string {
  // Map your claim statuses to JobNimbus status names
  const statusMap: Record<string, string> = {
    'open': 'New Lead',
    'in_progress': 'In Progress',
    'pending': 'Pending',
    'closed': 'Completed',
  };
  return statusMap[status?.toLowerCase()] || 'New Lead';
}
