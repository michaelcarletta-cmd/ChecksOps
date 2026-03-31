import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ClaimUpdatePayload {
  claimId: string;
  changeType: 'status_change' | 'settlement_update' | 'document_added' | 'inspection_scheduled' | 'general_update';
  oldValue?: string;
  newValue?: string;
  customMessage?: string;
  folderName?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const payload: ClaimUpdatePayload = await req.json();
    const { claimId, changeType, oldValue, newValue, customMessage, folderName } = payload;

    console.log(`Processing client notification for claim ${claimId}, change type: ${changeType}, folder: ${folderName || 'none'}`);

    // FOLDER GATE: Only send document_added notifications for Carrier Documents folder
    if (changeType === 'document_added') {
      const carrierFolderNames = ['carrier documents', 'carrier docs', 'carrier correspondence'];
      const normalizedFolder = (folderName || '').toLowerCase().trim();
      if (!normalizedFolder || !carrierFolderNames.some(cf => normalizedFolder.includes(cf))) {
        console.log(`Skipping document_added notification - folder "${folderName}" is not a Carrier Documents folder`);
        return new Response(
          JSON.stringify({ success: true, skipped: true, reason: 'non_carrier_folder' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Fetch claim details with client info
    const { data: claim, error: claimError } = await supabase
      .from('claims')
      .select(`
        *,
        clients(id, name, email, user_id)
      `)
      .eq('id', claimId)
      .single();

    if (claimError || !claim) {
      console.error('Failed to fetch claim:', claimError);
      return new Response(
        JSON.stringify({ error: 'Claim not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Skip notifications for closed/settled claims
    const closedStatuses = ['Claim Settled', 'Dead File', 'Closed'];
    if (claim.is_closed || closedStatuses.includes(claim.status)) {
      console.log(`Skipping notification - claim ${claimId} is closed/settled (status: ${claim.status})`);
      return new Response(
        JSON.stringify({ success: true, skipped: true, reason: 'claim_closed' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check if claim has client notification enabled
    const { data: automation } = await supabase
      .from('claim_automations')
      .select('settings')
      .eq('claim_id', claimId)
      .single();

    const settings = automation?.settings as Record<string, any> || {};
    
    // Skip if client notifications are disabled
    if (!settings.notify_client_on_updates) {
      console.log('Client notifications disabled for this claim');
      return new Response(
        JSON.stringify({ success: true, skipped: true, reason: 'notifications_disabled' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get client email - either from linked client or policyholder email
    const clientEmail = claim.clients?.email || claim.policyholder_email;
    const clientName = claim.clients?.name || claim.policyholder_name || 'Valued Customer';

    if (!clientEmail) {
      console.log('No client email found for notification');
      return new Response(
        JSON.stringify({ success: true, skipped: true, reason: 'no_client_email' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Generate email content based on change type
    let subject = '';
    let body = '';
    const claimRef = claim.claim_number || `#${claimId.slice(0, 8)}`;

    switch (changeType) {
      case 'status_change':
        subject = `Claim Update: Your Claim ${claimRef} Status Has Changed`;
        body = `Dear ${clientName},\n\nWe wanted to let you know that the status of your claim has been updated.\n\n` +
          `Claim Number: ${claimRef}\n` +
          (oldValue ? `Previous Status: ${oldValue}\n` : '') +
          `New Status: ${newValue}\n\n` +
          `If you have any questions about this change, please don't hesitate to reach out.\n\n` +
          `Best regards,\nFreedom Claims Team`;
        break;

      case 'settlement_update':
        subject = `Claim Update: Settlement Information Updated - ${claimRef}`;
        body = `Dear ${clientName},\n\nThere has been an update to the settlement information for your claim.\n\n` +
          `Claim Number: ${claimRef}\n\n` +
          `Our team is working diligently to ensure the best outcome for your claim. ` +
          `Please log into your portal to view the updated details.\n\n` +
          `Best regards,\nFreedom Claims Team`;
        break;

      case 'document_added':
        subject = `New Document Added to Your Claim ${claimRef}`;
        body = `Dear ${clientName},\n\nA new document has been added to your claim file.\n\n` +
          `Claim Number: ${claimRef}\n` +
          (newValue ? `Document: ${newValue}\n\n` : '\n') +
          `You can view this document by logging into your client portal.\n\n` +
          `Best regards,\nFreedom Claims Team`;
        break;

      case 'inspection_scheduled':
        subject = `Inspection Scheduled for Your Claim ${claimRef}`;
        body = `Dear ${clientName},\n\nAn inspection has been scheduled for your claim.\n\n` +
          `Claim Number: ${claimRef}\n` +
          (newValue ? `Scheduled Date: ${newValue}\n\n` : '\n') +
          `Please ensure someone is available at the property during this time. ` +
          `If you need to reschedule, please contact us as soon as possible.\n\n` +
          `Best regards,\nFreedom Claims Team`;
        break;

      case 'general_update':
      default:
        subject = `Update on Your Claim ${claimRef}`;
        body = customMessage || 
          `Dear ${clientName},\n\nThere has been an update on your claim.\n\n` +
          `Claim Number: ${claimRef}\n\n` +
          `Please log into your client portal to view the latest details.\n\n` +
          `Best regards,\nFreedom Claims Team`;
        break;
    }

    // Send the email notification
    const sendResponse = await fetch(
      `${Deno.env.get('SUPABASE_URL')}/functions/v1/send-email`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recipients: [{ email: clientEmail, name: clientName, type: 'client_notification' }],
          subject,
          body,
          claimId,
        }),
      }
    );

    if (!sendResponse.ok) {
      const errorText = await sendResponse.text();
      console.error('Failed to send client notification:', errorText);
      return new Response(
        JSON.stringify({ error: 'Failed to send notification' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Client notification sent to ${clientEmail} for claim ${claimRef}`);

    // Log the notification in claim updates
    await supabase
      .from('claim_updates')
      .insert({
        claim_id: claimId,
        content: `📧 Automatic notification sent to client (${clientEmail}): ${changeType.replace(/_/g, ' ')}`,
        update_type: 'client_notification',
      });

    return new Response(
      JSON.stringify({ success: true, recipient: clientEmail }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error("Error sending client notification:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
