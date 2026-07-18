// Generates a ChecksOps-branded invoice for a completed mortgage handling
// request and emails it to the tenant contact (contractor). Also stores the
// invoice URL on the request for later reference.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function invoiceHtml(data: {
  invoiceNumber: string;
  invoiceDate: string;
  requestId: string;
  recipient: { name: string; email: string };
  claim: {
    homeowner?: string | null;
    property?: string | null;
    claimNumber?: string | null;
    loanNumber?: string | null;
    mortgageCompany?: string | null;
  };
  lineItems: { description: string; amount: number }[];
  notes?: string;
}): string {
  const total = data.lineItems.reduce((s, li) => s + li.amount, 0);
  const rows = data.lineItems
    .map(
      (li) => `
    <tr>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb;">${li.description}</td>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">$${li.amount.toFixed(2)}</td>
    </tr>`,
    )
    .join("");

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Invoice ${data.invoiceNumber}</title>
<style>
body{font-family:'Segoe UI',Arial,sans-serif;margin:0;padding:40px;color:#1f2937;}
.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:32px;border-bottom:3px solid #0f172a;padding-bottom:20px;}
.brand{font-size:26px;font-weight:800;color:#0f172a;letter-spacing:-0.5px;}
.brand span{color:#3b82f6;}
.brand-sub{color:#64748b;font-size:12px;margin-top:4px;}
.meta{text-align:right;font-size:13px;color:#374151;}
.meta h1{margin:0 0 8px;font-size:28px;color:#0f172a;}
.section{margin-bottom:20px;padding:14px 16px;background:#f8fafc;border-radius:8px;}
.section h3{margin:0 0 8px;font-size:11px;text-transform:uppercase;color:#64748b;letter-spacing:0.5px;}
.section p{margin:2px 0;font-size:14px;}
.claim-strip{display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;color:#334155;}
table{width:100%;border-collapse:collapse;margin:12px 0 8px;}
th{background:#0f172a;color:#fff;padding:10px;text-align:left;font-size:13px;}
th:last-child{text-align:right;}
.total{display:flex;justify-content:flex-end;margin-top:12px;}
.total-box{min-width:220px;border-top:2px solid #0f172a;padding-top:10px;font-size:18px;font-weight:700;display:flex;justify-content:space-between;}
.notes{margin-top:20px;padding:12px 14px;background:#fef3c7;border-left:4px solid #f59e0b;border-radius:6px;font-size:13px;color:#78350f;white-space:pre-wrap;}
.footer{margin-top:36px;padding-top:14px;border-top:1px solid #e5e7eb;text-align:center;font-size:11px;color:#94a3b8;}
</style></head><body>
<div class="header">
  <div>
    <div class="brand">Checks<span>Ops</span></div>
    <div class="brand-sub">Mortgage Loss Draft Desk</div>
    <div class="brand-sub">notify@checksops.com</div>
  </div>
  <div class="meta">
    <h1>INVOICE</h1>
    <p><strong>Invoice #:</strong> ${data.invoiceNumber}</p>
    <p><strong>Date:</strong> ${new Date(data.invoiceDate).toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"})}</p>
    <p><strong>Request:</strong> ${data.requestId.slice(0, 8)}</p>
  </div>
</div>

<div class="section">
  <h3>Bill To</h3>
  <p><strong>${data.recipient.name}</strong></p>
  ${data.recipient.email ? `<p>${data.recipient.email}</p>` : ""}
</div>

<div class="section">
  <h3>Claim Reference</h3>
  <div class="claim-strip">
    ${data.claim.homeowner ? `<div><strong>Homeowner:</strong> ${data.claim.homeowner}</div>` : ""}
    ${data.claim.claimNumber ? `<div><strong>Claim #:</strong> ${data.claim.claimNumber}</div>` : ""}
    ${data.claim.mortgageCompany ? `<div><strong>Mortgage:</strong> ${data.claim.mortgageCompany}</div>` : ""}
    ${data.claim.loanNumber ? `<div><strong>Loan #:</strong> ${data.claim.loanNumber}</div>` : ""}
    ${data.claim.property ? `<div style="grid-column:1/-1"><strong>Property:</strong> ${data.claim.property}</div>` : ""}
  </div>
</div>

<table>
  <thead><tr><th>Description</th><th>Amount</th></tr></thead>
  <tbody>${rows}</tbody>
</table>

<div class="total"><div class="total-box"><span>Total Due</span><span>$${total.toFixed(2)}</span></div></div>

${data.notes ? `<div class="notes">${data.notes}</div>` : ""}

<div class="footer">
  Thank you for using ChecksOps Mortgage Ops. Questions? Reply to notify@checksops.com.
</div>
</body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json(401, { error: "missing_authorization" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json(401, { error: "invalid_token" });
  const userId = userData.user.id;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  const { data: roles } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  const rn = (roles ?? []).map((r: any) => r.role);
  if (!rn.includes("admin") && !rn.includes("mortgage_agent")) {
    return json(403, { error: "not_authorized" });
  }

  let payload: {
    request_id: string;
    services_cents?: number;
    shipping_cents?: number;
    shipping_description?: string;
    recipient_email: string;
    recipient_name?: string;
    notes?: string;
    preview_only?: boolean;
  };
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }

  if (!payload.request_id) return json(400, { error: "request_id required" });
  if (!payload.recipient_email && !payload.preview_only) {
    return json(400, { error: "recipient_email required" });
  }

  const { data: request, error: reqErr } = await admin
    .from("mortgage_handling_requests")
    .select("*, tenants:tenant_id(name)")
    .eq("id", payload.request_id)
    .maybeSingle();
  if (reqErr) return json(500, { error: reqErr.message });
  if (!request) return json(404, { error: "request_not_found" });

  const servicesCents = payload.services_cents ?? 1000; // $10 default
  const shippingCents = payload.shipping_cents ?? 0;
  const shippingDesc =
    payload.shipping_description?.trim() || "2-Day shipping label";

  const lineItems = [
    {
      description:
        "Mortgage handling services — endorsement coordination & loss draft management",
      amount: servicesCents / 100,
    },
  ];
  if (shippingCents > 0) {
    lineItems.push({ description: shippingDesc, amount: shippingCents / 100 });
  }

  const invoiceNumber =
    (request as any).invoice_number ||
    `MO-${new Date().getFullYear()}-${payload.request_id.slice(0, 6).toUpperCase()}`;
  const tenantName = (request as any).tenants?.name || "Contractor";

  const html = invoiceHtml({
    invoiceNumber,
    invoiceDate: new Date().toISOString(),
    requestId: payload.request_id,
    recipient: {
      name: payload.recipient_name || tenantName,
      email: payload.recipient_email || "",
    },
    claim: {
      homeowner: request.homeowner_name,
      property: request.property_address,
      claimNumber: request.claim_number,
      loanNumber: request.loan_number,
      mortgageCompany: request.mortgage_company,
    },
    lineItems,
    notes: payload.notes,
  });

  // Upload HTML to storage
  const fileName = `mortgage-ops-invoices/${invoiceNumber}-${Date.now()}.html`;
  const { error: upErr } = await admin.storage
    .from("document-templates")
    .upload(fileName, new TextEncoder().encode(html), {
      contentType: "text/html",
      upsert: true,
    });
  if (upErr) return json(500, { error: `upload_failed: ${upErr.message}` });

  const { data: signed, error: urlErr } = await admin.storage
    .from("document-templates")
    .createSignedUrl(fileName, 30 * 24 * 60 * 60);
  if (urlErr) return json(500, { error: `signed_url_failed: ${urlErr.message}` });
  const invoiceUrl = signed.signedUrl;

  if (payload.preview_only) {
    return json(200, { ok: true, preview: true, invoice_url: invoiceUrl, invoice_number: invoiceNumber });
  }

  // Send email directly via Resend/connector gateway using ChecksOps identity
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const checksopsFrom = Deno.env.get("CHECKSOPS_FROM_EMAIL") || "notify@checksops.com";

  const total = lineItems.reduce((s, li) => s + li.amount, 0);
  const emailHtml = `
<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
  <h2 style="color:#0f172a;margin:0 0 4px;">ChecksOps Invoice ${invoiceNumber}</h2>
  <p style="color:#64748b;margin:0 0 20px;">Mortgage handling services for ${request.mortgage_company || "your mortgage request"}</p>
  <div style="background:#f8fafc;padding:16px;border-radius:8px;margin-bottom:16px;">
    ${lineItems.map((li) => `<div style="display:flex;justify-content:space-between;padding:6px 0;"><span>${li.description}</span><strong>$${li.amount.toFixed(2)}</strong></div>`).join("")}
    <div style="display:flex;justify-content:space-between;padding-top:10px;margin-top:10px;border-top:2px solid #0f172a;font-size:16px;">
      <strong>Total Due</strong><strong>$${total.toFixed(2)}</strong>
    </div>
  </div>
  <p><a href="${invoiceUrl}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:600;">View full invoice</a></p>
  ${payload.notes ? `<p style="background:#fef3c7;padding:12px;border-radius:6px;color:#78350f;font-size:13px;">${payload.notes}</p>` : ""}
  <p style="color:#94a3b8;font-size:12px;margin-top:24px;">Questions? Reply to this email.</p>
</div>`;

  let emailSent = false;
  let emailError: string | null = null;
  if (lovableKey && resendKey) {
    try {
      const res = await fetch("https://connector-gateway.lovable.dev/resend/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${lovableKey}`,
          "X-Connection-Api-Key": resendKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: `ChecksOps <${checksopsFrom}>`,
          to: [payload.recipient_email],
          subject: `Invoice ${invoiceNumber} — ChecksOps Mortgage Ops ($${total.toFixed(2)})`,
          html: emailHtml,
          reply_to: "notify@checksops.com",
          tags: [
            { name: "template", value: "mortgage_ops_invoice" },
            { name: "request", value: payload.request_id },
          ],
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        emailError = body?.message || `resend_${res.status}`;
      } else {
        emailSent = true;
      }
    } catch (e) {
      emailError = (e as Error).message;
    }
  } else {
    emailError = "email_provider_not_configured";
  }

  const nowIso = new Date().toISOString();
  await admin
    .from("mortgage_handling_requests")
    .update({
      invoice_url: invoiceUrl,
      invoice_number: invoiceNumber,
      invoice_recipient_email: payload.recipient_email,
      invoice_services_cents: servicesCents,
      invoice_shipping_cents: shippingCents,
      invoice_shipping_description: shippingDesc,
      invoice_notes: payload.notes ?? null,
      invoice_sent_at: emailSent ? nowIso : (request as any).invoice_sent_at ?? null,
    })
    .eq("id", payload.request_id);

  return json(emailSent ? 200 : 502, {
    ok: emailSent,
    invoice_url: invoiceUrl,
    invoice_number: invoiceNumber,
    email_sent: emailSent,
    email_error: emailError,
    total,
  });
});
