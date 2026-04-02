import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Decode quoted-printable encoding
function decodeQuotedPrintable(str: string): string {
  return str
    .replace(/=\r?\n/g, '') // Remove soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Decode base64 encoding
function decodeBase64(str: string): string {
  try {
    // Remove any whitespace/newlines from base64 string
    const cleaned = str.replace(/[\r\n\s]/g, '');
    return atob(cleaned);
  } catch (e) {
    console.error('Base64 decode error:', e);
    return str;
  }
}

// Detect if content is base64 encoded
function isBase64Encoded(str: string): boolean {
  // Check if string looks like base64 (only base64 chars, length is multiple of 4, etc.)
  const cleaned = str.replace(/[\r\n\s]/g, '');
  if (cleaned.length === 0 || cleaned.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/=]+$/.test(cleaned) && cleaned.length > 50;
}

// Extract clean text from raw MIME email
function extractEmailBody(rawContent: string): { text: string; html: string } {
  let text = '';
  let html = '';

  console.log("extractEmailBody: Processing content of length", rawContent.length);

  // Check if it's a multipart message
  const boundaryMatch = rawContent.match(/boundary="?([^"\s;]+)"?/i);
  
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    console.log("Found multipart boundary:", boundary);
    const parts = rawContent.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    
    for (const part of parts) {
      const isPlainText = part.includes('Content-Type: text/plain');
      const isHtml = part.includes('Content-Type: text/html');
      
      if (isPlainText || isHtml) {
        // Extract encoding
        const contentMatch = part.match(/Content-Transfer-Encoding:\s*(\S+)/i);
        const encoding = contentMatch ? contentMatch[1].toLowerCase() : '';
        console.log(`Found ${isPlainText ? 'text/plain' : 'text/html'} part with encoding:`, encoding);
        
        // Find the actual content (after the headers, separated by double newline)
        const bodyMatch = part.split(/\r?\n\r?\n/);
        if (bodyMatch.length > 1) {
          let content = bodyMatch.slice(1).join('\n\n').trim();
          
          // Remove trailing boundary markers
          content = content.replace(/--$/, '').trim();
          // Also remove any trailing boundary content
          content = content.replace(/\r?\n--_[^\n]+$/g, '').trim();
          
          if (encoding === 'quoted-printable') {
            content = decodeQuotedPrintable(content);
          } else if (encoding === 'base64' || isBase64Encoded(content)) {
            console.log("Decoding base64 content of length:", content.length);
            content = decodeBase64(content);
          }
          
          if (isPlainText && !text) {
            text = content;
          } else if (isHtml && !html) {
            html = content;
          }
        }
      }
    }
  } else {
    // Single part message - check if it needs decoding
    const encodingMatch = rawContent.match(/Content-Transfer-Encoding:\s*(\S+)/i);
    const encoding = encodingMatch ? encodingMatch[1].toLowerCase() : '';
    
    const bodyMatch = rawContent.split(/\r?\n\r?\n/);
    if (bodyMatch.length > 1) {
      let content = bodyMatch.slice(1).join('\n\n').trim();
      
      if (encoding === 'quoted-printable') {
        content = decodeQuotedPrintable(content);
      } else if (encoding === 'base64' || isBase64Encoded(content)) {
        content = decodeBase64(content);
      }
      text = content;
    } else {
      text = rawContent;
    }
  }

  console.log("Extracted text length:", text.length, "html length:", html.length);
  return { text, html };
}

// Strip HTML tags to get plain text
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface NormalizedAttachment {
  fileName: string;
  contentType: string;
  base64Content?: string;
  bytes?: Uint8Array;
}

function sanitizeFileName(fileName: string): string {
  const cleaned = fileName
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'attachment';
}

function decodeBase64ToBytes(base64: string): Uint8Array | null {
  try {
    const cleaned = base64.replace(/[\r\n\s]/g, '');
    const binaryString = atob(cleaned);
    return Uint8Array.from(binaryString, char => char.charCodeAt(0));
  } catch (e) {
    console.error('Attachment base64 decode error:', e);
    return null;
  }
}

function extractAttachmentContent(attachment: Record<string, unknown>): string | undefined {
  const candidates = [
    attachment.content,
    attachment.Content,
    attachment.data,
    attachment.base64,
    attachment.contentBytes,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
    if (candidate && typeof candidate === 'object' && 'data' in candidate) {
      const nested = (candidate as { data?: unknown }).data;
      if (typeof nested === 'string' && nested.trim()) return nested;
    }
  }

  return undefined;
}

