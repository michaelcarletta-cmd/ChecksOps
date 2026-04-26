import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function refreshTokens(refreshToken: string): Promise<{ access_token: string; refresh_token: string; expires_at: string }> {
  const MS_CLIENT_ID = Deno.env.get('MS_CLIENT_ID');
  const MS_CLIENT_SECRET = Deno.env.get('MS_CLIENT_SECRET');
  if (!MS_CLIENT_ID || !MS_CLIENT_SECRET) {
    throw new Error('Microsoft OAuth is not configured. Please reconnect Outlook in Settings.');
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
    let msg = 'Token refresh failed.';
    try {
      const errJson = JSON.parse(errText);
      const code = errJson?.error;
      const desc = errJson?.error_description ?? errJson?.error?.message;
      if (code === 'invalid_grant' || (desc && /expired|revoked|invalid/i.test(desc))) {
        msg = 'Your Outlook connection expired. Please reconnect in Settings.';
      } else if (desc && desc.length < 120) msg = desc;
    } catch { /* */ }
    throw new Error(msg);
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

interface OutlookAttachment {
  "@odata.type": string;
  name: string;
  contentType: string;
  contentBytes: string; // base64
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Auth
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ success: false, error: 'Not authenticated' }, 401);

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return json({ success: false, error: 'Not authenticated' }, 401);

    const body = await req.json();
    const { recipients, subject, htmlBody, claimId, attachments, claimEmailCc } = body;

    if (!recipients?.length || !subject || !htmlBody) {
      return json({ success: false, error: 'Missing required fields: recipients, subject, htmlBody' }, 400);
    }

    // Get user's active Outlook connections (newest first)
    const { data: connections, error: connError } = await supabase
      .from('email_connections')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .order('updated_at', { ascending: false })
      .limit(5);

    if (connError || !connections?.length) {
      return json({ success: false, error: 'No active Outlook connection found. Please connect your Outlook account in Settings.' }, 400);
    }

    let connection: any = null;
    let accessToken = '';
    let lastTokenError: string | null = null;

    for (const conn of connections) {
      try {
        accessToken = await getAccessToken(conn, supabase);
        connection = conn;

        if (conn.last_sync_error) {
          await supabase
            .from('email_connections')
            .update({ last_sync_error: null })
            .eq('id', conn.id);
        }
        break;
      } catch (tokenErr: any) {
        const message = tokenErr?.message || 'Outlook authentication failed. Please reconnect your account.';
        lastTokenError = message;
        await supabase
          .from('email_connections')
          .update({ last_sync_error: message })
          .eq('id', conn.id);
      }
    }

    if (!connection || !accessToken) {
      return json({
        success: false,
        error: lastTokenError || 'All active Outlook connections are expired. Please reconnect your Outlook account in Settings.',
      }, 400);
    }

    // Keep only the working connection active to avoid stale-token collisions
    if (connections.length > 1) {
      await supabase
        .from('email_connections')
        .update({ is_active: false })
        .eq('user_id', user.id)
        .eq('is_active', true)
        .neq('id', connection.id);
    }

    // Build Graph API message
    const toRecipients = recipients.map((r: any) => ({
      emailAddress: { address: r.email, name: r.name || r.email },
    }));

    const ccRecipients: any[] = [];
    if (claimEmailCc) {
      ccRecipients.push({ emailAddress: { address: claimEmailCc } });
    }

    // Fetch user's email signature
    const { data: profile } = await supabase
      .from('profiles')
      .select('email_signature')
      .eq('id', user.id)
      .single();
    const signature = (profile as any)?.email_signature || '';

    const fullHtml = signature
      ? `${htmlBody}<br/><br/><div style="border-top:1px solid #ddd;padding-top:10px;margin-top:20px;">${signature}</div>`
      : htmlBody;

    const message: any = {
      subject,
      body: {
        contentType: 'HTML',
        content: fullHtml,
      },
      toRecipients,
    };

    if (ccRecipients.length > 0) {
      message.ccRecipients = ccRecipients;
    }

    // Process attachments
    const graphAttachments: OutlookAttachment[] = [];
    const attachmentErrors: string[] = [];

    if (attachments?.length) {
      const MAX_SIZE = 10 * 1024 * 1024;
      for (const att of attachments) {
        try {
          const { data: fileData, error: dlError } = await supabase.storage
            .from('claim-files')
            .download(att.filePath);
          if (dlError || !fileData) {
            attachmentErrors.push(`Failed to download ${att.fileName}`);
            continue;
          }
          if (fileData.size > MAX_SIZE) {
            attachmentErrors.push(`${att.fileName} too large (max 10MB)`);
            continue;
          }
          const arrayBuffer = await fileData.arrayBuffer();
          const uint8 = new Uint8Array(arrayBuffer);
          const chunkSize = 32768;
          let b64 = '';
          for (let i = 0; i < uint8.length; i += chunkSize) {
            const chunk = uint8.subarray(i, i + chunkSize);
            b64 += String.fromCharCode.apply(null, chunk as unknown as number[]);
          }
          b64 = btoa(b64);

          graphAttachments.push({
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: att.fileName,
            contentType: att.fileType || 'application/octet-stream',
            contentBytes: b64,
          });
        } catch (err: any) {
          attachmentErrors.push(`Error with ${att.fileName}: ${err.message}`);
        }
      }
    }

    if (graphAttachments.length > 0) {
      message.attachments = graphAttachments;
    }

    // Send via Microsoft Graph
    const graphResponse = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message, saveToSentItems: true }),
    });

    if (!graphResponse.ok) {
      let detail = '';
      try {
        const errBody = await graphResponse.json();
        detail = errBody?.error?.message || '';
      } catch { /* */ }
      
      if (graphResponse.status === 403 || detail.includes('Mail.Send')) {
        return json({
          success: false,
          error: 'Your Outlook connection does not have permission to send emails. Please disconnect and reconnect Outlook in Settings to grant send permission.',
        }, 403);
      }
      
      throw new Error(`Graph API error (${graphResponse.status}): ${detail || 'Unknown error'}`);
    }

    // Log to database
    if (claimId) {
      for (const r of recipients) {
        await supabase.from('emails').insert({
          claim_id: claimId,
          sent_by: user.id,
          recipient_email: r.email,
          recipient_name: r.name || r.email,
          recipient_type: r.type || 'manual',
          subject,
          body: htmlBody,
          send_status: 'sent',
        });
      }
    }

    return json({
      success: true,
      recipientCount: recipients.length,
      attachmentCount: graphAttachments.length,
      attachmentsRequested: attachments?.length || 0,
      attachmentErrors: attachmentErrors.length > 0 ? attachmentErrors : undefined,
      sentVia: 'outlook',
    });
  } catch (err: any) {
    console.error('Send Outlook email error:', err);
    return json({ success: false, error: err.message || 'Unknown error' }, 500);
  }
});
