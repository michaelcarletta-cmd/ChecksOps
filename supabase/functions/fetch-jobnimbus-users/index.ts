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

    // Fetch recent jobs to extract unique user IDs from owners/created_by/sales_rep
    const resp = await fetch('https://app.jobnimbus.com/api1/jobs?limit=50', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      return new Response(JSON.stringify({ error: `Jobs: ${resp.status}` }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const data = await resp.json();
    const userMap = new Map<string, string>();

    for (const job of (data.results || [])) {
      if (job.created_by && job.created_by_name) {
        userMap.set(job.created_by, job.created_by_name);
      }
      if (job.sales_rep && job.sales_rep_name) {
        userMap.set(job.sales_rep, job.sales_rep_name);
      }
      if (job.owners) {
        for (const o of job.owners) {
          if (o.id && o.name) userMap.set(o.id, o.name);
        }
      }
    }

    // Also check contacts for more user references
    const cResp = await fetch('https://app.jobnimbus.com/api1/contacts?limit=50', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (cResp.ok) {
      const cData = await cResp.json();
      for (const c of (cData.results || [])) {
        if (c.created_by && c.created_by_name) {
          userMap.set(c.created_by, c.created_by_name);
        }
        if (c.sales_rep && c.sales_rep_name) {
          userMap.set(c.sales_rep, c.sales_rep_name);
        }
      }
    }

    const users = Array.from(userMap.entries()).map(([id, name]) => ({ jn_user_id: id, name }));

    return new Response(JSON.stringify({ users, count: users.length }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