function normalizePayloadAttachments(payload: Record<string, unknown>): NormalizedAttachment[] {
  const sources = [
    payload.attachments,
    payload.Attachments,
    (payload.data as { attachments?: unknown } | undefined)?.attachments,
    (payload.email as { attachments?: unknown } | undefined)?.attachments,
  ];

  const rawAttachments: Record<string, unknown>[] = [];
  for (const source of sources) {
    if (Array.isArray(source)) {
      rawAttachments.push(...source.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object'));
    }
  }

  return rawAttachments.map((attachment) => ({
    fileName: sanitizeFileName(
      String(
        attachment.filename ||
        attachment.fileName ||
        attachment.name ||
        attachment.Name ||
        'attachment'
      )
    ),
    contentType: String(
      attachment.contentType ||
      attachment.content_type ||
      attachment.ContentType ||
      attachment.mimeType ||
      attachment.type ||
      'application/octet-stream'
    ),
    base64Content: extractAttachmentContent(attachment),
  }));
}

function extractFileNameFromMimeHeaders(headers: string): string | null {
  const encodedFileNameMatch = headers.match(/filename\*=UTF-8''([^\r\n;]+)/i);
  if (encodedFileNameMatch?.[1]) {
    try {
      return decodeURIComponent(encodedFileNameMatch[1]);
    } catch {
      return encodedFileNameMatch[1];
    }
  }

  const fileNameMatch = headers.match(/filename="?([^"\r\n;]+)"?/i);
  if (fileNameMatch?.[1]) return fileNameMatch[1];

  const nameMatch = headers.match(/name="?([^"\r\n;]+)"?/i);
  if (nameMatch?.[1]) return nameMatch[1];

  return null;
}

function extractRawMimeAttachments(rawContent: string): NormalizedAttachment[] {
  if (!rawContent) return [];

  const boundaryMatch = rawContent.match(/boundary="?([^"\s;]+)"?/i);
  if (!boundaryMatch?.[1]) return [];

  const boundary = boundaryMatch[1];
  const escapedBoundary = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = rawContent.split(new RegExp(`--${escapedBoundary}`));
  const extracted: NormalizedAttachment[] = [];

  for (const part of parts) {
    const trimmedPart = part.trim();
    if (!trimmedPart || trimmedPart === '--') continue;

    const partSections = part.split(/\r?\n\r?\n/);
    if (partSections.length < 2) continue;

    const headers = partSections[0] || '';
    const body = partSections.slice(1).join('\n\n').trim();
    if (!headers || !body) continue;

    const headerLower = headers.toLowerCase();
    const fileName = extractFileNameFromMimeHeaders(headers);
    const contentTypeMatch = headers.match(/content-type:\s*([^;\r\n]+)/i);
    const contentType = contentTypeMatch?.[1]?.trim() || 'application/octet-stream';

    const isAttachment =
      headerLower.includes('content-disposition: attachment') ||
      (!!fileName && !/content-type:\s*text\/(plain|html)/i.test(headers));

    if (!isAttachment) continue;

    const transferEncodingMatch = headers.match(/content-transfer-encoding:\s*([^\r\n]+)/i);
    const transferEncoding = transferEncodingMatch?.[1]?.trim().toLowerCase() || '';

    let bytes: Uint8Array | null = null;
    if (transferEncoding === 'base64' || isBase64Encoded(body)) {
      bytes = decodeBase64ToBytes(body);
    } else if (transferEncoding === 'quoted-printable') {
      bytes = new TextEncoder().encode(decodeQuotedPrintable(body));
    } else {
      bytes = new TextEncoder().encode(body);
    }

    if (!bytes || bytes.length === 0) continue;

    extracted.push({
      fileName: sanitizeFileName(fileName || `attachment-${extracted.length + 1}`),
      contentType,
      bytes,
    });
  }

  return extracted;
}

