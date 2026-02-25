import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
    const TELNYX_API_KEY = Deno.env.get('TELNYX_API_KEY')!;
    const TELNYX_PHONE_NUMBER = Deno.env.get('TELNYX_PHONE_NUMBER')!;
    const TELNYX_MESSAGING_PROFILE_ID = Deno.env.get('TELNYX_MESSAGING_PROFILE_ID');

    // Auth
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const token = authHeader.replace('Bearer ', '');
    const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { action, phoneNumber, code } = await req.json();
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // ── Send verification code ──
    if (action === 'send_code') {
      if (!phoneNumber) {
        return new Response(JSON.stringify({ error: 'Phone number required' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Normalize to E.164
      const digits = phoneNumber.replace(/\D/g, '');
      const normalized = digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith('1') ? `+${digits}` : phoneNumber.startsWith('+') ? phoneNumber : `+${digits}`;

      // Generate 6-digit code
      const verificationCode = String(Math.floor(100000 + Math.random() * 900000));
      const expiresAt = new Date(Date.now() + 10 * 60000).toISOString(); // 10 min

      // Upsert phone link
      await supabase.from('user_phone_links').upsert({
        user_id: user.id,
        phone_number: normalized,
        verification_code: verificationCode,
        verification_expires_at: expiresAt,
        is_verified: false,
      }, { onConflict: 'phone_number' });

      // Send SMS
      const smsBody: Record<string, string> = {
        from: TELNYX_PHONE_NUMBER,
        to: normalized,
        text: `Your Darwin verification code is: ${verificationCode}. It expires in 10 minutes.`,
      };
      if (TELNYX_MESSAGING_PROFILE_ID) smsBody.messaging_profile_id = TELNYX_MESSAGING_PROFILE_ID;

      const telnyxResp = await fetch('https://api.telnyx.com/v2/messages', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${TELNYX_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(smsBody),
      });

      if (!telnyxResp.ok) {
        const err = await telnyxResp.json();
        console.error('Telnyx error:', err);
        return new Response(JSON.stringify({ error: 'Failed to send verification SMS' }), {
          status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ success: true, message: 'Verification code sent' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Verify code ──
    if (action === 'verify_code') {
      if (!code) {
        return new Response(JSON.stringify({ error: 'Code required' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { data: link } = await supabase
        .from('user_phone_links')
        .select('*')
        .eq('user_id', user.id)
        .eq('is_verified', false)
        .single();

      if (!link) {
        return new Response(JSON.stringify({ error: 'No pending verification found' }), {
          status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (link.verification_code !== code) {
        return new Response(JSON.stringify({ error: 'Invalid code' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (new Date(link.verification_expires_at) < new Date()) {
        return new Response(JSON.stringify({ error: 'Code expired. Request a new one.' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      await supabase.from('user_phone_links')
        .update({ is_verified: true, verified_at: new Date().toISOString(), verification_code: null })
        .eq('id', link.id);

      return new Response(JSON.stringify({ success: true, message: 'Phone verified!' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Get status ──
    if (action === 'get_status') {
      const { data: link } = await supabase
        .from('user_phone_links')
        .select('phone_number, is_verified, verified_at')
        .eq('user_id', user.id)
        .single();

      return new Response(JSON.stringify({ success: true, link: link || null }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Remove link ──
    if (action === 'remove') {
      await supabase.from('user_phone_links').delete().eq('user_id', user.id);
      return new Response(JSON.stringify({ success: true }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Invalid action' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Phone verification error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
