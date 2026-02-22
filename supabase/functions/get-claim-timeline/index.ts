import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface TimelineEvent {
  id: string;
  event_type: string;
  occurred_at: string;
  summary: string | null;
  actor: string | null;
  source_artifact_id: string | null;
  source_artifact_type: string | null;
  metadata_json: Record<string, unknown>;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json().catch(() => ({}));
    const claimId = (body as { claimId?: string }).claimId;
    if (!claimId) {
      return new Response(
        JSON.stringify({ error: "claimId required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const events: TimelineEvent[] = [];

    const { data: claimEvents, error: evErr } = await supabase
      .from("claim_events")
      .select("id, event_type, occurred_at, summary, actor, source_artifact_id, source_artifact_type, metadata_json, date_source, date_confidence, date_evidence, doc_type")
      .eq("claim_id", claimId)
      .order("occurred_at", { ascending: false });

    if (!evErr && claimEvents?.length) {
      events.push(
        ...claimEvents.map((e: any) => ({
          id: e.id,
          event_type: e.event_type,
          occurred_at: e.occurred_at,
          summary: e.summary ?? null,
          actor: e.actor ?? null,
          source_artifact_id: e.source_artifact_id ?? null,
          source_artifact_type: e.source_artifact_type ?? null,
          metadata_json: {
            ...(e.metadata_json as Record<string, unknown>) ?? {},
            date_source: e.date_source,
            date_confidence: e.date_confidence,
            date_evidence: e.date_evidence,
            doc_type: e.doc_type,
          },
        }))
      );
    }

    const { data: files } = await supabase
      .from("claim_files")
      .select("id, file_name, created_at")
      .eq("claim_id", claimId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (files?.length) {
      for (const f of files) {
        events.push({
          id: `file-${f.id}`,
          event_type: "file_uploaded",
          occurred_at: f.created_at ?? new Date().toISOString(),
          summary: `File uploaded: ${f.file_name}`,
          actor: null,
          source_artifact_id: f.id,
          source_artifact_type: "claim_file",
          metadata_json: { file_name: f.file_name },
        });
      }
    }

    const { data: emails } = await supabase
      .from("emails")
      .select("id, subject, sent_at, created_at")
      .eq("claim_id", claimId)
      .order("sent_at", { ascending: false })
      .limit(30);

    if (emails?.length) {
      for (const e of emails) {
        const at = e.sent_at ?? e.created_at ?? new Date().toISOString();
        events.push({
          id: `email-${e.id}`,
          event_type: "email_sent",
          occurred_at: at,
          summary: e.subject ?? "Email sent",
          actor: null,
          source_artifact_id: e.id,
          source_artifact_type: "email",
          metadata_json: {},
        });
      }
    }

    const { data: payments } = await supabase
      .from("claim_payments")
      .select("id, amount, payment_date, payment_method")
      .eq("claim_id", claimId)
      .order("payment_date", { ascending: false });

    if (payments?.length) {
      for (const p of payments) {
        events.push({
          id: `payment-${p.id}`,
          event_type: "payment_received",
          occurred_at: p.payment_date ?? new Date().toISOString(),
          summary: `Payment: $${Number(p.amount).toLocaleString()} (${p.payment_method ?? "—"})`,
          actor: null,
          source_artifact_id: p.id,
          source_artifact_type: "payment",
          metadata_json: { amount: p.amount },
        });
      }
    }

    events.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());

    return new Response(
      JSON.stringify({ claimId, events }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("get-claim-timeline error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
