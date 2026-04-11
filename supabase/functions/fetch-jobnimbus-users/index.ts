const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get('JOBNIMBUS_API_KEY');
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'No JN API key' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Try multiple endpoints to find team/users
    const endpoints = [
      'https://app.jobnimbus.com/api1/users',
      'https://app.jobnimbus.com/api1/team',
      'https://app.jobnimbus.com/api1/members',
      'https://app.jobnimbus.com/api1/settings/users',
    ];

    const results: Record<string, any> = {};

    for (const url of endpoints) {
      try {
        const resp = await fetch(url, {
          headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        const text = await resp.text();
        results[url] = { status: resp.status, body: text.substring(0, 3000) };
      } catch (e: any) {
        results[url] = { error: e.message };
      }
    }

    return new Response(JSON.stringify(results), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
