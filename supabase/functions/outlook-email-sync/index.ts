import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

/** Single helper – every response is HTTP 200 + JSON (or 204 for OPTIONS). */
function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// --------------- Token helpers ---------------

async function refreshTokens(refreshToken: string): Promise<{ access_token: string; refresh_token: string; expires_at: string }> {
  const MS_CLIENT_ID = Deno.env.get('MS_CLIENT_ID');
  const MS_CLIENT_SECRET = Deno.env.get('MS_CLIENT_SECRET');
  if (!MS_CLIENT_ID || !MS_CLIENT_SECRET) {
    throw new Error('Microsoft OAuth is not configured (MS_CLIENT_ID / MS_CLIENT_SECRET). Please reconnect Outlook after the app is configured.');
  }

  const response = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: MS_CLIENT_ID,
      client_secret: MS_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send offline_access User.Read',
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    let userMessage = 'Token refresh failed.';
    try {
      const errJson = JSON.parse(errText);
      const code = errJson?.error;
      const desc = errJson?.error_description ?? errJson?.error?.message;
      if (code === 'invalid_grant' || (desc && /expired|revoked|invalid|invalid_grant/i.test(desc))) {
        userMessage = 'Your Outlook connection expired or was revoked. Please reconnect your account in Settings.';
      } else if (desc && desc.length < 120) userMessage = desc;
    } catch {
      if (errText.length < 200) userMessage = errText;
    }
    throw new Error(userMessage);
  }

  const tokens = await response.json();
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  };
}

async function getAccessToken(connection: any, supabase: any): Promise<string> {
  let tokenData: any;
  try {
    tokenData = JSON.parse(connection.encrypted_password);
  } catch {
    throw new Error('Invalid token data. Please reconnect your Outlook account.');
  }

  const expiresAt = new Date(tokenData.expires_at);
  if (expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
    const newTokens = await refreshTokens(tokenData.refresh_token);
    await supabase
      .from('email_connections')
      .update({ encrypted_password: JSON.stringify(newTokens), last_sync_error: null })
      .eq('id', connection.id);
    return newTokens.access_token;
  }

  return tokenData.access_token;
}

// --------------- Graph API ---------------

async function fetchGraphEmails(accessToken: string, maxPages = 10): Promise<any[]> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const allEmails: any[] = [];

  let url: string | null =
    `https://graph.microsoft.com/v1.0/me/messages?` +
    `$filter=receivedDateTime ge ${thirtyDaysAgo}` +
    `&$select=from,toRecipients,subject,receivedDateTime,body,bodyPreview,internetMessageId,hasAttachments,id` +
    `&$top=250&$orderby=receivedDateTime desc&$count=false`;

  let page = 0;
  while (url && page < maxPages) {
    const response: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      let detail = '';
      try {
        const errBody = await response.json();
        detail = errBody?.error?.message || errBody?.error_description || '';
      } catch {
        detail = await response.text().catch(() => '');
      }
      if (response.status === 401) {
        throw new Error('Your Outlook connection expired or was revoked. Please reconnect your account in Settings.');
      }
      throw new Error(`Graph API error: ${detail || response.status}`);
    }

    const data: any = await response.json();
    const emails = (data.value || []).map((msg: any) => {
      let fullBody = '';
      if (msg.body?.content) {
        if (msg.body.contentType === 'text') {
          fullBody = msg.body.content;
        } else {
          fullBody = msg.body.content
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n\n')
            .replace(/<\/div>/gi, '\n')
            .replace(/<\/li>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        }
      }
      return {
        graph_id: msg.id,
        from: msg.from?.emailAddress?.address || 'Unknown',
        from_name: msg.from?.emailAddress?.name || '',
        to: msg.toRecipients?.[0]?.emailAddress?.address || 'Unknown',
        to_name: msg.toRecipients?.[0]?.emailAddress?.name || '',
        subject: msg.subject || '(No Subject)',
        date: msg.receivedDateTime,
        full_body: fullBody || msg.bodyPreview || '',
        body_preview: msg.bodyPreview || '',
        message_id: msg.internetMessageId || '',
        has_attachments: msg.hasAttachments || false,
      };
    });

    allEmails.push(...emails);
    url = data['@odata.nextLink'] || null;
    page++;
  }

  console.log(`Fetched ${allEmails.length} emails across ${page} page(s)`);
  return allEmails;
}

