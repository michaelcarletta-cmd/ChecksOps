// Outbound push: invoked by the DB trigger on check_intake_items when a mirrored Freedom
// check changes status. Forwards the change to FreedomClaims' receive-check-status endpoint
// using the shared bridge secret.
//
// This function is called from inside Postgres via pg_net (no end-user auth), so it does NOT
// require a JWT. It validates the request shape and then forwards to Freedom.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FREEDOM_RECEIVE_URL = "https://yvagrvfkeuvzjezfsbun.supabase.co/functions/v1/receive-check-status";
const SOURCE_PARTNER_CODE = "CHECKSOPS";

interface TriggerPayload {
  source_check_id: string;
  partner_status?: string | null;
  partner_status_label?: string | null;
  check_number?: string | null;
  carrier_name?: string | null;
  amount?: number | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: corsHeaders });
  }

  const bridgeSecret = Deno.env.get("CROSS_APP_BRIDGE_SECRET");
  if (!bridgeSecret) {
    console.error("push-status-to-freedom: CROSS_APP_BRIDGE_SECRET not configured");
    return new Response(JSON.stringify({ error: "bridge secret not configured" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = (await req.json()) as TriggerPayload;
    if (!body?.source_check_id) {
      return new Response(JSON.stringify({ error: "source_check_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!body?.partner_status) {
      return new Response(JSON.stringify({ error: "partner_status required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const freedomPayload = {
      source_check_id: body.source_check_id,
      source_partner_code: SOURCE_PARTNER_CODE,
      partner_status: body.partner_status,
      partner_status_label: body.partner_status_label ?? body.partner_status,
      updated_at: new Date().toISOString(),
      check_number: body.check_number ?? undefined,
      carrier_name: body.carrier_name ?? undefined,
      amount: body.amount ?? undefined,
    };

    const resp = await fetch(FREEDOM_RECEIVE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-secret": bridgeSecret,
      },
      body: JSON.stringify(freedomPayload),
    });

    const responseText = await resp.text();
    if (!resp.ok) {
      console.error("freedom push failed", resp.status, responseText);
      return new Response(JSON.stringify({
        ok: false,
        forwarded_status: resp.status,
        forwarded_body: responseText,
      }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({
      ok: true,
      pushed_partner_status: body.partner_status,
      freedom_response: responseText,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error("push-status-to-freedom error", e);
    return new Response(JSON.stringify({ error: e.message ?? String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