function collectInboundAttachments(payload: Record<string, unknown>, rawContent: string): NormalizedAttachment[] {
  const payloadAttachments = normalizePayloadAttachments(payload);
  const rawMimeAttachments = extractRawMimeAttachments(rawContent);
  const deduped = new Map<string, NormalizedAttachment>();

  for (const attachment of [...payloadAttachments, ...rawMimeAttachments]) {
    const key = `${attachment.fileName.toLowerCase()}::${attachment.contentType.toLowerCase()}`;
    if (!deduped.has(key)) deduped.set(key, attachment);
  }

  return Array.from(deduped.values());
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Validate webhook secret to prevent unauthorized access
    // Check header first, then fall back to query parameter (for Resend webhooks)
    const webhookSecret = Deno.env.get('INBOUND_EMAIL_WEBHOOK_SECRET');
    const url = new URL(req.url);
    const providedSecret = req.headers.get('x-email-webhook-secret') || url.searchParams.get('secret');

    if (!webhookSecret) {
      console.error("INBOUND_EMAIL_WEBHOOK_SECRET not configured");
      return new Response(
        JSON.stringify({ error: "Server misconfiguration" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!providedSecret || providedSecret !== webhookSecret) {
      console.error("Invalid or missing webhook secret. Header present:", !!req.headers.get('x-email-webhook-secret'), "Query present:", !!url.searchParams.get('secret'));
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const payload = await req.json();
    
    console.log("Received inbound email payload:", JSON.stringify(payload, null, 2).substring(0, 2000));

    // Support multiple formats:
    // 1. Cloudflare Email Workers format (preferred)
    // 2. Mailjet Parse API format (legacy)
    // 3. Resend format (legacy)
    
    let from: string = '';
    let to: string = '';
    let subject: string = '';
    let text: string = '';
    let html: string = '';
    let rawContent: string = '';

    // Cloudflare Email Workers format
    if (payload.from && payload.to && payload.source === 'cloudflare') {
      from = payload.from;
      to = payload.to;
      subject = payload.subject || '(No Subject)';
      text = payload.text || '';
      html = payload.html || '';
      rawContent = payload.raw || '';
      console.log("Processing Cloudflare Email Worker payload");
    }
    // Mailjet Parse API format
    else if (payload.Sender || payload.Recipient) {
      from = payload.From || payload.Sender || '';
      to = payload.Recipient || '';
      subject = payload.Subject || '(No Subject)';
      text = payload["Text-part"] || '';
      html = payload["Html-part"] || '';
      console.log("Processing Mailjet payload");
    }
    // Resend/generic format
    else {
      from = typeof payload.from === 'string' ? payload.from : payload.from?.email || '';
      to = typeof payload.to === 'string' ? payload.to : (Array.isArray(payload.to) ? payload.to[0] : payload.to?.email || '');
      subject = payload.subject || '(No Subject)';
      text = payload.text || '';
      html = payload.html || '';
      rawContent = payload.raw || '';
      console.log("Processing generic payload");
    }

    // If we have raw content but no clean text/html, parse it
    if (rawContent && (!text || text.includes('Content-Type:') || text.includes('--_'))) {
      console.log("Parsing raw MIME content...");
      const extracted = extractEmailBody(rawContent);
      if (extracted.text) text = extracted.text;
      if (extracted.html) html = extracted.html;
    }

    // If text still looks like raw MIME, try to extract it
    if (text && (text.includes('Content-Type:') || text.includes('--_') || text.includes('boundary='))) {
      console.log("Text appears to be raw MIME, extracting...");
      const extracted = extractEmailBody(text);
      if (extracted.text) {
        text = extracted.text;
      } else if (extracted.html) {
        text = stripHtml(extracted.html);
      }
    }

    // If we only have HTML, convert to plain text for display
    if (!text && html) {
      text = stripHtml(html);
    }

    // Final cleanup - remove any remaining MIME artifacts
    text = text
      .replace(/^[\s\S]*?Content-Transfer-Encoding:[^\n]*\n\n/i, '')
      .replace(/--_[^\s]+--?\s*$/g, '')
      .trim();

    console.log("Final cleaned text:", text.substring(0, 500));

    // Parse the "to" address to find the claim identifier
    // Expected format: claim-{policy_number}@freedomclaims.work
    const toAddresses = Array.isArray(to) ? to : [to];
    let claimIdentifier: string | null = null;

    for (const addr of toAddresses) {
      const email = typeof addr === 'string' ? addr : addr?.email || addr;
      if (!email) continue;
      
      // Match claim-{identifier}@ pattern
      const match = email.match(/claim-([a-z0-9-]+)@/i);
      if (match) {
        claimIdentifier = match[1];
        break;
      }
    }

    if (!claimIdentifier) {
      console.log("No claim identifier found in recipient addresses:", toAddresses);
      return new Response(
        JSON.stringify({ error: "No claim identifier found" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Found claim identifier:", claimIdentifier);

    // Create Supabase client with service role for backend operations
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Try to find the claim by policy_number first (new format)
    let claim = null;

    // First, try exact match on claim_email_id (legacy format)
    const { data: claimById } = await supabase
      .from('claims')
      .select('id, claim_number, policy_number')
      .eq('claim_email_id', claimIdentifier)
      .single();

    if (claimById) {
      claim = claimById;
    } else {
      // Try to match by sanitized policy number
      const { data: allClaims } = await supabase
        .from('claims')
        .select('id, claim_number, policy_number, claim_email_id')
        .not('policy_number', 'is', null);

      if (allClaims) {
        // Find claim with matching sanitized policy number
        for (const c of allClaims) {
          if (c.policy_number) {
            const sanitized = c.policy_number
              .toLowerCase()
              .replace(/[^a-z0-9]/g, '-')
              .replace(/-+/g, '-')
              .replace(/^-|-$/g, '');
            
            if (sanitized === claimIdentifier.toLowerCase()) {
              claim = c;
              break;
            }
          }
        }
      }
    }

    if (!claim) {
      console.error("Claim not found for identifier:", claimIdentifier);
      return new Response(
        JSON.stringify({ error: "Claim not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Extract sender info
    let senderEmail = '';
    let senderName = '';

    // Parse "Name <email>" format
    const fromMatch = from.match(/^(.+?)\s*<(.+)>$/);
    if (fromMatch) {
      senderName = fromMatch[1].trim().replace(/^["']|["']$/g, '');
      senderEmail = fromMatch[2];
    } else {
      senderEmail = from;
      senderName = from.split('@')[0];
    }

    // Log the email to the emails table
    const { data: insertedEmail, error: insertError } = await supabase
      .from('emails')
      .insert({
        claim_id: claim.id,
        recipient_email: senderEmail, // Store sender as "recipient" for inbound
        recipient_name: senderName,
        recipient_type: 'inbound',
        subject: subject,
        body: text || '(No Content)',
        sent_by: null, // Inbound emails have no internal sender
      })
      .select()
      .single();

    if (insertError) {
      console.error("Failed to insert email:", insertError);
      return new Response(
        JSON.stringify({ error: "Failed to save email" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Email logged to claim ${claim.claim_number} (policy: ${claim.policy_number}) from ${senderEmail}`);

    // Process email attachments from payload and/or raw MIME body
    const attachments = collectInboundAttachments(payload as Record<string, unknown>, rawContent);
    const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB limit
    
    for (const attachment of attachments) {
      try {
        const fileName = attachment.fileName || 'attachment';
        const contentType = attachment.contentType || 'application/octet-stream';
        
        let fileBuffer = attachment.bytes;
        if (!fileBuffer && attachment.base64Content) {
          fileBuffer = decodeBase64ToBytes(attachment.base64Content);
        }

        if (!fileBuffer) {
          console.log(`Skipping attachment ${fileName}: no content`);
          continue;
        }
        
        // Skip large attachments
        if (fileBuffer.length > MAX_ATTACHMENT_SIZE) {
          console.log(`Skipping attachment ${fileName}: too large (${fileBuffer.length} bytes)`);
          continue;
        }
        
        const storagePath = `${claim.id}/email-attachments/${Date.now()}-${sanitizeFileName(fileName)}`;
        
        // Upload to storage
        const { error: uploadError } = await supabase.storage
          .from('claim-files')
          .upload(storagePath, fileBuffer, { contentType });
        
        if (uploadError) {
          console.error(`Failed to upload attachment ${fileName}:`, uploadError);
          continue;
        }
        
        // Create file record linked to the email
        const { data: fileRecord, error: fileError } = await supabase
          .from('claim_files')
          .insert({
            claim_id: claim.id,
            file_name: fileName,
            file_path: storagePath,
            file_size: fileBuffer.length,
            file_type: contentType,
            source: 'email_attachment',
            uploaded_by: null,
            email_id: insertedEmail?.id || null,
          })
          .select()
          .single();
        
        if (fileError) {
          console.error(`Failed to create file record for ${fileName}:`, fileError);
          continue;
        }
        
        console.log(`Attachment ${fileName} saved to claim ${claim.id}`);
        
        // Trigger Darwin processing (fire and forget)
        if (fileRecord) {
          fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/darwin-process-document`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ fileId: fileRecord.id })
          }).catch(err => console.error('Darwin attachment processing error:', err));
        }
        
        // Log attachment to claim activity
        await supabase
          .from('claim_updates')
          .insert({
            claim_id: claim.id,
            content: `📎 Email attachment received: "${fileName}" from ${senderName}`,
            update_type: 'file_uploaded',
          });
          
      } catch (attachmentError) {
        console.error('Error processing attachment:', attachmentError);
      }
    }
    
    if (attachments.length > 0) {
      console.log(`Processed ${attachments.length} email attachment(s) for claim ${claim.id}`);
    }

    // Identify sender type for automation triggers
    let senderType: 'insurance' | 'client' | 'contractor' | 'unknown' = 'unknown';
    
    // Check if sender is from insurance/adjuster
    const { data: claimData } = await supabase
      .from('claims')
      .select('adjuster_email, insurance_email, policyholder_email')
      .eq('id', claim.id)
      .single();
    
    if (claimData) {
      const senderLower = senderEmail.toLowerCase();
      
      // Check adjuster emails
      if (claimData.adjuster_email?.toLowerCase() === senderLower ||
          claimData.insurance_email?.toLowerCase() === senderLower) {
        senderType = 'insurance';
      }
      // Check claim_adjusters table too
      if (senderType === 'unknown') {
        const { data: adjusters } = await supabase
          .from('claim_adjusters')
          .select('adjuster_email')
          .eq('claim_id', claim.id);
        
        if (adjusters?.some(a => a.adjuster_email?.toLowerCase() === senderLower)) {
          senderType = 'insurance';
        }
      }
      // Check policyholder
      if (senderType === 'unknown' && claimData.policyholder_email?.toLowerCase() === senderLower) {
        senderType = 'client';
      }
      // Check contractors
      if (senderType === 'unknown') {
        const { data: contractors } = await supabase
          .from('claim_contractors')
          .select('contractor_id')
          .eq('claim_id', claim.id);
        
        if (contractors && contractors.length > 0) {
          const contractorIds = contractors.map(c => c.contractor_id);
          const { data: profiles } = await supabase
            .from('profiles')
            .select('email')
            .in('id', contractorIds);
          
          if (profiles?.some(p => p.email?.toLowerCase() === senderLower)) {
            senderType = 'contractor';
          }
        }
      }
    }
    
    console.log(`Identified sender type: ${senderType}`);

    // Check for inbound_email automations
    const { data: emailAutomations } = await supabase
      .from('automations')
      .select('*')
      .eq('trigger_type', 'inbound_email')
      .eq('is_active', true);

    if (emailAutomations && emailAutomations.length > 0) {
      for (const automation of emailAutomations) {
        const config = automation.trigger_config as { sender_type?: string } || {};
        const configSenderType = config.sender_type || 'any';
        
        // Check if this automation should trigger
        if (configSenderType === 'any' || configSenderType === senderType) {
          console.log(`Queueing automation "${automation.name}" for claim ${claim.id}`);
          
          // Create execution record
          await supabase
            .from('automation_executions')
            .insert({
              automation_id: automation.id,
              claim_id: claim.id,
              status: 'pending',
              trigger_data: {
                email_id: insertedEmail.id,
                sender_email: senderEmail,
                sender_name: senderName,
                sender_type: senderType,
                subject: subject,
              },
            });
        }
      }
    }

    // Check if this claim has AI automation enabled
    const { data: automation } = await supabase
      .from('claim_automations')
      .select('*')
      .eq('claim_id', claim.id)
      .eq('is_enabled', true)
      .maybeSingle();

    if (automation) {
      const settings = automation.settings as { auto_respond_emails?: boolean; auto_update_notes?: boolean } | null;
      
      // IMPORTANT: Stop follow-ups when a response is received
      if (automation.follow_up_enabled && !automation.follow_up_stopped_at) {
        console.log(`Stopping follow-ups for claim ${claim.claim_number} - response received`);
        
        await supabase
          .from('claim_automations')
          .update({
            follow_up_stopped_at: new Date().toISOString(),
            follow_up_stop_reason: 'response_received',
          })
          .eq('id', automation.id);
      }
      
      if (settings?.auto_respond_emails) {
        console.log(`Triggering AI response draft for claim ${claim.claim_number}`);
        
        // Check autonomy level - if fully autonomous, the darwin-autonomous-agent will handle auto-sending
        const autonomyLevel = automation.autonomy_level || 'supervised';
        console.log(`Claim autonomy level: ${autonomyLevel}`);
        
        // Trigger AI to draft a response (fire and forget)
        fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/process-claim-ai-action`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action: 'draft_email_response',
            claimId: claim.id,
            emailId: insertedEmail.id,
            autonomyLevel: autonomyLevel,
            senderType: senderType, // Pass sender type so response draft knows recipient type
          }),
        }).catch(err => console.error('Failed to trigger AI draft:', err));
      }

      // Add a note if auto_update_notes is enabled
      if (settings?.auto_update_notes) {
        await supabase
          .from('claim_updates')
          .insert({
            claim_id: claim.id,
            content: `📧 Inbound email received from ${senderName} (${senderEmail}): "${subject}"`,
            update_type: 'inbound_email',
          });
      }
    }

    return new Response(
      JSON.stringify({ success: true, claim_id: claim.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error processing inbound email:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
