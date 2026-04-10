const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const apiKey = Deno.env.get('JOBNIMBUS_API_KEY');
  if (!apiKey) {
    return new Response(JSON.stringify({ success: false, error: 'JOBNIMBUS_API_KEY not configured' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const response = await fetch('https://app.jobnimbus.com/api1/jobs?count=1', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    const status = response.status;
    const body = await response.text();

    if (response.ok) {
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'JobNimbus API key is valid!',
        status,
        sample: body.substring(0, 200),
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } else {
      return new Response(JSON.stringify({ 
        success: false, 
        message: 'JobNimbus API key is invalid or expired',
        status,
        error: body.substring(0, 200),
      }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
