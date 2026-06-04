import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function escHtml(s: string | number | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface EndorsementRow {
  id: string;
  payee_name: string;
  payee_type: string;
  status: string;
  signed_at: string | null;
  signature_image_url: string | null;
  signature_method: string;
  ip_address: string | null;
  user_agent: string | null;
  consent_text: string | null;
}

/* ------------------------------------------------------------------ */
/*  Render the endorsement packet as an SVG image                      */
/* ------------------------------------------------------------------ */

function renderPacketSvg(
  checkNumber: string,
  carrierName: string,
  amount: number | null,
  endorsements: EndorsementRow[],
  companyName: string = "Freedom Adjustment",
): string {
  const amountStr = amount != null
    ? `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
    : "N/A";

  const headerHeight = 200;
  const endorsementBlockHeight = 160;
  const totalHeight = headerHeight + endorsements.length * endorsementBlockHeight + 80;
  const width = 800;

  let sigBlocks = "";
  endorsements.forEach((e, i) => {
    const y = headerHeight + i * endorsementBlockHeight;
    const statusLabel = e.status === "signed" ? "ENDORSED" : e.status === "waived" ? "WAIVED" : e.status.toUpperCase();
    const statusColor = e.status === "signed" ? "#22c55e" : e.status === "waived" ? "#eab308" : "#94a3b8";
    const signedDate = e.signed_at ? new Date(e.signed_at).toLocaleString("en-US") : "—";

    // Signature rendering
    let sigElement: string;
    if (e.signature_image_url && e.signature_image_url.startsWith("data:image/")) {
      sigElement = `<image href="${escHtml(e.signature_image_url)}" x="60" y="${y + 60}" width="300" height="60" preserveAspectRatio="xMidYMid meet"/>`;
    } else if (e.signature_image_url && e.signature_image_url.startsWith("typed:")) {
      const typedName = e.signature_image_url.slice(6);
      sigElement = `<text x="60" y="${y + 100}" font-family="'Dancing Script', cursive, 'Brush Script MT', serif" font-size="28" fill="#1e293b">${escHtml(typedName)}</text>`;
    } else if (e.status === "waived") {
      sigElement = `<text x="60" y="${y + 100}" font-family="Arial, sans-serif" font-size="14" fill="#94a3b8" font-style="italic">Endorsement waived by staff</text>`;
    } else {
      sigElement = `<text x="60" y="${y + 100}" font-family="Arial, sans-serif" font-size="14" fill="#94a3b8">No signature captured</text>`;
    }

    sigBlocks += `
      <rect x="40" y="${y}" width="${width - 80}" height="${endorsementBlockHeight - 20}" rx="6" fill="#f8fafc" stroke="#e2e8f0"/>
      <text x="60" y="${y + 28}" font-family="Arial, sans-serif" font-size="16" font-weight="bold" fill="#1e293b">${escHtml(e.payee_name)}</text>
      <text x="60" y="${y + 48}" font-family="Arial, sans-serif" font-size="12" fill="#64748b">${escHtml(e.payee_type.replace(/_/g, " "))} · ${escHtml(e.signature_method)}</text>
      <text x="${width - 60}" y="${y + 28}" font-family="Arial, sans-serif" font-size="13" font-weight="bold" fill="${statusColor}" text-anchor="end">${statusLabel}</text>
      <text x="${width - 60}" y="${y + 48}" font-family="Arial, sans-serif" font-size="11" fill="#94a3b8" text-anchor="end">${escHtml(signedDate)}</text>
      ${sigElement}
      <line x1="60" y1="${y + 120}" x2="360" y2="${y + 120}" stroke="#cbd5e1" stroke-width="1"/>
      <text x="60" y="${y + 135}" font-family="Arial, sans-serif" font-size="10" fill="#94a3b8">Signature — ${escHtml(e.payee_name)}</text>
    `;
  });

  // Forensics footer
  const footerY = headerHeight + endorsements.length * endorsementBlockHeight + 10;
  const forensicsText = endorsements
    .filter((e) => e.ip_address)
    .map((e) => `${e.payee_name}: IP ${e.ip_address ?? "N/A"}`)
    .join(" | ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}">
  <defs>
    <style>@import url('https://fonts.googleapis.com/css2?family=Dancing+Script:wght@400;700');</style>
  </defs>
  <rect width="${width}" height="${totalHeight}" fill="#ffffff"/>

  <!-- Header -->
  <rect x="0" y="0" width="${width}" height="60" fill="#1e293b"/>
  <text x="40" y="38" font-family="Arial, sans-serif" font-size="18" font-weight="bold" fill="#ffffff">ENDORSEMENT PACKET</text>
  <text x="${width - 40}" y="38" font-family="Arial, sans-serif" font-size="14" fill="#94a3b8" text-anchor="end">Generated ${new Date().toLocaleDateString("en-US")}</text>

  <!-- Check details -->
  <text x="40" y="90" font-family="Arial, sans-serif" font-size="13" fill="#64748b">Carrier</text>
  <text x="200" y="90" font-family="Arial, sans-serif" font-size="14" font-weight="bold" fill="#1e293b">${escHtml(carrierName)}</text>

  <text x="40" y="115" font-family="Arial, sans-serif" font-size="13" fill="#64748b">Check #</text>
  <text x="200" y="115" font-family="Arial, sans-serif" font-size="14" font-weight="bold" fill="#1e293b">${escHtml(checkNumber)}</text>

  <text x="40" y="140" font-family="Arial, sans-serif" font-size="13" fill="#64748b">Amount</text>
  <text x="200" y="140" font-family="Arial, sans-serif" font-size="18" font-weight="bold" fill="#16a34a">${escHtml(amountStr)}</text>

  <text x="40" y="170" font-family="Arial, sans-serif" font-size="12" fill="#1e293b" font-weight="bold">Pay to the Order of — ${escHtml(companyName)} — For Mobile Deposit Only</text>

  <line x1="40" y1="185" x2="${width - 40}" y2="185" stroke="#e2e8f0" stroke-width="2"/>

  <!-- Endorsement blocks -->
  ${sigBlocks}

  <!-- Forensics footer -->
  <text x="40" y="${footerY + 30}" font-family="monospace" font-size="9" fill="#94a3b8">${escHtml(forensicsText)}</text>
  <text x="40" y="${footerY + 45}" font-family="monospace" font-size="9" fill="#94a3b8">Document generated at ${new Date().toISOString()} — Do not alter</text>
</svg>`;
}

/* ------------------------------------------------------------------ */
/*  Main handler                                                       */
/* ------------------------------------------------------------------ */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const checkId = body.checkId as string;
    const isAutomatic = body.automatic === true;

    if (!checkId) {
      return new Response(JSON.stringify({ error: "checkId required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Authenticate if not automatic (auto calls come from other edge functions with service key)
    let actorId: string | null = null;
    if (!isAutomatic) {
      const authToken = req.headers.get("authorization")?.replace("Bearer ", "");
      if (!authToken) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const anon = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: `Bearer ${authToken}` } },
      });
      const { data: ud, error: ae } = await anon.auth.getUser(authToken);
      if (ae || !ud?.user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      actorId = ud.user.id;
    }

    // Fetch check details
    const { data: check, error: checkErr } = await supabase
      .from("check_intake_items")
      .select("id, check_number, carrier_name, amount, tenant_id")
      .eq("id", checkId)
      .single();

    if (checkErr || !check) {
      return new Response(JSON.stringify({ error: "Check not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch tenant name for branding
    let companyName = "Freedom Adjustment";
    if (check.tenant_id) {
      const { data: tenant } = await supabase
        .from("tenants")
        .select("name")
        .eq("id", check.tenant_id)
        .maybeSingle();
      if (tenant?.name) {
        companyName = tenant.name;
      }
    }

    // Fetch all endorsements
    const { data: endorsements, error: endErr } = await supabase
      .from("check_endorsements")
      .select("id, payee_name, payee_type, status, signed_at, signature_image_url, signature_method, ip_address, user_agent, consent_text")
      .eq("check_id", checkId)
      .order("created_at", { ascending: true });

    if (endErr || !endorsements?.length) {
      return new Response(JSON.stringify({ error: "No endorsements found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify all required endorsements are complete
    const allDone = endorsements.every(
      (e: EndorsementRow) =>
        e.status === "signed" || e.status === "waived" ||
        (e.payee_type === "mortgage_company" && e.status === "manual_required"),
    );

    if (!allDone && !body.force) {
      return new Response(
        JSON.stringify({ error: "Not all endorsements are complete. Pass force=true to override." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Render SVG
    const svgContent = renderPacketSvg(
      check.check_number ?? "N/A",
      check.carrier_name ?? "Unknown",
      check.amount,
      endorsements as EndorsementRow[],
      companyName,
    );

    // Upload to storage
    const fileName = `endorsement-packet-${check.check_number ?? checkId.slice(0, 8)}-${Date.now()}.svg`;
    const storagePath = `packets/${checkId}/${fileName}`;

    const svgBlob = new Blob([svgContent], { type: "image/svg+xml" });

    const { error: uploadErr } = await supabase.storage
      .from("endorsement-packets")
      .upload(storagePath, svgBlob, {
        contentType: "image/svg+xml",
        upsert: true,
      });

    if (uploadErr) {
      console.error("Upload error:", uploadErr);
      return new Response(JSON.stringify({ error: `Storage upload failed: ${uploadErr.message}` }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Link to check record
    await supabase
      .from("check_intake_items")
      .update({ endorsement_packet_path: storagePath })
      .eq("id", checkId);

    // Audit log
    await supabase.from("check_audit_log").insert({
      check_id: checkId,
      event_type: "endorsement_packet_generated",
      event_description: `Endorsement packet generated with ${endorsements.length} payee(s)`,
      event_data: {
        storage_path: storagePath,
        payees: endorsements.map((e: EndorsementRow) => ({
          name: e.payee_name,
          status: e.status,
          method: e.signature_method,
        })),
      },
      actor_id: actorId,
    });

    await supabase.from("endorsement_audit_log").insert(
      endorsements.map((e: EndorsementRow) => ({
        endorsement_id: e.id,
        check_id: checkId,
        event_type: "included_in_packet",
        event_description: `Included in endorsement packet: ${storagePath}`,
        event_data: { storage_path: storagePath },
        actor_id: actorId,
      })),
    );

    return new Response(
      JSON.stringify({
        success: true,
        packet_path: storagePath,
        payee_count: endorsements.length,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("generate-endorsement-packet error:", e);
    return new Response(
      JSON.stringify({ error: "Internal error generating endorsement packet" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
