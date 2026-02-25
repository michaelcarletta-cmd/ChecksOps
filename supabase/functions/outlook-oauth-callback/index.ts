import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    
    // Microsoft redirects here with ?code=...&state=...
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');

    if (error) {
      console.error('OAuth error:', error, errorDescription);
      return redirectWithError(state, errorDescription || error);
    }

    if (!code || !state) {
      return redirectWithError(state, 'Missing authorization code');
    }

    // Parse state to get user info
    let stateData: { userId: string; redirectUrl: string };
    try {
      stateData = JSON.parse(atob(state));
    } catch {
      return redirectWithError(null, 'Invalid state parameter');
    }

    const MS_CLIENT_ID = Deno.env.get('MS_CLIENT_ID')!;
    const MS_CLIENT_SECRET = Deno.env.get('MS_CLIENT_SECRET')!;
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const redirectUri = `${SUPABASE_URL}/functions/v1/outlook-oauth-callback`;

    // Exchange code for tokens
    const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: MS_CLIENT_ID,
        client_secret: MS_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        scope: 'https://graph.microsoft.com/Mail.Read offline_access User.Read',
      }),
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      console.error('Token exchange failed:', errText);
      return redirectWithError(stateData.redirectUrl, 'Token exchange failed');
    }

    const tokens = await tokenResponse.json();

    // Get user profile from Microsoft Graph
    const profileResponse = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    let emailAddress = '';
    if (profileResponse.ok) {
      const profile = await profileResponse.json();
      emailAddress = profile.mail || profile.userPrincipalName || '';
    }

    // Store connection in database
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    const { error: dbError } = await supabase
      .from('email_connections')
      .upsert({
        user_id: stateData.userId,
        email_address: emailAddress,
        provider: 'outlook_oauth',
        imap_host: 'graph.microsoft.com',
        imap_port: 443,
        encrypted_password: JSON.stringify({
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: expiresAt,
        }),
        is_active: true,
        last_sync_error: null,
      }, { onConflict: 'user_id,email_address' });

    if (dbError) {
      console.error('DB error:', dbError);
      return redirectWithError(stateData.redirectUrl, 'Failed to save connection');
    }

    // Redirect back to app with success
    const successUrl = `${stateData.redirectUrl}?outlook_connected=true`;
    return new Response(null, {
      status: 302,
      headers: { Location: successUrl },
    });
  } catch (err: any) {
    console.error('OAuth callback error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

function redirectWithError(redirectUrl: string | null, error: string) {
  const url = redirectUrl || '/settings';
  return new Response(null, {
    status: 302,
    headers: { Location: `${url}?outlook_error=${encodeURIComponent(error)}` },
  });
}
