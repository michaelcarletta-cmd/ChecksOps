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

    const response = await fetch('https://app.jobnimbus.com/api1/teams', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      const text = await response.text();
      console.log('Teams endpoint failed, trying contacts with record_type_name=User');
      
      // Try the users/team members endpoint
      const usersResp = await fetch('https://app.jobnimbus.com/api1/contacts?record_type_name=User&must%5B%5D=record_type_name%3AUser', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      
      const usersData = await usersResp.text();
      console.log('Users response:', usersResp.status, usersData.substring(0, 2000));
      
      return new Response(JSON.stringify({ 
        teams_error: `${response.status}: ${text.substring(0, 500)}`,
        users_status: usersResp.status,
        users_data: JSON.parse(usersData)
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const data = await response.json();
    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
