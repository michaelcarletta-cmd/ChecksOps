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

// ─── Helpers ────────────────────────────────────────────────────────

interface NotificationResult {
  notificationStatus: 'sent' | 'fallback_used' | 'failed' | 'none';
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

/** Create a follow-up task in JN assigned to a specific user to trigger a real notification */
async function createNotificationTask(
  apiKey: string,
  jobId: string,
  claimName: string,
  targetJnUserId: string,
  notePreview: string,
  authorName: string,
): Promise<{ success: boolean; response?: any; error?: string }> {
  const title = `📋 New note from ${authorName || 'System'}`;
  const description = notePreview.length > 300 ? notePreview.substring(0, 300) + '...' : notePreview;
  
  // Create a task due today, assigned to the target user
  const now = Math.floor(Date.now() / 1000);
  const taskBody = {
    record_type_name: 'To Do',
    title,
    description,
    date_start: now,
    date_end: now + 86400, // due in 24h
    is_active: true,
    primary: { id: jobId, type: 'job', name: claimName },
    related: [{ id: jobId, type: 'job', name: claimName }],
    owners: [{ id: targetJnUserId }],
  };

  console.log(`Creating JN notification task for user ${targetJnUserId}:`, JSON.stringify(taskBody).substring(0, 500));

  try {
    const response = await fetch(`${JOBNIMBUS_API_BASE}/tasks`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(taskBody),
    });

    const text = await response.text();
    console.log(`JN notification task response [${response.status}]: ${text.substring(0, 300)}`);

    if (!response.ok) {
      return { success: false, error: `${response.status}: ${text.substring(0, 200)}` };
    }

    try {
      return { success: true, response: JSON.parse(text) };
    } catch {
      return { success: true, response: { raw: text } };
    }
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
    console.log(`Resolved ${jnUsers.length} JN users for claim ${claim.id}: ${JSON.stringify(jnUsers.map((u: any) => ({ name: u.full_name, jnId: u.jobnimbus_user_id, mode: u.jobnimbus_notification_mode })))}`);

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

  // Build @mention prefix (cosmetic only — treated as supplemental unless proven
  // to trigger native JN notifications in future testing)
  const mentionNames = jnUsers.map((p: any) => p.full_name).filter(Boolean);
  const mentionPrefix = mentionNames.length > 0
    ? mentionNames
        .map((name: string) => `@${name.replace(/\s+/g, '').split(' ').map((part: string) => part.charAt(0).toUpperCase() + part.slice(1)).join('')}`)
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

  console.log(`[NOTE SYNC] Outgoing payload: ${JSON.stringify({ url: activityUrl, body: activityBody }).substring(0, 800)}`);
  console.log(`[NOTE SYNC] Target JN users: ${JSON.stringify(owners)}`);
  console.log(`[NOTE SYNC] Mention prefix used: "${mentionPrefix}"`);

  // Step 1: Create the note (this is the base sync — always runs)
  const response = await fetch(activityUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(activityBody),
  });

  const responseText = await response.text();
  console.log(`[NOTE SYNC] JN API response [${response.status}]: ${responseText.substring(0, 500)}`);

  if (!response.ok) {
    await updateNotificationStatus(supabase, queueId, {
      notificationStatus: 'failed',
      details: { error: `Note creation failed: ${response.status}`, phase: 'note_creation' },
    });
    throw new Error(`JobNimbus note sync error: ${response.status} - ${responseText}`);
  }

  let noteResult;
  try { noteResult = JSON.parse(responseText); } catch { noteResult = { raw: responseText }; }

  // Step 2: Create assigned-task notifications for each target user.
  // Current testing indicates plain-text @mentions in API-created notes are not
  // reliably triggering notifications in our environment, so we use assigned-task
  // fallback for deterministic notification delivery. The "task" mode is the default;
  // "mention" mode is available only as optional supplemental/cosmetic behavior.
  const notificationResults: Record<string, any> = {};
  let anyNotificationSent = false;
  let anyFallbackUsed = false;

