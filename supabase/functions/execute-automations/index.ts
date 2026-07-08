import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Validate CRON_SECRET for security, while allowing service-role internal calls.
  const cronSecret = Deno.env.get('CRON_SECRET');
  const providedSecret = req.headers.get('x-cron-secret');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization');
  const isServiceRoleCall = Boolean(serviceRoleKey && authHeader === `Bearer ${serviceRoleKey}`);
  const hasValidCronSecret = Boolean(cronSecret && providedSecret === cronSecret);
  
  if (cronSecret && !hasValidCronSecret && !isServiceRoleCall) {
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

    // Get pending executions
    const { data: executions, error: fetchError } = await supabase
      .from('automation_executions')
      .select(`
        *,
        automation:automations(*)
      `)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(50);

    if (fetchError) throw fetchError;

    console.log(`Processing ${executions?.length || 0} pending automations`);

    const results = [];
    for (const execution of executions || []) {
      try {
        // Update status to running
        await supabase
          .from('automation_executions')
          .update({ status: 'running' })
          .eq('id', execution.id);

        const automation = execution.automation;
        const actions = automation.actions as any[];
        const actionResults = [];

        // Execute each action
        for (const action of actions) {
          try {
            const result = await executeAction(supabase, action, execution);
            actionResults.push({ action: action.type, success: true, result });
          } catch (actionError: any) {
            console.error('Action error:', actionError);
            actionResults.push({ 
              action: action.type, 
              success: false, 
              error: actionError.message 
            });
          }
        }

        // Determine overall status: if ALL actions failed, mark as failed
        const allFailed = actionResults.length > 0 && actionResults.every((r: any) => !r.success);
        const finalStatus = allFailed ? 'failed' : 'success';
        const errorMsg = allFailed 
          ? actionResults.map((r: any) => r.error).filter(Boolean).join('; ') 
          : null;

        // Update execution status
        await supabase
          .from('automation_executions')
          .update({
            status: finalStatus,
            result: { actions: actionResults },
            error_message: errorMsg,
            completed_at: new Date().toISOString()
          })
          .eq('id', execution.id);

        results.push({ id: execution.id, status: 'success' });
      } catch (error: any) {
        console.error('Execution error:', error);
        
        // Update execution as failed
        await supabase
          .from('automation_executions')
          .update({
            status: 'failed',
            error_message: error.message,
            completed_at: new Date().toISOString()
          })
          .eq('id', execution.id);

        results.push({ id: execution.id, status: 'failed', error: error.message });
      }
    }

    return new Response(
      JSON.stringify({ processed: results.length, results }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('Function error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

async function executeAction(supabase: any, action: any, execution: any) {
  const { type, config, ...topLevelProps } = action;
  // Actions may store their properties either nested under `config` or at the top level.
  // Merge both so downstream handlers always find the values they need.
  const mergedConfig = { ...topLevelProps, ...(config || {}) };

  switch (type) {
    case 'create_task':
      return await createTask(supabase, mergedConfig, execution);
    
    case 'send_notification':
      return await sendNotification(supabase, mergedConfig, execution);
    
    case 'update_claim':
      return await updateClaim(supabase, mergedConfig, execution);
    
    case 'update_claim_status':
      return await updateClaimStatus(supabase, mergedConfig, execution);
    
    case 'send_email':
      return await sendEmail(supabase, mergedConfig, execution);
    
    case 'send_sms':
      return await sendSms(supabase, mergedConfig, execution);
    
    case 'webhook':
    case 'call_webhook':
      return await callWebhook(supabase, mergedConfig, execution);
    
    default:
      throw new Error(`Unknown action type: ${type}`);
  }
}

async function createTask(supabase: any, config: any, execution: any) {
  const { data: claim } = await supabase
    .from('claims')
    .select('*')
    .eq('id', execution.claim_id)
    .single();

  let dueDate = null;
  if (config.due_date_offset) {
    const offset = config.due_date_offset;
    const isBusinessDays = config.due_date_type === 'business';
    
    if (isBusinessDays) {
      // Calculate business days (Mon-Fri)
      let date = new Date();
      let daysAdded = 0;
      while (daysAdded < offset) {
        date.setDate(date.getDate() + 1);
        const dayOfWeek = date.getDay();
        if (dayOfWeek !== 0 && dayOfWeek !== 6) { // Skip Sunday (0) and Saturday (6)
          daysAdded++;
        }
      }
      dueDate = date.toISOString().split('T')[0];
    } else {
      // Calendar days
      dueDate = new Date(Date.now() + offset * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    }
  }

  // Determine assignment
  let assignedTo: string | null = null;
  
  if (config.assign_to_type === 'user' && config.assign_to_user_id) {
    assignedTo = config.assign_to_user_id;
  } else if (config.assign_to_type === 'claim_staff') {
    // Get the staff assigned to this claim
    const { data: claimStaff } = await supabase
      .from('claim_staff')
      .select('staff_id')
      .eq('claim_id', execution.claim_id)
      .limit(1)
      .single();
    
    if (claimStaff?.staff_id) {
      assignedTo = claimStaff.staff_id;
      console.log('Assigning task to claim staff:', assignedTo);
    } else {
      console.log('No staff found for claim, task will be unassigned');
    }
  } else if (config.assign_to_type === 'claim_contractor') {
    // Get the contractor assigned to this claim
    const { data: claimContractor } = await supabase
      .from('claim_contractors')
      .select('contractor_id')
      .eq('claim_id', execution.claim_id)
      .limit(1)
      .single();
    
    if (claimContractor?.contractor_id) {
      assignedTo = claimContractor.contractor_id;
      console.log('Assigning task to claim contractor:', assignedTo);
    } else {
      console.log('No contractor found for claim, task will be unassigned');
    }
  }

  const taskData: any = {
    claim_id: execution.claim_id,
    title: replaceVariables(config.title || 'Automated Task', claim, execution.trigger_data),
    description: config.description ? replaceVariables(config.description, claim, execution.trigger_data) : null,
    priority: config.priority || 'medium',
    status: 'pending',
    due_date: dueDate,
  };

  if (assignedTo) {
    taskData.assigned_to = assignedTo;
  }

  const { data, error } = await supabase
    .from('tasks')
    .insert(taskData)
    .select()
    .single();

  if (error) throw error;
  console.log('Created task:', data.id, assignedTo ? `assigned to ${assignedTo}` : 'unassigned');
  return data;
}

async function sendNotification(supabase: any, config: any, execution: any) {
  const { data: claim } = await supabase
    .from('claims')
    .select('*')
    .eq('id', execution.claim_id)
    .single();

  const message = replaceVariables(config.message || 'Automated notification', claim, execution.trigger_data);
  
  const { data, error } = await supabase
    .from('claim_updates')
    .insert({
      claim_id: execution.claim_id,
      content: message,
      update_type: 'automation'
    })
    .select()
    .single();

  if (error) throw error;
  console.log('Created notification:', data.id);
  return data;
}

async function sendEmail(supabase: any, config: any, execution: any) {
  // Get claim with all related data
  const { data: claim } = await supabase
    .from('claims')
    .select(`
      *,
      referrer:referrers(name, email)
    `)
    .eq('id', execution.claim_id)
    .single();

  if (!claim) throw new Error('Claim not found');

  // Determine recipient based on config
  let recipientEmail = '';
  let recipientName = '';

  switch (config.recipient_type) {
    case 'policyholder':
      recipientEmail = claim.policyholder_email;
      recipientName = claim.policyholder_name;
      break;
    case 'adjuster':
      recipientEmail = claim.adjuster_email;
      recipientName = claim.adjuster_name;
      break;
    case 'referrer':
      recipientEmail = claim.referrer?.email;
      recipientName = claim.referrer?.name;
      break;
  }

  if (!recipientEmail) {
    throw new Error(`No email found for ${config.recipient_type}`);
  }

  const subject = replaceVariables(config.subject || 'Claim Update', claim, execution.trigger_data);
  const body = replaceVariables(config.message || '', claim, execution.trigger_data);

  // Use Resend to send email
  const resendApiKey = Deno.env.get('RESEND_API_KEY');
  if (!resendApiKey) {
    throw new Error('RESEND_API_KEY not configured');
  }

  // Build attachments if folders are specified
  const attachments: { filename: string; content: string }[] = [];
  
  if (config.attachment_folders && config.attachment_folders.length > 0) {
    console.log('Fetching files from folders:', config.attachment_folders);
    console.log('File name patterns:', config.file_name_patterns || 'all files');
    
    // Get folder IDs for specified folder names
    const { data: folders } = await supabase
      .from('claim_folders')
      .select('id, name')
      .eq('claim_id', execution.claim_id)
      .in('name', config.attachment_folders);
    
    if (folders && folders.length > 0) {
      const folderIds = folders.map((f: any) => f.id);
      
      // Get files from those folders
      const { data: files } = await supabase
        .from('claim_files')
        .select('file_name, file_path')
        .eq('claim_id', execution.claim_id)
        .in('folder_id', folderIds);
      
      if (files && files.length > 0) {
        // Filter files by name patterns if specified
        const patterns = config.file_name_patterns || [];
        const filteredFiles = patterns.length > 0
          ? files.filter((file: any) => 
              patterns.some((pattern: string) => 
                file.file_name.toLowerCase().includes(pattern.toLowerCase())
              )
            )
          : files;
        
        console.log(`Found ${filteredFiles.length} files matching patterns (from ${files.length} total)`);
        
        // Download each file and convert to base64
        for (const file of filteredFiles) {
          try {
            const { data: fileData, error: downloadError } = await supabase
              .storage
              .from('claim-files')
              .download(file.file_path);
            
            if (downloadError) {
              console.error(`Error downloading file ${file.file_name}:`, downloadError);
              continue;
            }
            
            // Convert to base64
            const arrayBuffer = await fileData.arrayBuffer();
            const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
            
            attachments.push({
              filename: file.file_name,
              content: base64,
            });
            
            console.log(`Attached file: ${file.file_name}`);
          } catch (fileError) {
            console.error(`Error processing file ${file.file_name}:`, fileError);
          }
        }
      }
    }
  }

  const emailPayload: any = {
    from: 'Freedom Claims <claims@freedomclaims.work>',
    to: [recipientEmail],
    subject: subject,
    html: `<div style="font-family: sans-serif;">${body.replace(/\n/g, '<br>')}</div>`,
  };

  // Add attachments if any
  if (attachments.length > 0) {
    emailPayload.attachments = attachments;
  }

  const lovableApiKey = Deno.env.get('LOVABLE_API_KEY');
  if (!lovableApiKey) throw new Error('LOVABLE_API_KEY not configured');
  const response = await fetch('https://connector-gateway.lovable.dev/resend/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${lovableApiKey}`,
      'X-Connection-Api-Key': resendApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(emailPayload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to send email: ${errorText}`);
  }

  // Log email to database
  await supabase.from('emails').insert({
    claim_id: execution.claim_id,
    recipient_email: recipientEmail,
    recipient_name: recipientName,
    recipient_type: config.recipient_type,
    subject: subject,
    body: body,
  });

  console.log('Sent email to:', recipientEmail, 'with', attachments.length, 'attachments');
  return { sent_to: recipientEmail, attachments_count: attachments.length };
}

async function sendSms(supabase: any, config: any, execution: any) {
  // Get claim data with inspection
  const { data: claim } = await supabase
    .from('claims')
    .select('*')
    .eq('id', execution.claim_id)
    .single();

  if (!claim) throw new Error('Claim not found');

  // Get latest inspection for merge fields
  const { data: inspection } = await supabase
    .from('inspections')
    .select('inspection_date, inspection_time, inspector_name, inspection_type')
    .eq('claim_id', execution.claim_id)
    .order('inspection_date', { ascending: false })
    .limit(1)
    .single();

  // Get message from template or config
  let messageTemplate = config.message || config.message_template || '';
  if (config.sms_template_id) {
    const { data: template } = await supabase
      .from('sms_templates')
      .select('body')
      .eq('id', config.sms_template_id)
      .single();
    if (template) {
      messageTemplate = template.body;
    }
  }

  const messageBody = replaceVariables(messageTemplate, claim, execution.trigger_data, inspection);

  // Use Telnyx to send SMS
  const telnyxApiKey = Deno.env.get('TELNYX_API_KEY');
  const telnyxPhoneNumber = Deno.env.get('TELNYX_PHONE_NUMBER');

  if (!telnyxApiKey || !telnyxPhoneNumber) {
    throw new Error('Telnyx credentials not configured');
  }

  const telnyxMessagingProfileId = Deno.env.get('TELNYX_MESSAGING_PROFILE_ID');

  // Helper function to send SMS to a single phone number
  const sendToPhone = async (phone: string) => {
    // Normalize phone number to E.164 format
    let normalizedPhone = phone.replace(/\D/g, '');
    if (normalizedPhone.length === 10) {
      normalizedPhone = '+1' + normalizedPhone;
    } else if (normalizedPhone.length === 11 && normalizedPhone.startsWith('1')) {
      normalizedPhone = '+' + normalizedPhone;
    } else if (!normalizedPhone.startsWith('+')) {
      normalizedPhone = '+' + normalizedPhone;
    }

    const smsPayload: Record<string, string> = {
      from: telnyxPhoneNumber,
      to: normalizedPhone,
      text: messageBody,
    };
    if (telnyxMessagingProfileId) {
      smsPayload.messaging_profile_id = telnyxMessagingProfileId;
    }

    const response = await fetch('https://api.telnyx.com/v2/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${telnyxApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(smsPayload),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Telnyx error:', errorData);
      throw new Error(`Failed to send SMS: ${JSON.stringify(errorData)}`);
    }

    const telnyxResponse = await response.json();

    // Log SMS to database
    await supabase.from('sms_messages').insert({
      claim_id: execution.claim_id,
      to_number: normalizedPhone,
      from_number: telnyxPhoneNumber,
      message_body: messageBody,
      direction: 'outbound',
      status: 'sent',
      telnyx_message_id: telnyxResponse.data?.id,
    });

    console.log('Sent SMS to:', normalizedPhone);
    return { sent_to: normalizedPhone, message_id: telnyxResponse.data?.id };
  };

  // Handle contractors - send to all assigned contractors
  if (config.recipient_type === 'contractors') {
    const { data: contractors } = await supabase
      .from('claim_contractors')
      .select('contractor_id')
      .eq('claim_id', execution.claim_id);

    if (!contractors || contractors.length === 0) {
      throw new Error('No contractors assigned to this claim');
    }

    // Get contractor details from clients table
    const contractorIds = contractors.map((c: any) => c.contractor_id);
    const { data: contractorDetails } = await supabase
      .from('clients')
      .select('id, name, phone')
      .in('id', contractorIds);

    if (!contractorDetails || contractorDetails.length === 0) {
      throw new Error('No contractor details found');
    }

    const results = [];
    for (const contractor of contractorDetails) {
      if (contractor.phone) {
        try {
          const result = await sendToPhone(contractor.phone);
          results.push(result);
        } catch (err) {
          console.error(`Failed to send SMS to contractor ${contractor.name}:`, err);
        }
      }
    }

    if (results.length === 0) {
      throw new Error('No contractors with phone numbers found');
    }

    return { sent_count: results.length, results };
  }

  // Handle assigned internal staff on a claim.
  if (config.recipient_type === 'claim_staff') {
    const { data: assignedStaff, error: assignedStaffError } = await supabase
      .from('claim_staff')
      .select('staff_id')
      .eq('claim_id', execution.claim_id);

    if (assignedStaffError) {
      throw assignedStaffError;
    }

    if (!assignedStaff || assignedStaff.length === 0) {
      console.log(`No claim staff assigned for claim ${execution.claim_id}, skipping SMS action`);
      return { sent_count: 0, skipped: true, reason: 'no_claim_staff_assigned' };
    }

    const staffIds = Array.from(new Set(
      assignedStaff
        .map((staff: any) => staff.staff_id)
        .filter((staffId: string | null) => !!staffId)
    ));

    const { data: staffProfiles, error: staffProfilesError } = await supabase
      .from('profiles')
      .select('id, full_name, phone')
      .in('id', staffIds);

    if (staffProfilesError) {
      throw staffProfilesError;
    }

    const recipients = (staffProfiles || []).filter((staff: any) => !!staff.phone);
    if (recipients.length === 0) {
      console.log(`Assigned claim staff have no phone numbers for claim ${execution.claim_id}, skipping SMS action`);
      return { sent_count: 0, skipped: true, reason: 'assigned_staff_missing_phone' };
    }

    const results = [];
    const errors = [];
    for (const staff of recipients) {
      try {
        const result = await sendToPhone(staff.phone);
        results.push({
          ...result,
          staff_id: staff.id,
          staff_name: staff.full_name,
        });
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        console.error(`Failed to send SMS to assigned staff ${staff.id} (${staff.phone}):`, errMsg);
        errors.push({ staff_id: staff.id, staff_name: staff.full_name, phone: staff.phone, error: errMsg });
      }
    }

    if (results.length === 0) {
      const errorDetail = errors.map(e => `${e.staff_name} (${e.phone}): ${e.error}`).join('; ');
      throw new Error(`Failed to send SMS to assigned claim staff: ${errorDetail}`);
    }

    return { sent_count: results.length, results };
  }

  // Handle admin users — send to all users with admin role
  if (config.recipient_type === 'admins') {
    const { data: adminRoles, error: adminRolesError } = await supabase
      .from('user_roles')
      .select('user_id')
      .eq('role', 'admin');

    if (adminRolesError) throw adminRolesError;

    if (!adminRoles || adminRoles.length === 0) {
      console.log(`No admin users found, skipping SMS action`);
      return { sent_count: 0, skipped: true, reason: 'no_admins_found' };
    }

    const adminIds = adminRoles.map((r: any) => r.user_id);
    const { data: adminProfiles, error: adminProfilesError } = await supabase
      .from('profiles')
      .select('id, full_name, phone')
      .in('id', adminIds);

    if (adminProfilesError) throw adminProfilesError;

    const recipients = (adminProfiles || []).filter((a: any) => !!a.phone);
    if (recipients.length === 0) {
      console.log(`Admin users have no phone numbers, skipping SMS action`);
      return { sent_count: 0, skipped: true, reason: 'admins_missing_phone' };
    }

    const results = [];
    const errors = [];
    for (const admin of recipients) {
      try {
        const result = await sendToPhone(admin.phone);
        results.push({ ...result, admin_id: admin.id, admin_name: admin.full_name });
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        console.error(`Failed to send SMS to admin ${admin.id} (${admin.phone}):`, errMsg);
        errors.push({ admin_id: admin.id, admin_name: admin.full_name, phone: admin.phone, error: errMsg });
      }
    }

    if (results.length === 0) {
      const errorDetail = errors.map(e => `${e.admin_name} (${e.phone}): ${e.error}`).join('; ');
      throw new Error(`Failed to send SMS to admins: ${errorDetail}`);
    }

    return { sent_count: results.length, results };
  }

  // Determine recipient phone for non-contractor types
  let recipientPhone = '';

  switch (config.recipient_type) {
    case 'policyholder':
      recipientPhone = claim.policyholder_phone;
      break;
    case 'adjuster':
      recipientPhone = claim.adjuster_phone;
      break;
  }

  if (!recipientPhone) {
    throw new Error(`No phone found for ${config.recipient_type}`);
  }

  return await sendToPhone(recipientPhone);
}

async function updateClaim(supabase: any, config: any, execution: any) {
  const updates: any = {};
  
  for (const [field, value] of Object.entries(config.updates || {})) {
    updates[field] = value;
  }

  const { data, error } = await supabase
    .from('claims')
    .update(updates)
    .eq('id', execution.claim_id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function updateClaimStatus(supabase: any, config: any, execution: any) {
  if (!config.new_status) {
    throw new Error('No status specified for update_claim_status action');
  }

  const { data, error } = await supabase
    .from('claims')
    .update({ status: config.new_status })
    .eq('id', execution.claim_id)
    .select()
    .single();

  if (error) throw error;
  console.log('Updated claim status to:', config.new_status);
  return { new_status: config.new_status, claim_id: execution.claim_id };
}

async function callWebhook(supabase: any, config: any, execution: any) {
  // Fetch full claim data for the webhook
  const { data: claim } = await supabase
    .from('claims')
    .select('*, insurance_companies(name, email, phone)')
    .eq('id', execution.claim_id)
    .single();

  // Build comprehensive payload for Zapier / external integrations
  const payload: any = {
    execution_id: execution.id,
    automation_id: execution.automation_id,
    trigger_data: execution.trigger_data,
    claim: claim ? {
      id: claim.id,
      claim_number: claim.claim_number,
      policy_number: claim.policy_number,
      status: claim.status,
      loss_type: claim.loss_type,
      loss_date: claim.loss_date,
      loss_description: claim.loss_description,
      policyholder_name: claim.policyholder_name,
      policyholder_email: claim.policyholder_email,
      policyholder_phone: claim.policyholder_phone,
      policyholder_address: claim.policyholder_address,
      insurance_company: claim.insurance_company || claim.insurance_companies?.name,
      insurance_email: claim.insurance_email || claim.insurance_companies?.email,
      insurance_phone: claim.insurance_phone || claim.insurance_companies?.phone,
      adjuster_name: claim.adjuster_name,
      adjuster_email: claim.adjuster_email,
      adjuster_phone: claim.adjuster_phone,
      claim_amount: claim.claim_amount,
      created_at: claim.created_at,
      updated_at: claim.updated_at
    } : null,
    timestamp: new Date().toISOString()
  };

  // Optionally include file URLs
  if (config.webhook_include_files && claim) {
    const { data: files } = await supabase
      .from('claim_files')
      .select('id, file_name, file_path, file_type, uploaded_at')
      .eq('claim_id', claim.id)
      .order('uploaded_at', { ascending: false })
      .limit(20);

    if (files && files.length > 0) {
      // Generate signed URLs for files
      const filesWithUrls = await Promise.all(
        files.map(async (file: any) => {
          const { data: urlData } = await supabase.storage
            .from('claim-files')
            .createSignedUrl(file.file_path, 3600); // 1 hour validity
          return {
            ...file,
            signed_url: urlData?.signedUrl || null
          };
        })
      );
      payload.files = filesWithUrls;
    }
  }

  const webhookUrl = config.webhook_url || config.url;
  if (!webhookUrl) {
    throw new Error('Webhook URL not configured');
  }

  console.log('Calling webhook:', webhookUrl);
  console.log('Payload:', JSON.stringify(payload, null, 2));

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  // Zapier may return empty response, that's OK
  if (!response.ok && response.status !== 0) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Webhook failed: ${response.status} ${response.statusText} - ${errorText}`);
  }

  console.log('Webhook called successfully');
  return { status: response.status || 200, webhookUrl, claimId: execution.claim_id };
}

// Helper to format time from 24h to 12h format
function formatTimeTo12Hour(time24: string): string {
  if (!time24) return '';
  const [hours, minutes] = time24.split(':');
  const hour = parseInt(hours, 10);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 || 12;
  return `${hour12}:${minutes} ${ampm}`;
}

function replaceVariables(template: string, claim: any, triggerData: any, inspection?: any): string {
  let result = template;
  
  // Build a flat lookup map for all merge fields
  const mergeMap: Record<string, string> = {};
  
  if (claim) {
    // Policyholder shortcuts
    mergeMap['policyholder'] = claim.policyholder_name || '';
    mergeMap['policyholder_email'] = claim.policyholder_email || '';
    mergeMap['policyholder_phone'] = claim.policyholder_phone || '';
    mergeMap['property_address'] = claim.policyholder_address || '';
    mergeMap['policy'] = claim.policy_number || '';
    mergeMap['insurance_company'] = claim.insurance_company || '';
    mergeMap['mortgage_company'] = claim.mortgage_company || '';
    mergeMap['loan_number'] = claim.loan_number || '';
    mergeMap['ssn_last_four'] = claim.ssn_last_four || '';
    // Nested claim fields
    mergeMap['claim.claim_number'] = claim.claim_number || '';
    mergeMap['claim.loss_type'] = claim.loss_type || '';
    mergeMap['claim.loss_date'] = claim.loss_date || '';
    mergeMap['claim.status'] = claim.status || '';
    // Address parts
    mergeMap['address.street'] = claim.policyholder_address?.split(',')[0]?.trim() || '';
    mergeMap['address.city'] = claim.policyholder_address?.split(',')[1]?.trim() || '';
  }

  // Inspection fields
  const inspSource = inspection || triggerData;
  if (inspSource) {
    mergeMap['inspection.date'] = inspSource.inspection_date || triggerData?.inspection_date || '';
    mergeMap['inspection.time'] = (inspSource.inspection_time || triggerData?.inspection_time) 
      ? formatTimeTo12Hour(inspSource.inspection_time || triggerData?.inspection_time) : '';
    mergeMap['inspection.type'] = inspSource.inspection_type || triggerData?.inspection_type || '';
    mergeMap['inspection.inspector'] = inspSource.inspector_name || triggerData?.inspector_name || '';
  }

  // Replace ${field} format (new standard)
  result = result.replace(/\$\{([^}]+)\}/g, (match, field) => {
    if (mergeMap[field] !== undefined) return mergeMap[field];
    // Fallback: check claim directly
    if (claim && claim[field] !== undefined && claim[field] !== null) return String(claim[field]);
    return '';
  });

  // Legacy: replace {claim.field} format for backward compatibility
  if (claim) {
    result = result.replace(/\{claim\.(\w+)\}/g, (_, field) => claim[field] || '');
    result = result.replace(/\{\{(\w+)\}\}/g, (match, field) => {
      if (claim[field] !== undefined && claim[field] !== null) return claim[field];
      if (triggerData && triggerData[field] !== undefined && triggerData[field] !== null) {
        if (field === 'inspection_time' && triggerData[field]) return formatTimeTo12Hour(triggerData[field]);
        return triggerData[field];
      }
      if (inspection && inspection[field] !== undefined && inspection[field] !== null) {
        if (field === 'inspection_time' && inspection[field]) return formatTimeTo12Hour(inspection[field]);
        return inspection[field];
      }
      return '';
    });
  }
  
  // Legacy: replace {trigger.field} and {inspection.field}
  if (triggerData) {
    result = result.replace(/\{trigger\.(\w+)\}/g, (_, field) => triggerData[field] || '');
    result = result.replace(/\{inspection\.date\}/g, triggerData.inspection_date || '');
    result = result.replace(/\{inspection\.time\}/g, triggerData.inspection_time ? formatTimeTo12Hour(triggerData.inspection_time) : '');
    result = result.replace(/\{inspection\.type\}/g, triggerData.inspection_type || '');
    result = result.replace(/\{inspection\.inspector\}/g, triggerData.inspector_name || '');
    result = result.replace(/\{inspection\.notes\}/g, triggerData.notes || '');
  }
  if (inspection) {
    result = result.replace(/\{inspection\.date\}/g, inspection.inspection_date || '');
    result = result.replace(/\{inspection\.time\}/g, inspection.inspection_time ? formatTimeTo12Hour(inspection.inspection_time) : '');
    result = result.replace(/\{inspection\.type\}/g, inspection.inspection_type || '');
    result = result.replace(/\{inspection\.inspector\}/g, inspection.inspector_name || '');
  }
  
  return result;
}
