import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

const JOBNIMBUS_API_BASE = 'https://app.jobnimbus.com/api1';

// Valid JN user ID pattern (alphanumeric, typically 20+ chars)
const JN_USER_ID_PATTERN = /^[a-z0-9]{10,}$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const cronSecret = Deno.env.get('CRON_SECRET');
  const providedSecret = req.headers.get('x-cron-secret');
  const authHeader = req.headers.get('authorization');
  
  const hasCronSecret = cronSecret && providedSecret === cronSecret;
  const hasAnyCronSecret = Boolean(providedSecret && providedSecret.length > 0);
  const hasAuthHeader = !!authHeader;
  
  if (!hasCronSecret && !hasAnyCronSecret && !hasAuthHeader) {
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

    // Check for test mode
    let body: any = {};
    try { body = await req.json(); } catch { /* no body */ }

    if (body?.test_notification) {
      return await handleNotificationTest(supabase, body);
    }

    console.log('Processing JobNimbus sync queue...');

    const { data: pendingItems, error: fetchError } = await supabase
      .from('jobnimbus_sync_queue')
      .select(`*, claims (*)`)
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
        await supabase
          .from('jobnimbus_sync_queue')
          .update({ status: 'processing' })
          .eq('id', item.id);

        const apiKey = Deno.env.get('JOBNIMBUS_API_KEY');
        if (!apiKey) throw new Error('No JobNimbus API key configured');

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
            result = await syncNote(apiKey, claim, item.payload, supabase, item.id);
            break;
          case 'file':
            result = await syncFile(apiKey, claim, item.payload, supabase);
            break;
          case 'inspection':
            result = await syncInspection(apiKey, claim, item.payload, supabase, item.id);
            break;
          default:
            throw new Error(`Unknown sync type: ${item.sync_type}`);
        }

        await supabase
          .from('jobnimbus_sync_queue')
          .update({ 
            status: 'completed', 
            processed_at: new Date().toISOString(),
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
            processed_at: new Date().toISOString(),
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

// ─── Notification Test Mode ─────────────────────────────────────────

async function handleNotificationTest(_supabase: any, body: any) {
  const apiKey = Deno.env.get('JOBNIMBUS_API_KEY');
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'No JobNimbus API key' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const targetJnUserId = body.target_jn_user_id;
  const jobId = body.job_id; // optional — links task to a job

  if (!targetJnUserId || !JN_USER_ID_PATTERN.test(targetJnUserId)) {
    return new Response(JSON.stringify({ error: 'Invalid or missing target_jn_user_id', pattern: JN_USER_ID_PATTERN.source }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  console.log(`[TEST MODE] Creating minimal test task for JN user: ${targetJnUserId}`);

  // Minimal payload — only fields we believe trigger assignment notification
  const taskBody: Record<string, any> = {
    record_type_name: 'Task',
    title: `🔔 Darwin Notification Test — ${new Date().toISOString()}`,
    description: 'This is an automated test to verify JobNimbus task-assignment notifications are working.',
    date_start: Math.floor(Date.now() / 1000),
    date_end: Math.floor(Date.now() / 1000) + 86400,
    is_active: true,
    owners: [{ id: targetJnUserId }],
  };

  // Optionally link to a job
  if (jobId) {
    taskBody.primary = { id: jobId, type: 'job' };
    taskBody.related = [{ id: jobId, type: 'job' }];
  }

  console.log(`[TEST MODE] POST payload: ${JSON.stringify(taskBody)}`);

  const createResp = await fetch(`${JOBNIMBUS_API_BASE}/tasks`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(taskBody),
  });

  const createText = await createResp.text();
  console.log(`[TEST MODE] Create response [${createResp.status}]: ${createText.substring(0, 500)}`);

  let createResult: any;
  try { createResult = JSON.parse(createText); } catch { createResult = { raw: createText }; }

  if (!createResp.ok) {
    return new Response(JSON.stringify({
      test: 'FAILED',
      phase: 'task_creation',
      status: createResp.status,
      response: createResult,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // Verification GET — read back the created task
  const createdId = createResult.jnid;
  let verification: any = null;

  if (createdId) {
    try {
      const getResp = await fetch(`${JOBNIMBUS_API_BASE}/tasks/${createdId}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      const getText = await getResp.text();
      console.log(`[TEST MODE] Verification GET [${getResp.status}]: ${getText.substring(0, 500)}`);

      let getResult: any;
      try { getResult = JSON.parse(getText); } catch { getResult = { raw: getText }; }

      verification = {
        status: getResp.status,
        owners: getResult.owners,
        sales_rep_ids: getResult.sales_rep_ids,
        assigned_to_ids: getResult.assigned_to_ids,
        record_type_name: getResult.record_type_name,
        title: getResult.title,
        related: getResult.related,
        primary: getResult.primary,
        is_active: getResult.is_active,
        target_user_found_in_owners: Array.isArray(getResult.owners)
          ? getResult.owners.some((o: any) => o.id === targetJnUserId || o === targetJnUserId)
          : false,
        target_user_found_in_sales_rep_ids: Array.isArray(getResult.sales_rep_ids)
          ? getResult.sales_rep_ids.includes(targetJnUserId)
          : false,
        target_user_found_in_assigned_to_ids: Array.isArray(getResult.assigned_to_ids)
          ? getResult.assigned_to_ids.includes(targetJnUserId)
          : false,
      };
    } catch (err: any) {
      verification = { error: err.message };
    }
  }

  return new Response(JSON.stringify({
    test: 'COMPLETED',
    created_task_id: createdId,
    target_jn_user_id: targetJnUserId,
    create_response: createResult,
    verification,
    recommendation: verification?.target_user_found_in_owners
      ? 'owners field is persisted — should trigger Task Assigned notification if user has it enabled'
      : 'WARNING: target user NOT found in owners on read-back — assignment may not have persisted',
  }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// ─── Helpers ────────────────────────────────────────────────────────

// Granular notification statuses
type NotificationStatusGranular =
  | 'synced_note_only'
  | 'task_created_unverified'
  | 'task_created_assignment_verified'
  | 'task_created_assignment_mismatch'
  | 'notification_preferences_unknown'
  | 'notification_failed'
  | 'none';

interface NotificationResult {
  notificationStatus: string;
  details: Record<string, any>;
}

async function updateNotificationStatus(supabase: any, queueId: string, result: NotificationResult) {
  try {
    await supabase
      .from('jobnimbus_sync_queue')
      .update({
        notification_status: result.notificationStatus,
        notification_details: result.details,
      })
      .eq('id', queueId);
  } catch (err) {
    console.error('Failed to update notification status:', err);
  }
}

/** Validate a JN user ID format */
function validateJnUserId(jnUserId: string | null | undefined, displayName: string): { valid: boolean; reason?: string } {
  if (!jnUserId) return { valid: false, reason: `Missing jobnimbus_user_id for ${displayName}` };
  if (typeof jnUserId !== 'string') return { valid: false, reason: `jobnimbus_user_id is not a string for ${displayName}` };
  if (!JN_USER_ID_PATTERN.test(jnUserId)) return { valid: false, reason: `jobnimbus_user_id '${jnUserId}' does not match expected pattern for ${displayName}` };
  return { valid: true };
}

/** Resolve JN user IDs and profile info for all staff/contractors on a claim */
async function resolveClaimJnUsers(supabase: any, claimId: string) {
  const { data: staffRows } = await supabase
    .from('claim_staff')
    .select('staff_id')
    .eq('claim_id', claimId);

  const { data: contractorRows } = await supabase
    .from('claim_contractors')
    .select('contractor_id')
    .eq('claim_id', claimId);

  const allIds = [
    ...(staffRows || []).map((r: any) => r.staff_id),
    ...(contractorRows || []).map((r: any) => r.contractor_id),
  ];

  if (allIds.length === 0) return [];

  const uniqueIds = [...new Set(allIds)];
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, jobnimbus_user_id, full_name, email, jobnimbus_notification_mode')
    .in('id', uniqueIds)
    .not('jobnimbus_user_id', 'is', null);

  return profiles || [];
}

/** Verify a created task by GET-ing it back and checking assignment fields */
async function verifyCreatedTask(
  apiKey: string,
  taskJnId: string,
  targetJnUserId: string,
): Promise<{ verified: boolean; assigneeMatch: boolean; returnedOwners: any; returnedAssignedTo: any; returnedSalesReps: any; recordTypeName: string | null; raw: any }> {
  try {
    const resp = await fetch(`${JOBNIMBUS_API_BASE}/tasks/${taskJnId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const text = await resp.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!resp.ok) {
      console.log(`[VERIFY] GET /tasks/${taskJnId} returned ${resp.status}`);
      return { verified: false, assigneeMatch: false, returnedOwners: null, returnedAssignedTo: null, returnedSalesReps: null, recordTypeName: null, raw: data };
    }

    const ownersMatch = Array.isArray(data.owners) && data.owners.some((o: any) => (o.id || o) === targetJnUserId);
    const assignedMatch = Array.isArray(data.assigned_to_ids) && data.assigned_to_ids.includes(targetJnUserId);
    const salesRepMatch = Array.isArray(data.sales_rep_ids) && data.sales_rep_ids.includes(targetJnUserId);

    console.log(`[VERIFY] Task ${taskJnId} — owners match: ${ownersMatch}, assigned_to match: ${assignedMatch}, sales_rep match: ${salesRepMatch}`);

    return {
      verified: true,
      assigneeMatch: ownersMatch || assignedMatch || salesRepMatch,
      returnedOwners: data.owners,
      returnedAssignedTo: data.assigned_to_ids,
      returnedSalesReps: data.sales_rep_ids,
      recordTypeName: data.record_type_name,
      raw: { title: data.title, is_active: data.is_active, related: data.related },
    };
  } catch (err: any) {
    console.error(`[VERIFY] Exception verifying task ${taskJnId}:`, err);
    return { verified: false, assigneeMatch: false, returnedOwners: null, returnedAssignedTo: null, returnedSalesReps: null, recordTypeName: null, raw: { error: err.message } };
  }
}

/** Create a follow-up task in JN assigned to a specific user to trigger a real notification */
async function createNotificationTask(
  apiKey: string,
  jobId: string,
  claimName: string,
  targetJnUserId: string,
  notePreview: string,
  authorName: string,
): Promise<{ success: boolean; response?: any; error?: string; verification?: any }> {
  const title = `📋 New note from ${authorName || 'System'}`;
  const description = notePreview.length > 300 ? notePreview.substring(0, 300) + '...' : notePreview;
  
  const now = Math.floor(Date.now() / 1000);
  // Use ONLY owners — this is the field we need to verify triggers assignment notification.
  // Do NOT scatter assignment across multiple fields until we confirm which one JN honors.
  const taskBody = {
    record_type_name: 'Task',
    title,
    description,
    date_start: now,
    date_end: now + 86400,
    is_active: true,
    primary: { id: jobId, type: 'job', name: claimName },
    related: [{ id: jobId, type: 'job', name: claimName }],
    owners: [{ id: targetJnUserId }],
  };

  const endpoint = `${JOBNIMBUS_API_BASE}/tasks`;
  console.log(`[TASK CREATE] POST ${endpoint}`);
  console.log(`[TASK CREATE] Payload: ${JSON.stringify(taskBody)}`);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(taskBody),
    });

    const text = await response.text();
    console.log(`[TASK CREATE] Response [${response.status}]: ${text.substring(0, 500)}`);

    if (!response.ok) {
      return { success: false, error: `${response.status}: ${text.substring(0, 200)}` };
    }

    let result: any;
    try { result = JSON.parse(text); } catch { result = { raw: text }; }

    // Verification GET — confirm the task was stored with correct assignment
    let verification = null;
    if (result.jnid) {
      verification = await verifyCreatedTask(apiKey, result.jnid, targetJnUserId);
      console.log(`[TASK CREATE] Verification result: ${JSON.stringify(verification)}`);
    }

    return { success: true, response: result, verification };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── Sync Functions ─────────────────────────────────────────────────

async function syncClaim(apiKey: string, claim: any, supabase: any) {
  console.log(`Syncing claim ${claim.id} to JobNimbus`);

  let jobId = claim.jobnimbus_job_id;
  const policyholderName = (claim.policyholder_name || '').trim();
  const primaryName = policyholderName || claim.claim_number || 'Unknown';
  const nameParts = primaryName.split(/\s+/);
  const firstName = nameParts[0] || primaryName;
  const lastName = nameParts.slice(1).join(' ') || '';

  if (jobId) {
    // Do NOT send status_name on updates — it overwrites the JN user's workflow status
    const jobData: Record<string, any> = {
      name: primaryName,
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

  // Create contact
  const contactData: Record<string, any> = {
    first_name: firstName,
    last_name: lastName,
    display_name: primaryName,
    record_type_name: 'Customer',
  };
  if (claim.policyholder_email) contactData.email = claim.policyholder_email;
  if (claim.policyholder_phone) contactData.home_phone = claim.policyholder_phone;
  if (claim.policyholder_address) contactData.address_line1 = claim.policyholder_address;

  console.log('Creating JN contact:', JSON.stringify(contactData));
  const contactResponse = await fetch(`${JOBNIMBUS_API_BASE}/contacts`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(contactData),
  });

  if (!contactResponse.ok) {
    const errorText = await contactResponse.text();
    throw new Error(`JobNimbus contact creation error: ${contactResponse.status} - ${errorText}`);
  }

  const contact = await contactResponse.json();
  const contactId = contact.jnid;
  console.log(`Created JN contact ${contactId}`);

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
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(jobData),
  });

  if (!jobResponse.ok) {
    const errorText = await jobResponse.text();
    throw new Error(`JobNimbus job creation error: ${jobResponse.status} - ${errorText}`);
  }

  const result = await jobResponse.json();
  if (result.jnid) {
    await supabase.from('claims').update({ jobnimbus_job_id: result.jnid }).eq('id', claim.id);
    console.log(`Saved JN job ID ${result.jnid} to claim ${claim.id}`);
  }
  return result;
}

async function syncTask(apiKey: string, claim: any, payload: any) {
  console.log(`Syncing task to JobNimbus for claim ${claim?.id}`);
  const taskData = payload?.data;
  if (!taskData) return { skipped: true };

  const jobId = claim?.jobnimbus_job_id;
  if (!jobId) return { skipped: true, reason: 'No JobNimbus job ID' };

  const response = await fetch(`${JOBNIMBUS_API_BASE}/tasks`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
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

async function syncNote(apiKey: string, claim: any, payload: any, supabase: any, queueId: string) {
  console.log(`Syncing note to JobNimbus for claim ${claim?.id}`);
  const noteData = payload?.data;
  if (!noteData) return { skipped: true };

  const jobId = claim?.jobnimbus_job_id;
  if (!jobId) return { skipped: true, reason: 'No JobNimbus job ID' };

  // Resolve all JN-mapped users on this claim
  let jnUsers: any[] = [];
  let actorEmail: string | null = null;
  let authorName: string | null = null;

  try {
    jnUsers = await resolveClaimJnUsers(supabase, claim.id);
    
    // Log diagnostic detail for each mapped user
    for (const u of jnUsers) {
      const validation = validateJnUserId(u.jobnimbus_user_id, u.full_name);
      console.log(`[USER MAP] Internal ID: ${u.id} | Name: ${u.full_name} | JN ID: ${u.jobnimbus_user_id} | Mode: ${u.jobnimbus_notification_mode || 'task'} | Valid: ${validation.valid}${validation.reason ? ' | ' + validation.reason : ''}`);
    }

    // Resolve the note author
    if (noteData.user_id) {
      const { data: authorProfile } = await supabase
        .from('profiles')
        .select('email, full_name')
        .eq('id', noteData.user_id)
        .maybeSingle();

      actorEmail = authorProfile?.email || null;
      authorName = authorProfile?.full_name || null;
      console.log(`Note author: ${authorName} (${actorEmail})`);
    }
  } catch (err) {
    console.error('Error resolving JN users:', err);
  }

  // Build @mention prefix (cosmetic only)
  const mentionNames = jnUsers.map((p: any) => p.full_name).filter(Boolean);
  const mentionPrefix = mentionNames.length > 0
    ? mentionNames
        .map((name: string) => `@${name.replace(/\s+/g, '')}`)
        .join(' ') + ' '
    : '';

  const owners = jnUsers.map((p: any) => p.jobnimbus_user_id).filter(Boolean);

  const activityBody: Record<string, any> = {
    record_type_name: 'Note',
    note: mentionPrefix + (noteData.content || ''),
    primary: { id: jobId, type: 'job', name: claim?.policyholder_name || '' },
    related: [{ id: jobId, type: 'job', name: claim?.policyholder_name || '' }],
  };

  if (owners.length > 0) {
    activityBody.owners = owners.map((id: string) => ({ id }));
  }

  const activityUrl = actorEmail
    ? `${JOBNIMBUS_API_BASE}/activities?actor=${encodeURIComponent(actorEmail)}`
    : `${JOBNIMBUS_API_BASE}/activities`;

  console.log(`[NOTE SYNC] POST ${activityUrl}`);
  console.log(`[NOTE SYNC] Payload: ${JSON.stringify(activityBody).substring(0, 800)}`);

  // Step 1: Create the note (base sync — always runs regardless of notification outcome)
  const response = await fetch(activityUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(activityBody),
  });

  const responseText = await response.text();
  console.log(`[NOTE SYNC] Response [${response.status}]: ${responseText.substring(0, 500)}`);

  if (!response.ok) {
    await updateNotificationStatus(supabase, queueId, {
      notificationStatus: 'notification_failed',
      details: { error: `Note creation failed: ${response.status}`, phase: 'note_creation' },
    });
    throw new Error(`JobNimbus note sync error: ${response.status} - ${responseText}`);
  }

  let noteResult: any;
  try { noteResult = JSON.parse(responseText); } catch { noteResult = { raw: responseText }; }

  // Step 2: Create assigned-task notifications for each target user
  const notificationResults: Record<string, any> = {};
  const eligibleUsers = jnUsers.filter(u => {
    if (noteData.user_id && u.id === noteData.user_id) {
      console.log(`[NOTE SYNC] Skipping ${u.full_name} (note author)`);
      notificationResults[u.full_name] = { skipped: true, reason: 'note_author' };
      return false;
    }
    const v = validateJnUserId(u.jobnimbus_user_id, u.full_name);
    if (!v.valid) {
      console.error(`[NOTE SYNC] ❌ ${v.reason}`);
      notificationResults[u.full_name] = { skipped: true, reason: v.reason };
      return false;
    }
    return true;
  });

  let overallStatus: NotificationStatusGranular = 'synced_note_only';

  if (eligibleUsers.length === 0 && jnUsers.length === 0) {
    overallStatus = 'none';
  }

  for (const user of eligibleUsers) {
    const mode = user.jobnimbus_notification_mode || 'task';
    const jnId = user.jobnimbus_user_id;
    const endpoint = `${JOBNIMBUS_API_BASE}/tasks`;

    if (mode === 'mention') {
      // Mention-only: cosmetic, no task created
      notificationResults[user.full_name] = {
        method: 'mention_only',
        jnUserId: jnId,
        note: 'Plain-text @mentions not confirmed to trigger JN notifications in this environment',
      };
      if (overallStatus === 'synced_note_only') overallStatus = 'synced_note_only';
      continue;
    }

    // mode === 'task' or 'both'
    console.log(`[NOTE SYNC] Queue: ${queueId} | Creating task for ${user.full_name} (JN: ${jnId}) | Endpoint: ${endpoint}`);

    try {
      const taskResult = await createNotificationTask(
        apiKey, jobId,
        claim.policyholder_name || claim.claim_number || 'Claim',
        jnId, noteData.content || '', authorName || 'System',
      );

      if (taskResult.success) {
        const v = taskResult.verification;
        const taskId = taskResult.response?.jnid;
        let userStatus: string;

        if (v && v.verified && v.assigneeMatch) {
          userStatus = 'task_created_assignment_verified';
          console.log(`[NOTE SYNC] ✅ Queue: ${queueId} | Task ${taskId} VERIFIED for ${user.full_name}`);
        } else if (v && v.verified && !v.assigneeMatch) {
          userStatus = 'task_created_assignment_mismatch';
          console.warn(`[NOTE SYNC] ⚠️ Queue: ${queueId} | Task ${taskId} created but assignment MISMATCH for ${user.full_name}`);
        } else {
          userStatus = 'task_created_unverified';
          console.log(`[NOTE SYNC] ⚠️ Queue: ${queueId} | Task ${taskId} created, verification unavailable`);
        }

        notificationResults[user.full_name] = {
          method: 'task',
          success: true,
          taskId,
          jnUserId: jnId,
          endpoint,
          responseStatus: 200,
          verificationStatus: userStatus,
          verification: v ? {
            assigneeMatch: v.assigneeMatch,
            returnedOwners: v.returnedOwners,
            returnedAssignedTo: v.returnedAssignedTo,
            returnedSalesReps: v.returnedSalesReps,
            recordTypeName: v.recordTypeName,
          } : null,
        };

        // Promote overall status
        if (userStatus === 'task_created_assignment_verified') {
          overallStatus = 'task_created_assignment_verified';
        } else if (userStatus === 'task_created_assignment_mismatch' && overallStatus !== 'task_created_assignment_verified') {
          overallStatus = 'task_created_assignment_mismatch';
        } else if (overallStatus === 'synced_note_only') {
          overallStatus = 'task_created_unverified';
        }
      } else {
        notificationResults[user.full_name] = {
          method: 'task', success: false, error: taskResult.error,
          jnUserId: jnId, endpoint, responseStatus: taskResult.error?.match(/^(\d+):/)?.[1] || 'error',
        };
        if (overallStatus === 'synced_note_only') overallStatus = 'notification_failed';
      }
    } catch (err: any) {
      console.error(`[NOTE SYNC] ❌ Queue: ${queueId} | Exception for ${user.full_name}:`, err);
      notificationResults[user.full_name] = { method: 'task', success: false, error: err.message, jnUserId: jnId, endpoint };
      if (overallStatus === 'synced_note_only') overallStatus = 'notification_failed';
    }
  }

  console.log(`[NOTE SYNC] Final status: ${overallStatus}`);

  await updateNotificationStatus(supabase, queueId, {
    notificationStatus: overallStatus,
    details: {
      queueItemId: queueId,
      noteCreated: true,
      noteJnId: noteResult?.jnid || null,
      targetUsers: jnUsers.map((u: any) => ({
        internalId: u.id,
        displayName: u.full_name,
        jnUserId: u.jobnimbus_user_id,
        mode: u.jobnimbus_notification_mode || 'task',
      })),
      results: notificationResults,
      authorName,
      actorEmail,
      noteEndpoint: activityUrl,
      noteResponseStatus: response.status,
    },
  });

  return { ...noteResult, notificationStatus: overallStatus, notificationResults };
}

async function syncFile(apiKey: string, claim: any, payload: any, supabase: any) {
  console.log(`Syncing file to JobNimbus for claim ${claim?.id}`);
  const fileData = payload?.data;
  if (!fileData) return { skipped: true };

  const jobId = claim?.jobnimbus_job_id;
  if (!jobId) return { skipped: true, reason: 'No JobNimbus job ID' };

  // Download file binary from storage
  const { data: fileBlob, error: dlErr } = await supabase.storage
    .from('claim-files')
    .download(fileData.file_path);

  if (dlErr || !fileBlob) throw new Error(`Could not download file from storage: ${dlErr?.message || 'no data'}`);

  const fileName = fileData.file_name || 'file';
  const contentType = fileData.file_type || fileBlob.type || 'application/octet-stream';
  const fileBuffer = await fileBlob.arrayBuffer();
  const fileBytes = new Blob([fileBuffer], { type: contentType });

  // JobNimbus /files expects multipart/form-data. Per the JN public API contract used by
  // working integrations, the field name is "file" with filename, "related[0]" supplies the
  // job jnid as a plain string (not JSON), and "filename" must also be sent as a separate field.
  const form = new FormData();
  form.append('file', fileBytes, fileName);
  form.append('filename', fileName);
  form.append('related[0]', jobId);
  if (fileData.description) {
    form.append('description', fileData.description);
  }

  const url = `${JOBNIMBUS_API_BASE}/files`;
  console.log(`[FILE SYNC] POST ${url}`);
  console.log(`[FILE SYNC] Uploading ${fileName} (${contentType}, ${fileBuffer.byteLength} bytes) for job ${jobId}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` }, // let fetch set Content-Type with boundary
    body: form,
  });

  const responseText = await response.text();
  console.log(`[FILE SYNC] Response [${response.status}]: ${responseText.substring(0, 1500)}`);

  if (!response.ok) {
    throw new Error(`JobNimbus file sync error: ${response.status} - ${responseText}`);
  }
  try {
    return JSON.parse(responseText);
  } catch {
    return { raw: responseText };
  }
}

async function syncInspection(apiKey: string, claim: any, payload: any, supabase: any, queueId: string) {
  console.log(`Syncing inspection to JobNimbus calendar for claim ${claim?.id}`);
  const inspData = payload?.data;
  if (!inspData) return { skipped: true };

  const jobId = claim?.jobnimbus_job_id;
  if (!jobId) return { skipped: true, reason: 'No JobNimbus job ID' };

  let dateStart: number;
  const inspDate = inspData.inspection_date;
  const inspTime = inspData.inspection_time;

  const easternToUnix = (dateStr: string, timeStr: string): number => {
    const [year, month, day] = dateStr.split('-').map(Number);
    const [hour, minute, second] = timeStr.split(':').map(Number);

    const marchSecondSunday = new Date(Date.UTC(year, 2, 1));
    marchSecondSunday.setUTCDate(1 + (7 - marchSecondSunday.getUTCDay()) % 7 + 7);
    const novFirstSunday = new Date(Date.UTC(year, 10, 1));
    novFirstSunday.setUTCDate(1 + (7 - novFirstSunday.getUTCDay()) % 7);

    const checkDate = new Date(Date.UTC(year, month - 1, day));
    const isDST = checkDate >= marchSecondSunday && checkDate < novFirstSunday;
    const offsetHours = isDST ? 4 : 5;

    const utcMs = Date.UTC(year, month - 1, day, hour + offsetHours, minute, second || 0);
    console.log(`easternToUnix: ${dateStr} ${timeStr} ET (offset=${offsetHours}h) → UTC ${new Date(utcMs).toISOString()}`);
    return Math.floor(utcMs / 1000);
  };

  if (inspDate && inspTime) {
    dateStart = easternToUnix(inspDate, inspTime);
  } else if (inspDate) {
    dateStart = easternToUnix(inspDate, '09:00:00');
  } else {
    return { skipped: true, reason: 'No inspection date' };
  }

  const dateEnd = dateStart + 3600;

  let jnUsers: any[] = [];
  try {
    jnUsers = await resolveClaimJnUsers(supabase, claim.id);
    console.log(`Inspection JN users: ${JSON.stringify(jnUsers.map((u: any) => ({ name: u.full_name, jnId: u.jobnimbus_user_id })))}`);
  } catch (err) {
    console.error('Error looking up JN owners for inspection:', err);
  }

  const owners = jnUsers.map((p: any) => p.jobnimbus_user_id).filter(Boolean);

  const inspType = inspData.inspection_type || 'Inspection';
  const title = `${inspType} - ${claim.policyholder_name || claim.claim_number || 'Claim'}`;
  const description = [
    inspData.inspector_name ? `Inspector: ${inspData.inspector_name}` : '',
    claim.policyholder_address ? `Address: ${claim.policyholder_address}` : '',
    inspData.notes || '',
  ].filter(Boolean).join('\n');

  const taskBody: Record<string, any> = {
    record_type_name: 'Appointment',
    title,
    description,
    date_start: dateStart,
    date_end: dateEnd,
    is_active: true,
    primary: { id: jobId, type: 'job', name: claim?.policyholder_name || '' },
    related: [{ id: jobId, type: 'job', name: claim?.policyholder_name || '' }],
  };

  if (claim.policyholder_address) {
    taskBody.location = { address: claim.policyholder_address };
  }

  if (owners.length > 0) {
    // Use only owners for assignment — standardized field
    taskBody.owners = owners.map((id: string) => ({ id }));
  }

  console.log(`[INSPECTION SYNC] POST ${JOBNIMBUS_API_BASE}/tasks`);
  console.log(`[INSPECTION SYNC] Payload: ${JSON.stringify(taskBody).substring(0, 800)}`);

  const response = await fetch(`${JOBNIMBUS_API_BASE}/tasks`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(taskBody),
  });

  const responseText = await response.text();
  console.log(`[INSPECTION SYNC] Response [${response.status}]: ${responseText.substring(0, 500)}`);

  if (!response.ok) {
    await updateNotificationStatus(supabase, queueId, {
      notificationStatus: 'notification_failed',
      details: { error: `Inspection creation failed: ${response.status}`, phase: 'inspection_creation' },
    });
    throw new Error(`JobNimbus inspection sync error: ${response.status} - ${responseText}`);
  }

  let inspResult: any;
  try { inspResult = JSON.parse(responseText); } catch { inspResult = { raw: responseText }; }

  // Verify assignment on the created inspection
  let verificationStatus: NotificationStatusGranular = owners.length > 0 ? 'task_created_unverified' : 'none';
  let verification: any = null;

  if (inspResult.jnid && owners.length > 0) {
    verification = await verifyCreatedTask(apiKey, inspResult.jnid, owners[0]);
    if (verification.verified && verification.assigneeMatch) {
      verificationStatus = 'task_created_assignment_verified';
    } else if (verification.verified) {
      verificationStatus = 'task_created_assignment_mismatch';
    }
  }

  await updateNotificationStatus(supabase, queueId, {
    notificationStatus: verificationStatus,
    details: {
      queueItemId: queueId,
      method: 'task_assignment',
      taskCreated: true,
      taskJnId: inspResult.jnid || null,
      targetUsers: jnUsers.map((u: any) => ({ displayName: u.full_name, jnUserId: u.jobnimbus_user_id })),
      ownerIds: owners,
      endpoint: `${JOBNIMBUS_API_BASE}/tasks`,
      responseStatus: response.status,
      verification: verification ? {
        assigneeMatch: verification.assigneeMatch,
        returnedOwners: verification.returnedOwners,
        returnedAssignedTo: verification.returnedAssignedTo,
        recordTypeName: verification.recordTypeName,
      } : null,
    },
  });

  return inspResult;
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
