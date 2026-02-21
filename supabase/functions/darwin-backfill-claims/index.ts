import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const BATCH_SIZE = 50;

// ── State detection (reused from Phase 4) ──────────────────────────────
function detectState(address: string | null): string | null {
  if (!address) return null;
  const upper = address.toUpperCase();

  // Priority 1: ZIP pattern  e.g. "PA 19103"
  const zipMatch = upper.match(/\b(PA|NJ|NY|TX|FL)\s+\d{5}\b/);
  if (zipMatch) return zipMatch[1];

  // Priority 2: Word-boundary abbreviation
  if (/(^|[\s,])PA([\s,]|$)/.test(upper)) return "PA";
  if (/(^|[\s,])NJ([\s,]|$)/.test(upper)) return "NJ";
  if (/(^|[\s,])NY([\s,]|$)/.test(upper)) return "NY";
  if (/(^|[\s,])TX([\s,]|$)/.test(upper)) return "TX";
  if (/(^|[\s,])FL([\s,]|$)/.test(upper)) return "FL";

  // Priority 3: Full name
  if (/PENNSYLVANIA/.test(upper)) return "PA";
  if (/NEW\s+JERSEY/.test(upper)) return "NJ";
  if (/NEW\s+YORK/.test(upper)) return "NY";
  if (/TEXAS/.test(upper)) return "TX";
  if (/FLORIDA/.test(upper)) return "FL";

  return null;
}

// ── Deadline generation ────────────────────────────────────────────────
interface DeadlineSpec {
  deadline_type: string;
  days_offset: number;
  from_field: "created_at" | "loss_date";
  regulation_reference: string;
}

const STATE_DEADLINES: Record<string, DeadlineSpec[]> = {
  PA: [
    { deadline_type: "acknowledgment", days_offset: 10, from_field: "created_at", regulation_reference: "31 Pa. Code § 146.5(a)" },
    { deadline_type: "investigation", days_offset: 30, from_field: "created_at", regulation_reference: "31 Pa. Code § 146.5(b)" },
    { deadline_type: "written_response", days_offset: 45, from_field: "created_at", regulation_reference: "31 Pa. Code § 146.6" },
    { deadline_type: "statute_of_limitations", days_offset: 730, from_field: "loss_date", regulation_reference: "42 Pa. C.S. § 5524" },
  ],
  NJ: [
    { deadline_type: "acknowledgment", days_offset: 10, from_field: "created_at", regulation_reference: "N.J.A.C. 11:2-17.6(b)" },
    { deadline_type: "investigation", days_offset: 30, from_field: "created_at", regulation_reference: "N.J.A.C. 11:2-17.6(c)" },
    { deadline_type: "written_response", days_offset: 40, from_field: "created_at", regulation_reference: "N.J.A.C. 11:2-17.6(d)" },
    { deadline_type: "statute_of_limitations", days_offset: 2190, from_field: "loss_date", regulation_reference: "N.J.S.A. 2A:14-1" },
  ],
};

function addDays(date: string, days: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // Auth: accept cron secret OR valid JWT
    const cronSecret = req.headers.get("x-cron-secret");
    const authHeader = req.headers.get("Authorization");
    const expectedSecret = Deno.env.get("CRON_SECRET");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    if (cronSecret !== expectedSecret) {
      // Fallback: verify JWT
      if (!authHeader?.startsWith("Bearer ")) {
        return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const token = authHeader.replace("Bearer ", "");
      const { error: authErr } = await supabase.auth.getUser(token);
      if (authErr) {
        return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const body = await req.json().catch(() => ({}));
    const cursor: string | null = body.cursor || null;
    const today = new Date().toISOString().split("T")[0];

    // ── Fetch batch of claims ──────────────────────────────────────────
    let query = supabase
      .from("claims")
      .select("id, policyholder_address, created_at, loss_date, state_code")
      .order("id", { ascending: true })
      .limit(BATCH_SIZE);

    if (cursor) {
      query = query.gt("id", cursor);
    }

    const { data: claims, error: claimsErr } = await query;
    if (claimsErr) throw claimsErr;

    if (!claims || claims.length === 0) {
      return new Response(
        JSON.stringify({ success: true, processed: 0, remaining: 0, cursor: null, summary: "Backfill complete" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Get total remaining for progress ────────────────────────────────
    const { count: totalCount } = await supabase
      .from("claims")
      .select("id", { count: "exact", head: true });

    const { count: remainingAfter } = await supabase
      .from("claims")
      .select("id", { count: "exact", head: true })
      .gt("id", claims[claims.length - 1].id);

    // ── Get existing deadlines to skip duplicates ──────────────────────
    const claimIds = claims.map((c: any) => c.id);
    const { data: existingDeadlines } = await supabase
      .from("claim_deadlines")
      .select("claim_id, deadline_type")
      .in("claim_id", claimIds);

    const existingSet = new Set(
      (existingDeadlines || []).map((d: any) => `${d.claim_id}::${d.deadline_type}`)
    );

    // ── Process each claim ─────────────────────────────────────────────
    let deadlinesCreated = 0;
    let overdueCount = 0;
    let statesDetected: Record<string, number> = {};
    let skippedNoState = 0;

    for (const claim of claims) {
      const stateCode = claim.state_code || detectState(claim.policyholder_address);

      // Update state_code if not set
      if (!claim.state_code && stateCode) {
        await supabase
          .from("claims")
          .update({ state_code: stateCode })
          .eq("id", claim.id);
      }

      if (!stateCode) {
        skippedNoState++;
        continue;
      }

      statesDetected[stateCode] = (statesDetected[stateCode] || 0) + 1;

      const specs = STATE_DEADLINES[stateCode];
      if (!specs) continue;

      const deadlinesToInsert: any[] = [];

      for (const spec of specs) {
        const key = `${claim.id}::${spec.deadline_type}`;
        if (existingSet.has(key)) continue;

        const fromDate = spec.from_field === "loss_date"
          ? claim.loss_date
          : claim.created_at;

        if (!fromDate) continue;

        const deadlineDate = addDays(fromDate, spec.days_offset);
        const isOverdue = deadlineDate < today;
        if (isOverdue) overdueCount++;

        deadlinesToInsert.push({
          claim_id: claim.id,
          deadline_type: spec.deadline_type,
          deadline_date: deadlineDate,
          state_code: stateCode,
          status: isOverdue ? "overdue" : "pending",
          regulation_reference: spec.regulation_reference,
          notes: `Auto-generated by Darwin backfill`,
        });

        deadlinesCreated += 1;
      }

      if (deadlinesToInsert.length > 0) {
        const { error: insertErr } = await supabase
          .from("claim_deadlines")
          .insert(deadlinesToInsert);
        if (insertErr) {
          console.error(`Failed to insert deadlines for claim ${claim.id}:`, insertErr);
        }
      }
    }

    const lastCursor = claims[claims.length - 1].id;

    return new Response(
      JSON.stringify({
        success: true,
        processed: claims.length,
        remaining: remainingAfter || 0,
        total: totalCount || 0,
        cursor: lastCursor,
        batch_stats: {
          deadlines_created: deadlinesCreated,
          overdue_detected: overdueCount,
          states_detected: statesDetected,
          skipped_no_state: skippedNoState,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: unknown) {
    console.error("Backfill error:", err);
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
