// Disabled: this bootstrap endpoint was a dev-only helper that created/reset
// admin accounts with no authentication. It has been permanently disabled to
// prevent unauthenticated admin escalation. Use the standard auth flow plus
// the user_roles table to grant admin access.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve((req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  return new Response(
    JSON.stringify({ error: "This endpoint has been permanently disabled." }),
    { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
