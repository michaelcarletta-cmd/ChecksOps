import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// Refresh Microsoft OAuth tokens
async function refreshTokens(refreshToken: string): Promise<{ access_token: string; refresh_token: string; expires_at: string }> {
  const MS_CLIENT_ID = Deno.env.get('MS_CLIENT_ID');
  const MS_CLIENT_SECRET = Deno.env.get('MS_CLIENT_SECRET');
<<<<<<< HEAD
  if (!MS_CLIENT_ID || !MS_CLIENT_SECRET) {
    throw new Error('Microsoft OAuth is not configured (MS_CLIENT_ID / MS_CLIENT_SECRET). Please reconnect Outlook after the app is configured.');
=======
<<<<<<< HEAD

  if (!MS_CLIENT_ID || !MS_CLIENT_SECRET) {
    throw new Error('Microsoft OAuth is not configured (MS_CLIENT_ID / MS_CLIENT_SECRET missing).');
=======
  if (!MS_CLIENT_ID || !MS_CLIENT_SECRET) {
    throw new Error('Microsoft OAuth is not configured (MS_CLIENT_ID / MS_CLIENT_SECRET). Please reconnect Outlook after the app is configured.');
>>>>>>> 8c7ec8a (Outlook email sync: claim/subject matching, cleanup, 200 responses)
>>>>>>> 13c0d96 (Darwin Claim Intelligence: DB schema, financials, command engine, pipelines, timeline, UI command bar)
  }

  const response = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: MS_CLIENT_ID,
      client_secret: MS_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: 'https://graph.microsoft.com/Mail.Read offline_access User.Read',
    }),
  });

  if (!response.ok) {

    const errText = await response.text();
    let userMessage = 'Token refresh failed.';

    let detail = '';
(Darwin Claim Intelligence: DB schema, financials, command engine, pipelines, timeline, UI command bar)
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

    const lower = detail.toLowerCase();
    if (lower.includes('expired') || lower.includes('revoked') || lower.includes('invalid_grant') || response.status === 401) {
      throw new Error('Your Outlook connection expired or was revoked. Please reconnect your account in Settings.');
    }
    throw new Error(`Token refresh failed: ${detail || response.status}`);

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
(Outlook email sync: claim/subject matching, cleanup, 200 responses)
(Darwin Claim Intelligence: DB schema, financials, command engine, pipelines, timeline, UI command bar)
  }

  const tokens = await response.json();
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  };
}

// Get a valid access token, refreshing if needed
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
      .update({
        encrypted_password: JSON.stringify(newTokens),
        last_sync_error: null,
      })
      .eq('id', connection.id);
    return newTokens.access_token;
  }

  return tokenData.access_token;
}

