// Actum ACH return / status webhook
// Receives async notifications from Actum about the fate of debits
// (settled, returned/NSF/unauthorized, etc.) and updates the matching
// tenant_maintenance_payments row.
//
// Configure the endpoint in your Actum merchant portal to POST here.
// Optional shared-secret verification via ACTUM_WEBHOOK_SECRET
// (sent as header `X-Actum-Signature` or query `?secret=`).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-actum-signature",
};

type ActumEvent = {
  // Actum posts either JSON or form-encoded; we normalize to this shape.
  order_id?: string;
  merordernumber?: string; // our idempotence key: "maint_{payment_id}"
  history_id?: string;
  status?: string;         // e.g. "settled", "returned", "rejected", "chargeback"
  return_code?: string;    // e.g. "R01" NSF, "R07" unauthorized, "R10" customer advises
  return_reason?: string;
  amount?: string | number;
  consumer_unique?: string;
  event_type?: string;
};

function mapStatus(ev: ActumEvent): { status: string; failure_reason: string | null } {
  const raw = (ev.status || ev.event_type || "").toLowerCase();
  const code = (ev.return_code || "").toUpperCase();

  if (["settled", "cleared", "funded", "posted", "success"].includes(raw)) {
    return { status: "cleared", failure_reason: null };
  }
  if (["returned", "return", "nsf", "chargeback", "reversed"].includes(raw) || code.startsWith("R")) {
    const reason = ev.return_reason || code || raw || "returned";
    return { status: "returned", failure_reason: reason };
  }
  if (["rejected", "failed", "declined", "error"].includes(raw)) {
    return { status: "failed", failure_reason: ev.return_reason || raw };
  }
  if (["submitted", "pending", "processing", "in_process"].includes(raw)) {
    return { status: "submitted", failure_reason: null };
  }
  // Unknown — leave a note but don't overwrite meaningful state
  return { status: "submitted", failure_reason: null };
}

async function readEvent(req: Request): Promise<ActumEvent> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return (await req.json()) as ActumEvent;
  }
  // form-encoded fallback
  const text = await req.text();
  const params = new URLSearchParams(text);
  const obj: Record<string, string> = {};
  for (const [k, v] of params.entries()) obj[k.toLowerCase()] = v;
  return obj as ActumEvent;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    // Optional signature/secret check
    const expected = Deno.env.get("ACTUM_WEBHOOK_SECRET");
    if (expected) {
      const url = new URL(req.url);
      const provided =
        req.headers.get("x-actum-signature") ||
        url.searchParams.get("secret") ||
        "";
      if (provided !== expected) {
        return new Response(JSON.stringify({ error: "invalid signature" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const ev = await readEvent(req);

    // Locate the payment row. Prefer merordernumber (our idempotence key),
    // fall back to Actum's order_id.
    const idem = ev.merordernumber || null;
    const orderId = ev.order_id || null;

    let query = supabase
      .from("tenant_maintenance_payments")
      .select("id, status")
      .limit(1);

    if (idem) query = query.eq("idempotence_key", idem);
    else if (orderId) query = query.eq("actum_order_id", orderId);
    else {
      return new Response(JSON.stringify({ error: "missing order_id / merordernumber" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: rows, error: findErr } = await query;
    if (findErr) throw findErr;
    const row = rows?.[0];
    if (!row) {
      // Log but return 200 so Actum doesn't retry forever on an unknown ref
      console.log("[actum-webhook] no matching payment for", { idem, orderId });
      return new Response(JSON.stringify({ ok: true, matched: false }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { status, failure_reason } = mapStatus(ev);

    // Don't downgrade a cleared/returned payment back to submitted
    const terminal = ["cleared", "returned", "failed"];
    if (terminal.includes(row.status) && status === "submitted") {
      return new Response(JSON.stringify({ ok: true, skipped: true, current: row.status }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const update: Record<string, unknown> = {
      status,
      failure_reason,
      updated_at: new Date().toISOString(),
    };
    if (ev.history_id) update.actum_history_id = String(ev.history_id);
    if (ev.order_id) update.actum_order_id = String(ev.order_id);

    const { error: updErr } = await supabase
      .from("tenant_maintenance_payments")
      .update(update)
      .eq("id", row.id);
    if (updErr) throw updErr;

    console.log("[actum-webhook] updated", row.id, "->", status, failure_reason ?? "");

    return new Response(JSON.stringify({ ok: true, id: row.id, status }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[actum-webhook] error", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