// --------------- Attachment helpers ---------------

const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB

async function fetchAndSaveAttachments(
  accessToken: string,
  graphMessageId: string,
  claimId: string,
  emailId: string,
  supabase: any
): Promise<number> {
  let saved = 0;
  try {
    const url = `https://graph.microsoft.com/v1.0/me/messages/${graphMessageId}/attachments?$select=id,name,contentType,size,contentBytes,isInline`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      console.error(`Failed to fetch attachments for message ${graphMessageId}: ${response.status}`);
      return 0;
    }

    const data = await response.json();
    const attachments = data.value || [];

    for (const att of attachments) {
      // Skip inline images (embedded in body) and items without content
      if (att.isInline || !att.contentBytes || att['@odata.type'] === '#microsoft.graph.itemAttachment') continue;

      const fileName = att.name || 'attachment';
      const contentType = att.contentType || 'application/octet-stream';
      const size = att.size || 0;

      if (size > MAX_ATTACHMENT_SIZE) {
        console.log(`Skipping large attachment ${fileName} (${size} bytes)`);
        continue;
      }

      // Decode base64 content
      let fileBuffer: Uint8Array;
      try {
        const binaryString = atob(att.contentBytes);
        fileBuffer = Uint8Array.from(binaryString, (c: string) => c.charCodeAt(0));
      } catch (decodeErr) {
        console.error(`Failed to decode attachment ${fileName}:`, decodeErr);
        continue;
      }

      const storagePath = `${claimId}/email-attachments/${Date.now()}-${fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;

      // Upload to storage
      const { error: uploadError } = await supabase.storage
        .from('claim-files')
        .upload(storagePath, fileBuffer, { contentType });

      if (uploadError) {
        console.error(`Failed to upload attachment ${fileName}:`, uploadError);
        continue;
      }

      // Create file record
      const { data: fileRecord, error: fileError } = await supabase
        .from('claim_files')
        .insert({
          claim_id: claimId,
          file_name: fileName,
          file_path: storagePath,
          file_size: fileBuffer.length,
          file_type: contentType,
          source: 'email_attachment',
          uploaded_by: null,
          email_id: emailId,
        })
        .select('id')
        .single();

      if (fileError) {
        console.error(`Failed to create file record for ${fileName}:`, fileError);
        continue;
      }

      saved++;
      console.log(`Attachment saved: ${fileName} for claim ${claimId}`);

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
    }
  } catch (err) {
    console.error(`Error fetching attachments for message ${graphMessageId}:`, err);
  }
  return saved;
}


// --------------- Claim matching ---------------

function buildClaimNumberTerms(claimNumber: string | null | undefined): string[] {
  const terms: string[] = [];
  if (claimNumber?.trim()) {
    const normalized = claimNumber.trim().toLowerCase();
    terms.push(normalized);
    const cn = normalized.replace(/[-\s]/g, '');
    if (cn.length >= 6) {
      terms.push(cn);
      terms.push(`${cn.substring(0, 2)}-${cn.substring(2)}`);
      terms.push(`${cn.substring(0, 4)}-${cn.substring(4)}`);
      if (cn.length >= 8) terms.push(`${cn.substring(0, 2)}-${cn.substring(2, 6)}-${cn.substring(6)}`);
    }
  }
  return [...new Set(terms)];
}

function getPolicyholderLastName(name: string | null | undefined): string | null {
  if (!name || !name.trim()) return null;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1];
  return last && last.length >= 2 ? last.toLowerCase() : null;
}

/**
 * Strict matching: an email matches a claim ONLY if the subject contains the claim number.
 * Last name alone is NOT sufficient — it caused false positives with common surnames.
 * Last name is used only as a secondary confirmation when claim number is also present,
 * or when the email is from/to a known adjuster/carrier email for that claim.
 */
function emailMatchesClaim(
  email: { subject: string; from: string; to: string },
  claim: { claim_number: string | null; policyholder_name: string | null; insurance_email: string | null },
  adjusterEmails: string[]
): boolean {
  const subjectLower = (email.subject || '').toLowerCase();
  const claimTerms = buildClaimNumberTerms(claim.claim_number);

  // Primary match: claim number appears in the subject — high confidence
  if (claimTerms.length > 0 && claimTerms.some(term => subjectLower.includes(term))) {
    return true;
  }

  // Secondary match: last name in subject AND email is from/to a known adjuster or carrier
  const lastName = getPolicyholderLastName(claim.policyholder_name);
  if (lastName && subjectLower.includes(lastName)) {
    const fromLower = (email.from || '').toLowerCase();
    const toLower = (email.to || '').toLowerCase();
    const knownEmails = [...adjusterEmails];
    if (claim.insurance_email) knownEmails.push(claim.insurance_email.toLowerCase());
    if (knownEmails.some(known => fromLower === known || toLower === known)) {
      return true;
    }
  }

  return false;
}

function buildClaimMatchTerms(claimNumber: string | null | undefined, policyholderName: string | null | undefined): string[] {
  const terms = buildClaimNumberTerms(claimNumber);
  const lastName = getPolicyholderLastName(policyholderName);
  if (lastName) terms.push(lastName);
  return terms;
}

function subjectMatchesClaim(subject: string | null | undefined, matchTerms: string[]): boolean {
  if (!subject || matchTerms.length === 0) return false;
  const subjectLower = subject.toLowerCase();
  return matchTerms.some(term => subjectLower.includes(term));
}

// --------------- Bulk sync ---------------

async function runBulkSync(supabase: any, allConnections: any[]): Promise<{ totalImported: number; claimsSynced: number; errors: string[] }> {
  let totalImported = 0;
  let claimsSynced = 0;
  const errors: string[] = [];

  for (const conn of allConnections) {
    let accessToken: string;
    try {
      accessToken = await getAccessToken(conn, supabase);
    } catch (tokenErr: any) {
      await supabase.from('email_connections').update({ last_sync_error: tokenErr.message }).eq('id', conn.id);
      errors.push(`Connection ${conn.email_address}: ${tokenErr.message}`);
      continue;
    }

    let emails: any[];
    try {
      emails = await fetchGraphEmails(accessToken);
    } catch (graphErr: any) {
      await supabase.from('email_connections').update({ last_sync_error: graphErr.message }).eq('id', conn.id);
      errors.push(`Connection ${conn.email_address}: ${graphErr.message}`);
      continue;
    }

    const { data: openClaims } = await supabase
      .from('claims')
      .select('id, claim_number, policyholder_email, policyholder_name, insurance_company, insurance_email')
      .eq('is_closed', false);

    if (!openClaims || openClaims.length === 0) continue;

    for (const claim of openClaims) {
      // Fetch adjuster emails for this claim
      const { data: adjusterRows } = await supabase
        .from('claim_adjusters')
        .select('adjuster_email')
        .eq('claim_id', claim.id);
      const adjusterEmails = (adjusterRows || [])
        .map((a: any) => a.adjuster_email?.toLowerCase())
        .filter(Boolean);

      const matchingEmails = emails.filter((email: any) => emailMatchesClaim(email, claim, adjusterEmails));
      if (matchingEmails.length === 0) continue;

      const { data: existingEmails } = await supabase
        .from('emails')
        .select('id, subject, sent_at, body, recipient_type')
        .eq('claim_id', claim.id);

      const existingBodyMap = new Map<string, { id: string; body_length: number }>();
      existingEmails?.forEach((e: any) => {
        const key = `${e.subject}|${new Date(e.sent_at).toISOString().substring(0, 16)}`;
        existingBodyMap.set(key, { id: e.id, body_length: (e.body || '').length });
      });

      let claimImported = 0;
      for (const email of matchingEmails) {
        let sentAt: string;
        try { sentAt = new Date(email.date).toISOString(); } catch { sentAt = new Date().toISOString(); }

        const key = `${email.subject}|${sentAt.substring(0, 16)}`;
        const existing = existingBodyMap.get(key);
        
        if (existing) {
          // Update truncated inbound emails with fuller outlook body
          if (existing.body_length < 500 && email.full_body.length > existing.body_length) {
            await supabase.from('emails').update({ body: email.full_body }).eq('id', existing.id);
          }
          // Backfill attachments for existing emails that have them but no files saved yet
          if (email.has_attachments && email.graph_id && existing.id) {
            const { count } = await supabase
              .from('claim_files')
              .select('id', { count: 'exact', head: true })
              .eq('claim_id', claim.id)
              .eq('email_id', existing.id)
              .eq('source', 'email_attachment');
            if (!count || count === 0) {
              await fetchAndSaveAttachments(accessToken, email.graph_id, claim.id, existing.id, supabase);
            }
          }
          continue;
        }

        const isInbound = email.to.toLowerCase() === conn.email_address.toLowerCase() ||
                          email.from.toLowerCase() !== conn.email_address.toLowerCase();

        const { data: insertedEmail, error: insertError } = await supabase.from('emails').insert({
          claim_id: claim.id,
          subject: email.subject,
          body: email.full_body,
          recipient_email: isInbound ? email.from : email.to,
          recipient_name: isInbound ? email.from_name : email.to_name,
          recipient_type: 'outlook_sync',
          sent_at: sentAt,
        }).select('id').single();

        if (!insertError) {
          claimImported++;
          existingBodyMap.set(key, { id: insertedEmail?.id || '', body_length: email.full_body.length });

          // Download attachments if present
          if (email.has_attachments && email.graph_id && insertedEmail?.id) {
            await fetchAndSaveAttachments(accessToken, email.graph_id, claim.id, insertedEmail.id, supabase);
          }
        }
      }

      if (claimImported > 0) {
        totalImported += claimImported;
        claimsSynced++;
      }
    }

    await supabase.from('email_connections').update({ last_sync_at: new Date().toISOString(), last_sync_error: null }).eq('id', conn.id);
  }

  return { totalImported, claimsSynced, errors };
}



// --------------- Main handler ---------------

async function handleOutlookSync(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  let body: { action?: string; claim_id?: string; connection_id?: string } = {};
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error: 'Invalid or missing JSON body' });
  }
  const { action, claim_id, connection_id } = body;

  // ---------- Auth ----------
  let user: any = null;
  if (action === 'sync_all_claims' || action === 'cleanup_wrong_emails' || action === 'cleanup_and_resync') {
    const cronSecret = req.headers.get('x-cron-secret');
    const expectedSecret = Deno.env.get('CRON_SECRET');
    const authHeader = req.headers.get('Authorization');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const isCronCall = (cronSecret && cronSecret === expectedSecret) ||
                       (authHeader && authHeader === `Bearer ${anonKey}`);
    if (!isCronCall) {
      if (authHeader) {
        const token = authHeader.replace('Bearer ', '');
        const { data: { user: authUser } } = await supabase.auth.getUser(token);
        if (!authUser) return json({ success: false, error: 'Not authenticated' });
        user = authUser;
      } else {
        return json({ success: false, error: 'Not authorized' });
      }
    }
  } else {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ success: false, error: 'Not authenticated' });
    const token = authHeader.replace('Bearer ', '');
    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authUser) return json({ success: false, error: 'Not authenticated' });
    user = authUser;
  }

  // ---------- get_auth_url ----------
  if (action === 'get_auth_url') {
    const MS_CLIENT_ID = Deno.env.get('MS_CLIENT_ID');
    if (!MS_CLIENT_ID) return json({ success: false, error: 'Microsoft OAuth not configured' });

    const redirectUri = `${supabaseUrl}/functions/v1/outlook-oauth-callback`;
    const origin = req.headers.get('origin') || req.headers.get('referer') || '';
    const state = btoa(JSON.stringify({
      userId: user.id,
      redirectUrl: origin.replace(/\/$/, '') + '/settings',
    }));

    const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?` +
      `client_id=${MS_CLIENT_ID}` +
      `&response_type=code` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent('https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send offline_access User.Read')}` +
      `&state=${state}` +
      `&response_mode=query` +
      `&prompt=select_account`;

    return json({ success: true, authUrl });
  }

  // ---------- sync_emails ----------
  if (action === 'sync_emails') {
    if (!claim_id) return json({ success: false, error: 'claim_id is required' });

    let query = supabase
      .from('email_connections')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_active', true);

    if (connection_id) query = query.eq('id', connection_id);

    const { data: connection, error: connError } = await query.limit(1).maybeSingle();
    if (connError) return json({ success: false, error: connError.message });
    if (!connection) return json({ success: false, error: 'No active email connection found. Please connect your Outlook account in Settings.' });

    const { data: claim } = await supabase
      .from('claims')
      .select('claim_number, policyholder_email, policyholder_name, insurance_company, insurance_email')
      .eq('id', claim_id)
      .single();

    if (!claim) return json({ success: false, error: 'Claim not found' });

    let accessToken: string;
    try {
      accessToken = await getAccessToken(connection, supabase);
    } catch (tokenErr: any) {
      await supabase.from('email_connections').update({ last_sync_error: tokenErr.message }).eq('id', connection.id);
      return json({ success: false, error: `Authentication failed: ${tokenErr.message}. Please reconnect your Outlook account.` });
    }

    let emails: any[];
    try {
      emails = await fetchGraphEmails(accessToken);
    } catch (graphErr: any) {
      await supabase.from('email_connections').update({ last_sync_error: graphErr.message }).eq('id', connection.id);
      return json({ success: false, error: `Email fetch failed: ${graphErr.message}` });
    }

    // Fetch adjuster emails for this claim
    const { data: adjusterRows } = await supabase
      .from('claim_adjusters')
      .select('adjuster_email')
      .eq('claim_id', claim_id);
    const adjusterEmails = (adjusterRows || [])
      .map((a: any) => a.adjuster_email?.toLowerCase())
      .filter(Boolean);

    const matchingEmails = emails.filter(email => emailMatchesClaim(email, claim, adjusterEmails));

    const { data: existingEmails } = await supabase
      .from('emails')
      .select('id, subject, sent_at, body, recipient_type')
      .eq('claim_id', claim_id);

    // Build a map of existing emails keyed by subject|sentAt for dedup + truncation detection
    const existingBodyMap = new Map<string, { id: string; body_length: number; recipient_type: string }>();
    existingEmails?.forEach((e: any) => {
      const key = `${e.subject}|${new Date(e.sent_at).toISOString().substring(0, 16)}`;
      existingBodyMap.set(key, { id: e.id, body_length: (e.body || '').length, recipient_type: e.recipient_type || '' });
    });

    let importedCount = 0;
    let updatedCount = 0;
    let attachmentCount = 0;
    let firstInsertError: string | null = null;

    for (const email of matchingEmails) {
      let sentAt: string;
      try { sentAt = new Date(email.date).toISOString(); } catch { sentAt = new Date().toISOString(); }

      const key = `${email.subject}|${sentAt.substring(0, 16)}`;
      const existing = existingBodyMap.get(key);
      
      if (existing) {
        if (existing.body_length < 500 && email.full_body.length > existing.body_length) {
          await supabase.from('emails').update({ body: email.full_body }).eq('id', existing.id);
          updatedCount++;
        }
        continue;
      }

      const isInbound = email.to.toLowerCase() === connection.email_address.toLowerCase() ||
                        email.from.toLowerCase() !== connection.email_address.toLowerCase();

      const { data: insertedEmail, error: insertError } = await supabase.from('emails').insert({
        claim_id,
        subject: email.subject,
        body: email.full_body,
        recipient_email: isInbound ? email.from : email.to,
        recipient_name: isInbound ? email.from_name : email.to_name,
        recipient_type: 'outlook_sync',
        sent_at: sentAt,
      }).select('id').single();

      if (insertError) {
        if (!firstInsertError) firstInsertError = insertError.message;
      } else {
        importedCount++;
        existingBodyMap.set(key, { id: insertedEmail?.id || '', body_length: email.full_body.length, recipient_type: 'outlook_sync' });

        // Download attachments if present
        if (email.has_attachments && email.graph_id && insertedEmail?.id) {
          const saved = await fetchAndSaveAttachments(accessToken, email.graph_id, claim_id, insertedEmail.id, supabase);
          attachmentCount += saved;
        }
      }
    }

    // Update last sync
    await supabase
      .from('email_connections')
      .update({
        last_sync_at: new Date().toISOString(),
        last_sync_error: firstInsertError || null,
      })
      .eq('id', connection.id);

    const result: Record<string, unknown> = {
      success: true,
      total_fetched: emails.length,
      matching: matchingEmails.length,
      imported: importedCount,
      updated_truncated: updatedCount,
      attachments_saved: attachmentCount,
    };
    if (firstInsertError) {
      result.warning = `Some emails could not be saved: ${firstInsertError}`;
    }

    return json(result);
  }

  // ---------- delete_connection ----------
  if (action === 'delete_connection') {
    const { error } = await supabase
      .from('email_connections')
      .delete()
      .eq('id', connection_id)
      .eq('user_id', user.id);

    if (error) return json({ success: false, error: error.message });
    return json({ success: true });
  }

  // ---------- cleanup_wrong_emails ----------
  if (action === 'cleanup_wrong_emails') {
    const { data: outlookEmails, error: listErr } = await supabase
      .from('emails')
      .select('id, claim_id, subject')
      .eq('recipient_type', 'outlook_sync');

    if (listErr) return json({ success: false, error: listErr.message });

    let deleted = 0;
    for (const row of outlookEmails || []) {
      const { data: claim } = await supabase
        .from('claims')
        .select('claim_number, policyholder_name')
        .eq('id', row.claim_id)
        .single();

      const matchTerms = buildClaimMatchTerms(claim?.claim_number, claim?.policyholder_name);
      if (!subjectMatchesClaim(row.subject, matchTerms)) {
        const { error: delErr } = await supabase.from('emails').delete().eq('id', row.id);
        if (!delErr) deleted++;
      }
    }

    console.log(`Cleanup: removed ${deleted} wrongly-attached outlook_sync emails`);
    return json({ success: true, deleted });
  }

  // ---------- cleanup_and_resync ----------
  if (action === 'cleanup_and_resync') {
    // Delete ALL outlook_sync emails so they get re-imported with full body content
    let deleted = 0;
    let deleteOffset = 0;
    const deleteBatch = 500;
    let hasMoreToDelete = true;
    while (hasMoreToDelete) {
      const { data: batch, error: listErr } = await supabase
        .from('emails')
        .select('id')
        .eq('recipient_type', 'outlook_sync')
        .range(0, deleteBatch - 1);

      if (listErr || !batch || batch.length === 0) {
        hasMoreToDelete = false;
        break;
      }

      const ids = batch.map((r: any) => r.id);
      const { error: delErr } = await supabase.from('emails').delete().in('id', ids);
      if (delErr) {
        console.warn('Batch delete error:', delErr.message);
        hasMoreToDelete = false;
      } else {
        deleted += ids.length;
        if (batch.length < deleteBatch) hasMoreToDelete = false;
      }
    }

    console.log(`Cleanup: removed ${deleted} outlook_sync emails for full re-import`);

    const { data: allConnections, error: connErr } = await supabase
      .from('email_connections')
      .select('*')
      .eq('is_active', true);

    if (connErr || !allConnections || allConnections.length === 0) {
      return json({
        success: true,
        deleted,
        message: 'No active connections; cleanup done, no resync.',
        total_imported: 0,
        claims_synced: 0,
      });
    }

    const { totalImported, claimsSynced, errors } = await runBulkSync(supabase, allConnections);
    console.log(`Cleanup and resync: removed ${deleted} wrong emails; imported ${totalImported} across ${claimsSynced} claims`);
    return json({
      success: true,
      deleted,
      total_imported: totalImported,
      claims_synced: claimsSynced,
      errors: errors.length > 0 ? errors : undefined,
    });
  }

  // ---------- sync_all_claims ----------
  if (action === 'sync_all_claims') {
    const { data: allConnections, error: connErr } = await supabase
      .from('email_connections')
      .select('*')
      .eq('is_active', true);

    if (connErr || !allConnections || allConnections.length === 0) {
      return json({ success: true, message: 'No active connections', synced: 0 });
    }

    const { totalImported, claimsSynced, errors } = await runBulkSync(supabase, allConnections);
    console.log(`Bulk sync complete: ${totalImported} emails imported across ${claimsSynced} claims`);
    return json({
      success: true,
      total_imported: totalImported,
      claims_synced: claimsSynced,
      errors: errors.length > 0 ? errors : undefined,
    });
  }

  return json({ success: false, error: `Unknown action: ${action}` });
}

// --------------- Entry point ---------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    return await handleOutlookSync(req);
  } catch (outer: any) {
    const msg = outer?.message ?? String(outer);
    console.error('Outlook sync outer error:', msg, outer);
    return json({ success: false, error: msg });
  }
});