  for (const user of jnUsers) {
    const mode = user.jobnimbus_notification_mode || 'task';
    const jnId = user.jobnimbus_user_id;
    
    // Skip if user is the note author (don't notify yourself)
    if (noteData.user_id && user.id === noteData.user_id) {
      console.log(`[NOTE SYNC] Skipping notification for ${user.full_name} (note author)`);
      notificationResults[user.full_name] = { skipped: true, reason: 'note_author' };
      continue;
    }

    if (mode === 'mention' || mode === 'both') {
      console.log(`[NOTE SYNC] @mention included for ${user.full_name} (cosmetic/supplemental — not confirmed to trigger JN notification)`);
      console.log(`[NOTE SYNC] [VERIFICATION] Method: mention_in_note | Target JN User ID: ${jnId} | Display Name: ${user.full_name}`);
    }

    if (mode === 'task' || mode === 'both') {
      const endpoint = `${JOBNIMBUS_API_BASE}/tasks`;
      console.log(`[NOTE SYNC] Queue: ${queueId} | Creating assigned-task notification for ${user.full_name} (JN ID: ${jnId}) | Endpoint: ${endpoint}`);
      try {
        const taskResult = await createNotificationTask(
          apiKey,
          jobId,
          claim.policyholder_name || claim.claim_number || 'Claim',
          jnId,
          noteData.content || '',
          authorName || 'System',
        );

        if (taskResult.success) {
          anyNotificationSent = true;
          notificationResults[user.full_name] = { method: 'task', success: true, taskId: taskResult.response?.jnid, jnUserId: jnId, endpoint, responseStatus: 200 };
          console.log(`[NOTE SYNC] ✅ Queue: ${queueId} | Task created for ${user.full_name} | Task JN ID: ${taskResult.response?.jnid}`);
        } else {
          anyFallbackUsed = true;
          const status = taskResult.error?.match(/^(\d+):/)?.[1] || 'unknown';
          notificationResults[user.full_name] = { method: 'task', success: false, error: taskResult.error, jnUserId: jnId, endpoint, responseStatus: status };
          console.error(`[NOTE SYNC] ❌ Queue: ${queueId} | Task failed for ${user.full_name}: ${taskResult.error}`);
        }
      } catch (err: any) {
        console.error(`[NOTE SYNC] ❌ Queue: ${queueId} | Exception for ${user.full_name}:`, err);
        notificationResults[user.full_name] = { method: 'task', success: false, error: err.message, jnUserId: jnId, endpoint, responseStatus: 'exception' };
      }
    }

    if (mode === 'mention') {
      // Mention-only mode — no assigned task; notification is cosmetic/supplemental
      notificationResults[user.full_name] = { method: 'mention_only', note: 'Plain-text @mentions not confirmed to trigger JN notifications in this environment' };
    }
  }

  // Determine overall notification status
  let notificationStatus: string;
  if (jnUsers.length === 0) {
    notificationStatus = 'none';
  } else if (anyNotificationSent && !anyFallbackUsed) {
    notificationStatus = 'sent';
  } else if (anyNotificationSent) {
    notificationStatus = 'fallback_used';
  } else {
    notificationStatus = 'failed';
  }

  console.log(`[NOTE SYNC] Final notification status: ${notificationStatus}`);

  await updateNotificationStatus(supabase, queueId, {
    notificationStatus: notificationStatus as any,
    details: {
      targetUsers: jnUsers.map((u: any) => u.full_name),
      results: notificationResults,
      authorName,
      actorEmail,
    },
  });

  return { ...noteResult, notificationStatus, notificationResults };
}

async function syncFile(apiKey: string, claim: any, payload: any, supabase: any) {
  console.log(`Syncing file to JobNimbus for claim ${claim?.id}`);
  const fileData = payload?.data;
  if (!fileData) return { skipped: true };

  const jobId = claim?.jobnimbus_job_id;
  if (!jobId) return { skipped: true, reason: 'No JobNimbus job ID' };

  const { data: signedUrl } = await supabase.storage
    .from('claim-files')
    .createSignedUrl(fileData.file_path, 3600);

  if (!signedUrl?.signedUrl) throw new Error('Could not get signed URL for file');

  const response = await fetch(`${JOBNIMBUS_API_BASE}/documents`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
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

async function syncInspection(apiKey: string, claim: any, payload: any, supabase: any, queueId: string) {
  console.log(`Syncing inspection to JobNimbus calendar for claim ${claim?.id}`);
  const inspData = payload?.data;
  if (!inspData) return { skipped: true };

  const jobId = claim?.jobnimbus_job_id;
  if (!jobId) return { skipped: true, reason: 'No JobNimbus job ID' };

  // Build date_start and date_end as unix timestamps
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

  // Resolve JN users for ownership and notification
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
    taskBody.owners = owners.map((id: string) => ({ id }));
    taskBody.sales_rep_ids = owners;
    taskBody.assigned_to_ids = owners;
  }

  console.log(`[INSPECTION SYNC] Outgoing payload: ${JSON.stringify(taskBody).substring(0, 800)}`);
  console.log(`[INSPECTION SYNC] Target JN users: ${JSON.stringify(owners)}`);

  const response = await fetch(`${JOBNIMBUS_API_BASE}/tasks`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(taskBody),
  });

  const responseText = await response.text();
  console.log(`[INSPECTION SYNC] JN response [${response.status}]: ${responseText.substring(0, 500)}`);

  if (!response.ok) {
    await updateNotificationStatus(supabase, queueId, {
      notificationStatus: 'failed',
      details: { error: `Inspection creation failed: ${response.status}`, phase: 'inspection_creation' },
    });
    throw new Error(`JobNimbus inspection sync error: ${response.status} - ${responseText}`);
  }

  // Inspection tasks with owners should auto-notify via JN's task assignment
  await updateNotificationStatus(supabase, queueId, {
    notificationStatus: owners.length > 0 ? 'sent' : 'none',
    details: {
      method: 'task_assignment',
      targetUsers: jnUsers.map((u: any) => u.full_name),
      ownerIds: owners,
    },
  });

  try {
    return JSON.parse(responseText);
  } catch {
    return { raw: responseText };
  }
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
