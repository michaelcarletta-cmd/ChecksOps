import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Attachment {
  filePath: string;
  fileName: string;
  fileType: string | null;
}

interface RecipientInfo {
  email: string;
  name: string;
  type: string;
}

interface ResendAttachment {
  filename: string;
  content: string; // base64
}

async function sendResendEmail(
  apiKey: string,
  toEmails: string[],
  subject: string,
  htmlContent: string,
  attachments?: ResendAttachment[],
  ccEmails?: string[],
  replyTo?: string
) {
const payload: any = {
    from: "Freedom Claims <claims@freedomclaims.work>",
    to: toEmails,
    subject: subject,
    html: htmlContent,
  };

  if (replyTo) {
    payload.reply_to = replyTo;
  }

  if (ccEmails && ccEmails.length > 0) {
    payload.cc = ccEmails;
  }

  if (attachments && attachments.length > 0) {
    payload.attachments = attachments;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(`Resend error: ${JSON.stringify(result)}`);
  }

  return result;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) {
      throw new Error("RESEND_API_KEY not configured");
    }
    
    const requestBody = await req.json();
    
    // Support both old single recipient format and new multiple recipients format
    let recipients: RecipientInfo[] = [];
    
    if (requestBody.recipients && Array.isArray(requestBody.recipients)) {
      // New format: multiple recipients
      recipients = requestBody.recipients;
    } else if (requestBody.to) {
      // Old format: single recipient (backwards compatibility)
      recipients = [{
        email: requestBody.to,
        name: requestBody.recipientName || requestBody.to,
        type: requestBody.recipientType || 'manual'
      }];
    }
    
    const { subject, body, claimId, attachments, claimEmailCc } = requestBody;

    if (recipients.length === 0 || !subject || !body) {
      throw new Error("Missing required fields: recipients, subject, and body are required");
    }

    // Validate all emails
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const recipient of recipients) {
      if (!emailRegex.test(recipient.email)) {
        throw new Error(`Invalid email address: ${recipient.email}`);
      }
    }

    // Get authorization header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('No authorization header');
    }

    // Create Supabase client with service role for storage access
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      {
        auth: {
          persistSession: false,
        },
      }
    );

    // Check if this is a service-to-service call (using service role key)
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const isServiceCall = authHeader === `Bearer ${serviceRoleKey}`;

    let userId: string | null = null;
    let emailSignature = '';

    if (isServiceCall) {
      // Service-to-service call - no user authentication needed
      console.log('Service-to-service call detected, skipping user auth');
    } else {
      // Create Supabase client with user's auth token for user data
      const supabase = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_ANON_KEY') ?? '',
        {
          global: {
            headers: { Authorization: authHeader },
          },
          auth: {
            persistSession: false,
          },
        }
      );

      // Get current user from the JWT token
      const { data: { user }, error: userError } = await supabase.auth.getUser(
        authHeader.replace('Bearer ', '')
      );
      if (userError || !user) {
        console.error('Auth error:', userError);
        throw new Error('Unauthorized');
      }

      userId = user.id;

      // Fetch user's email signature from profile
      const { data: profile } = await supabase
        .from('profiles')
        .select('email_signature')
        .eq('id', user.id)
        .single();

      emailSignature = (profile as any)?.email_signature || '';
    }

    // Append signature if available
    const fullBody = emailSignature 
      ? `${body}\n\n--\n${emailSignature}`
      : body;

    // Process attachments if provided
    const emailAttachments: ResendAttachment[] = [];
    const attachmentErrors: string[] = [];
    
    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      console.log(`Processing ${attachments.length} attachments:`, JSON.stringify(attachments));
      
      const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB max per file (edge function memory limit)
      
      for (const attachment of attachments as Attachment[]) {
        try {
          console.log(`Processing attachment: ${attachment.fileName} from path: ${attachment.filePath}`);
          
          // Extract directory and filename from path to check size first
          const pathParts = attachment.filePath.split('/');
          const fileName = pathParts.pop() || '';
          const directory = pathParts.join('/');
          
          // Check file size BEFORE downloading to avoid memory issues
          const { data: fileList, error: listError } = await supabaseAdmin.storage
            .from('claim-files')
            .list(directory, {
              search: fileName,
              limit: 1
            });
          
          if (listError) {
            console.warn(`Could not check file size for ${attachment.fileName}, proceeding with download`);
          } else if (fileList && fileList.length > 0) {
            const fileMetadata = fileList.find(f => f.name === fileName);
            if (fileMetadata && fileMetadata.metadata?.size) {
              const fileSize = fileMetadata.metadata.size;
              if (fileSize > MAX_FILE_SIZE) {
                const errorMsg = `Skipping ${attachment.fileName} - file too large (${(fileSize / 1024 / 1024).toFixed(2)} MB, max ${MAX_FILE_SIZE / 1024 / 1024}MB). Please use a file sharing link instead.`;
                console.warn(errorMsg);
                attachmentErrors.push(errorMsg);
                continue;
              }
            }
          }
          
          // Download file from storage
          const { data: fileData, error: downloadError } = await supabaseAdmin.storage
            .from('claim-files')
            .download(attachment.filePath);
          
          if (downloadError) {
            const errorMsg = `Failed to download ${attachment.fileName}: ${downloadError.message}`;
            console.error(errorMsg);
            attachmentErrors.push(errorMsg);
            continue;
          }
          
          if (!fileData) {
            const errorMsg = `No file data returned for ${attachment.fileName}`;
            console.error(errorMsg);
            attachmentErrors.push(errorMsg);
            continue;
          }
          
          // Double-check size after download (in case list didn't return size)
          if (fileData.size > MAX_FILE_SIZE) {
            const errorMsg = `Skipping ${attachment.fileName} - file too large (${(fileData.size / 1024 / 1024).toFixed(2)} MB, max ${MAX_FILE_SIZE / 1024 / 1024}MB). Please use a file sharing link instead.`;
            console.warn(errorMsg);
            attachmentErrors.push(errorMsg);
            continue;
          }
          
          console.log(`Downloaded ${attachment.fileName}, size: ${fileData.size} bytes`);
          
          // Convert to base64 using chunked approach (memory efficient)
          const arrayBuffer = await fileData.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);
          
          // Chunked base64 encoding to avoid memory issues
          const chunkSize = 32768;
          let base64Content = '';
          for (let i = 0; i < uint8Array.length; i += chunkSize) {
            const chunk = uint8Array.subarray(i, i + chunkSize);
            base64Content += String.fromCharCode.apply(null, chunk as unknown as number[]);
          }
          base64Content = btoa(base64Content);
          
          emailAttachments.push({
            filename: attachment.fileName,
            content: base64Content,
          });
          
          console.log(`Successfully processed attachment: ${attachment.fileName} (${(uint8Array.length / 1024).toFixed(2)} KB)`);
        } catch (err) {
          const errorMsg = `Error processing ${attachment.fileName}: ${err instanceof Error ? err.message : String(err)}`;
          console.error(errorMsg);
          attachmentErrors.push(errorMsg);
        }
      }
      
      console.log(`Attachment processing complete: ${emailAttachments.length}/${attachments.length} successful`);
      if (attachmentErrors.length > 0) {
        console.warn(`Attachment errors: ${attachmentErrors.join('; ')}`);
      }
    }

    // Extract all email addresses for the 'to' field
    const toEmails = recipients.map(r => r.email);

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="white-space: pre-wrap;">${fullBody}</div>
        <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
        <p style="color: #999; font-size: 11px;">
          This email was sent from Freedom Claims CRM.
        </p>
      </div>
    `;

    // Build CC list with claim email if provided
    const ccList: string[] = [];
    if (claimEmailCc) {
      ccList.push(claimEmailCc);
    }

    // Build Reply-To address from claim's email so replies come back to the CRM
    let replyToAddress: string | undefined;
    if (claimId) {
      const { data: claimForReply } = await supabaseAdmin
        .from('claims')
        .select('claim_email_id, policy_number')
        .eq('id', claimId)
        .single();
      
      if (claimForReply) {
        const emailId = claimForReply.claim_email_id || 
          (claimForReply.policy_number 
            ? claimForReply.policy_number.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
            : null);
        if (emailId) {
          replyToAddress = `claim-${emailId}@freedomclaims.work`;
          console.log(`Setting Reply-To: ${replyToAddress}`);
        }
      }
    }

    console.log(`Sending email via Resend to ${toEmails.join(', ')}${ccList.length > 0 ? ` (CC: ${ccList.join(', ')})` : ''}${replyToAddress ? ` (Reply-To: ${replyToAddress})` : ''} with ${emailAttachments.length} attachments`);

    // Send via Resend
    const emailResponse = await sendResendEmail(
      resendApiKey,
      toEmails,
      subject,
      htmlContent,
      emailAttachments.length > 0 ? emailAttachments : undefined,
      ccList.length > 0 ? ccList : undefined,
      replyToAddress
    );

    console.log(`Email sent via Resend:`, emailResponse);

    // Log email to database for each recipient if claimId provided
    if (claimId) {
      for (const recipient of recipients) {
        const { error: dbError } = await supabaseAdmin
          .from('emails')
          .insert({
            claim_id: claimId,
            sent_by: userId,
            recipient_email: recipient.email,
            recipient_name: recipient.name,
            recipient_type: recipient.type,
            subject: subject,
            body: body,
            provider_message_id: emailResponse.id || null,
            send_status: 'sent',
          });

        if (dbError) {
          console.error(`Failed to log email to database for ${recipient.email}:`, dbError);
        }
      }
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        recipientCount: recipients.length,
        attachmentCount: emailAttachments.length,
        attachmentsRequested: attachments?.length || 0,
        attachmentErrors: attachmentErrors.length > 0 ? attachmentErrors : undefined,
        messageId: emailResponse.id
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error sending email:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