// Fetch emails from Microsoft Graph API
async function fetchGraphEmails(accessToken: string): Promise<any[]> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages?` +
    `$filter=receivedDateTime ge ${thirtyDaysAgo}` +

    `&$select=from,toRecipients,subject,receivedDateTime,bodyPreview,internetMessageId` +
    `&$top=100&$orderby=receivedDateTime desc`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

    `&$select=from,toRecipients,subject,receivedDateTime,body,bodyPreview,internetMessageId` +
    `&$top=250&$orderby=receivedDateTime desc&$count=false`;
(Darwin Claim Intelligence: DB schema, financials, command engine, pipelines, timeline, UI command bar)

  if (!response.ok) {
    const errText = await response.text();
    let userMessage = `Graph API error (${response.status}).`;
    try {
      const errJson = JSON.parse(errText);
      const msg = errJson?.error?.message ?? errJson?.message;
      if (msg && msg.length < 180) userMessage = msg;
      else if (response.status === 401) userMessage = 'Outlook access expired or denied. Please reconnect your account in Settings.';
    } catch {
      if (errText.length < 150) userMessage = errText;
    }

    throw new Error(userMessage);


    const data = await response.json();
    const emails = (data.value || []).map((msg: any) => {
      // Extract full body text – prefer plain text, strip HTML tags if HTML
      let fullBody = '';
      if (msg.body?.content) {
        if (msg.body.contentType === 'text') {
          fullBody = msg.body.content;
        } else {
          // Strip HTML tags to get plain text
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
        from: msg.from?.emailAddress?.address || 'Unknown',
        from_name: msg.from?.emailAddress?.name || '',
        to: msg.toRecipients?.[0]?.emailAddress?.address || 'Unknown',
        to_name: msg.toRecipients?.[0]?.emailAddress?.name || '',
        subject: msg.subject || '(No Subject)',
        date: msg.receivedDateTime,
        full_body: fullBody || msg.bodyPreview || '',
        body_preview: msg.bodyPreview || '',
        message_id: msg.internetMessageId || '',
      };
    });

    allEmails.push(...emails);
    url = data['@odata.nextLink'] || null;
    page++;

    `&$select=from,toRecipients,subject,receivedDateTime,bodyPreview,internetMessageId` +
    `&$top=100&$orderby=receivedDateTime desc`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!response.ok) {
    const errText = await response.text();
    let userMessage = `Graph API error (${response.status}).`;
    try {
      const errJson = JSON.parse(errText);
      const msg = errJson?.error?.message ?? errJson?.message;
      if (msg && msg.length < 180) userMessage = msg;
      else if (response.status === 401) userMessage = 'Outlook access expired or denied. Please reconnect your account in Settings.';
    } catch {
      if (errText.length < 150) userMessage = errText;
    }
    throw new Error(userMessage);
  

  const data = await response.json();
  return (data.value || []).map((msg: any) => ({
    from: msg.from?.emailAddress?.address || 'Unknown',
    from_name: msg.from?.emailAddress?.name || '',
    to: msg.toRecipients?.[0]?.emailAddress?.address || 'Unknown',
    to_name: msg.toRecipients?.[0]?.emailAddress?.name || '',
    subject: msg.subject || '(No Subject)',
    date: msg.receivedDateTime,
    body_preview: msg.bodyPreview || '',
    message_id: msg.internetMessageId || '',
  }));
}


// Build match terms from claim number (and variations) + policyholder last name. Subject must contain at least one.
function buildClaimMatchTerms(claimNumber: string | null | undefined, policyholderName: string | null | undefined): string[] {

// --------------- Claim matching ---------------

function buildClaimNumberTerms(claimNumber: string | null | undefined): string[] {

// Build match terms from claim number (and variations) + policyholder last name. Subject must contain at least one.
function buildClaimMatchTerms(claimNumber: string | null | undefined, policyholderName: string | null | undefined): string[] {
(Outlook email sync: claim/subject matching, cleanup, 200 responses)
(Darwin Claim Intelligence: DB schema, financials, command engine, pipelines, timeline, UI command bar)
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
  const lastName = getPolicyholderLastName(policyholderName);
  if (lastName) terms.push(lastName);
  return [...new Set(terms)];
}

function getPolicyholderLastName(name: string | null | undefined): string | null {
  if (!name || !name.trim()) return null;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1];
  return last && last.length >= 2 ? last.toLowerCase() : null;
}

// Email is related to this claim only if SUBJECT contains claim number or policyholder last name
function subjectMatchesClaim(subject: string, matchTerms: string[]): boolean {
  if (matchTerms.length === 0) return false;
  const subjectLower = (subject || '').toLowerCase();
  return matchTerms.some(term => subjectLower.includes(term));
}

// Run full Outlook sync for all connections (used by sync_all_claims and cleanup_and_resync)
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
      const matchTerms = buildClaimMatchTerms(claim.claim_number, claim.policyholder_name);
      const matchingEmails = emails.filter((email: any) => subjectMatchesClaim(email.subject, matchTerms));

      if (matchingEmails.length === 0) continue;

      const { data: existingEmails } = await supabase
        .from('emails')
        .select('subject, sent_at')
        .eq('claim_id', claim.id);

      const existingKeys = new Set(
        existingEmails?.map((e: any) => `${e.subject}|${new Date(e.sent_at).toISOString().substring(0, 16)}`) || []
      );

      let claimImported = 0;
      for (const email of matchingEmails) {
        let sentAt: string;
        try { sentAt = new Date(email.date).toISOString(); } catch { sentAt = new Date().toISOString(); }

        const key = `${email.subject}|${sentAt.substring(0, 16)}`;
        if (existingKeys.has(key)) continue;

        const isInbound = email.to.toLowerCase() === conn.email_address.toLowerCase() ||
                          email.from.toLowerCase() !== conn.email_address.toLowerCase();

        const { error: insertError } = await supabase.from('emails').insert({
          claim_id: claim.id,
          subject: email.subject,
          body: email.body_preview,
          recipient_email: isInbound ? email.from : email.to,
          recipient_name: isInbound ? email.from_name : email.to_name,
          recipient_type: isInbound ? 'inbound' : 'outlook_sync',
          sent_at: sentAt,
        });

        if (!insertError) {
          claimImported++;
          existingKeys.add(key);
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


const json = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

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
      `&scope=${encodeURIComponent('https://graph.microsoft.com/Mail.Read offline_access User.Read')}` +
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
    let firstInsertError: string | null = null;

    for (const email of matchingEmails) {
      let sentAt: string;
      try { sentAt = new Date(email.date).toISOString(); } catch { sentAt = new Date().toISOString(); }

      const key = `${email.subject}|${sentAt.substring(0, 16)}`;
      const existing = existingBodyMap.get(key);
      
      if (existing) {
        // If the existing record is truncated (short body, typically from inbound webhook)
        // and the outlook version has more content, update the body
        if (existing.body_length < 500 && email.full_body.length > existing.body_length) {
          await supabase.from('emails').update({ body: email.full_body }).eq('id', existing.id);
          updatedCount++;
        }
        continue;
      }

      const isInbound = email.to.toLowerCase() === connection.email_address.toLowerCase() ||
                        email.from.toLowerCase() !== connection.email_address.toLowerCase();

      const { error: insertError } = await supabase.from('emails').insert({
        claim_id,
        subject: email.subject,
        body: email.full_body,
        recipient_email: isInbound ? email.from : email.to,
        recipient_name: isInbound ? email.from_name : email.to_name,
        recipient_type: 'outlook_sync',
        sent_at: sentAt,
      });

      if (insertError) {
        if (!firstInsertError) firstInsertError = insertError.message;
      } else {
        importedCount++;
        existingBodyMap.set(key, { id: '', body_length: email.full_body.length, recipient_type: 'outlook_sync' });
      }
    }

    // Update last sync; store firstInsertError if applicable
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

const json = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
(Outlook email sync: claim/subject matching, cleanup, 200 responses)
(Darwin Claim Intelligence: DB schema, financials, command engine, pipelines, timeline, UI command bar)

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let res: Response;
  try {

    return await handleOutlookSync(req);
(Darwin Claim Intelligence: DB schema, financials, command engine, pipelines, timeline, UI command bar)
    res = await handleOutlookSync(req);
  } catch (outer: any) {
    const msg = outer?.message ?? String(outer);
    console.error('Outlook sync outer error:', msg, outer);
    res = json({ success: false, error: msg });
  }
  return res;
});

async function handleOutlookSync(req: Request): Promise<Response> {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseServiceKey) {
      return json({ success: false, error: 'Server configuration missing (SUPABASE_URL / service role key).' });
    }
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    let body: { action?: string; claim_id?: string; connection_id?: string } = {};
    try {
      body = await req.json();
    } catch {
      return json({ success: false, error: 'Invalid or missing JSON body' });
    }
    const { action, claim_id, connection_id } = body;

    // Auth: cron/anon or authenticated user
    let user: any = null;
    if (action === 'sync_all_claims' || action === 'cleanup_wrong_emails' || action === 'cleanup_and_resync') {
      const cronSecret = req.headers.get('x-cron-secret');
      const expectedSecret = Deno.env.get('CRON_SECRET');
      const authHeader = req.headers.get('Authorization');
      const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
      const isCronCall = (cronSecret && cronSecret === expectedSecret) || (authHeader && authHeader === `Bearer ${anonKey}`);
      if (!isCronCall) {
        if (authHeader) {
          const token = authHeader.replace('Bearer ', '');
          const { data: { user: authUser } } = await supabase.auth.getUser(token);
          if (!authUser) throw new Error('Not authenticated');
          user = authUser;
        } else {
          throw new Error('Not authorized');
        }
      }
    } else {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) throw new Error('Not authenticated');
      const token = authHeader.replace('Bearer ', '');
      const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !authUser) throw new Error('Not authenticated');
      user = authUser;
    }

    if (action === 'get_auth_url') {
      const MS_CLIENT_ID = Deno.env.get('MS_CLIENT_ID');
      if (!MS_CLIENT_ID) throw new Error('Microsoft OAuth not configured');
      const redirectUri = `${supabaseUrl}/functions/v1/outlook-oauth-callback`;
      const origin = req.headers.get('origin') || req.headers.get('referer') || '';
      const state = btoa(JSON.stringify({ userId: user.id, redirectUrl: origin.replace(/\/$/, '') + '/settings' }));
      const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?` +
        `client_id=${MS_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&scope=${encodeURIComponent('https://graph.microsoft.com/Mail.Read offline_access User.Read')}&state=${state}&response_mode=query`;
      return json({ authUrl });
    }

    if (action === 'sync_emails') {
      if (!claim_id) throw new Error('claim_id is required');
      let query = supabase.from('email_connections').select('*').eq('user_id', user.id).eq('is_active', true);
      if (connection_id) query = query.eq('id', connection_id);
      const { data: connection, error: connError } = await query.limit(1).maybeSingle();
      if (connError) throw new Error(`Failed to load connection: ${connError.message}`);
      if (!connection) throw new Error('No active email connection found. Please connect your Outlook account in Settings.');

      const { data: claim } = await supabase.from('claims').select('claim_number, policyholder_email, policyholder_name, insurance_company, insurance_email').eq('id', claim_id).single();
      if (!claim) throw new Error('Claim not found');

      let accessToken: string;
      try {
        accessToken = await getAccessToken(connection, supabase);
      } catch (tokenErr: any) {
        await supabase.from('email_connections').update({ last_sync_error: tokenErr.message }).eq('id', connection.id);
        throw new Error(`Authentication failed: ${tokenErr.message}. Please reconnect your Outlook account.`);
      }

      let emails: any[];
      try {
        emails = await fetchGraphEmails(accessToken);
      } catch (graphErr: any) {
        await supabase.from('email_connections').update({ last_sync_error: graphErr.message }).eq('id', connection.id);
        throw new Error(`Email fetch failed: ${graphErr.message}`);
      }

      const matchTerms = buildClaimMatchTerms(claim.claim_number, claim.policyholder_name);
      const matchingEmails = emails.filter(email => subjectMatchesClaim(email.subject, matchTerms));

      const { data: existingEmails } = await supabase.from('emails').select('subject, sent_at').eq('claim_id', claim_id);
      const existingKeys = new Set(existingEmails?.map(e => `${e.subject}|${new Date(e.sent_at).toISOString().substring(0, 16)}`) || []);

      let importedCount = 0;
      let firstInsertError: string | null = null;
      for (const email of matchingEmails) {
        let sentAt: string;
        try { sentAt = new Date(email.date).toISOString(); } catch { sentAt = new Date().toISOString(); }
        const key = `${email.subject}|${sentAt.substring(0, 16)}`;
        if (existingKeys.has(key)) continue;
        const isInbound = (email.to || '').toLowerCase() === (connection.email_address || '').toLowerCase() ||
                          (email.from || '').toLowerCase() !== (connection.email_address || '').toLowerCase();
        const { error: insertError } = await supabase.from('emails').insert({
          claim_id,
          subject: email.subject ?? '(No Subject)',
          body: email.body_preview ?? '',
          recipient_email: isInbound ? email.from : email.to,
          recipient_name: isInbound ? email.from_name : email.to_name,
          recipient_type: isInbound ? 'inbound' : 'outlook_sync',
          sent_at: sentAt,
        });
        if (!insertError) { importedCount++; existingKeys.add(key); } else if (!firstInsertError) firstInsertError = insertError.message;
      }

      await supabase.from('email_connections').update({ last_sync_at: new Date().toISOString(), last_sync_error: firstInsertError }).eq('id', connection.id);
      if (firstInsertError && importedCount === 0) throw new Error(`Could not save emails to this claim: ${firstInsertError}`);
      return json({
        success: true,
        total_fetched: emails.length,
        matching: matchingEmails.length,
        imported: importedCount,
        ...(firstInsertError && importedCount > 0 ? { warning: `Some emails could not be saved: ${firstInsertError}` } : {}),
      });
    }

    if (action === 'delete_connection') {
      const { error } = await supabase.from('email_connections').delete().eq('id', connection_id).eq('user_id', user.id);
      if (error) throw error;
      return json({ success: true });
    }

    if (action === 'cleanup_wrong_emails') {
      const { data: outlookEmails, error: listErr } = await supabase.from('emails').select('id, claim_id, subject').eq('recipient_type', 'outlook_sync');
      if (listErr) return json({ success: false, error: listErr.message });
      let deleted = 0;
      for (const row of outlookEmails || []) {
        const { data: claim } = await supabase.from('claims').select('claim_number, policyholder_name').eq('id', row.claim_id).single();
        const matchTerms = buildClaimMatchTerms(claim?.claim_number, claim?.policyholder_name);
        if (!subjectMatchesClaim(row.subject, matchTerms)) {
          const { error: delErr } = await supabase.from('emails').delete().eq('id', row.id);
          if (!delErr) deleted++;
        }
      }
      return json({ success: true, deleted });
    }

    if (action === 'cleanup_and_resync') {
      try {
        const { data: outlookEmails, error: listErr } = await supabase.from('emails').select('id, claim_id, subject').eq('recipient_type', 'outlook_sync');
        if (listErr) return json({ success: false, error: `Failed to list emails: ${listErr.message}` });
        let deleted = 0;
        for (const row of outlookEmails || []) {
          try {
            const { data: claim } = await supabase.from('claims').select('claim_number, policyholder_name').eq('id', row.claim_id).single();
            const matchTerms = buildClaimMatchTerms(claim?.claim_number, claim?.policyholder_name);
            if (!subjectMatchesClaim(row?.subject ?? '', matchTerms)) {
              const { error: delErr } = await supabase.from('emails').delete().eq('id', row.id);
              if (!delErr) deleted++;
            }
          } catch (e) { console.warn('Cleanup row error:', row?.id, e); }
        }
        const { data: allConnections, error: connErr } = await supabase.from('email_connections').select('*').eq('is_active', true);
        if (connErr || !allConnections || allConnections.length === 0) {
          return json({ success: true, deleted, message: 'No active connections; cleanup done, no resync.', total_imported: 0, claims_synced: 0 });
        }
        const { totalImported, claimsSynced, errors } = await runBulkSync(supabase, allConnections);
        return json({ success: true, deleted, total_imported: totalImported, claims_synced: claimsSynced, errors: errors.length > 0 ? errors : undefined });
      } catch (cleanupErr: any) {
        const msg = cleanupErr?.message ?? String(cleanupErr);
        console.error('cleanup_and_resync error:', msg, cleanupErr);
        return json({ success: false, error: msg });
      }
    }

    if (action === 'sync_all_claims') {
      const { data: allConnections, error: connErr } = await supabase.from('email_connections').select('*').eq('is_active', true);
      if (connErr || !allConnections || allConnections.length === 0) return json({ success: true, message: 'No active connections', synced: 0 });
      const { totalImported, claimsSynced, errors } = await runBulkSync(supabase, allConnections);
      return json({ success: true, total_imported: totalImported, claims_synced: claimsSynced, errors: errors.length > 0 ? errors : undefined });
    }

    return json({ success: false, error: `Unknown action: ${action}` });
(Outlook email sync: claim/subject matching, cleanup, 200 responses)
(Darwin Claim Intelligence: DB schema, financials, command engine, pipelines, timeline, UI command bar)
  } catch (error: any) {
    const message = error?.message || String(error);
    console.error('Outlook sync error:', message, error);
    return json({ success: false, error: message });
  }
}
