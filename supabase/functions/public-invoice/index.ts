import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const token = String(body?.token ?? "").trim();
    if (!token) return json({ error: "Invoice token is required" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: invoice, error: invoiceErr } = await supabase
      .from("moov_invoices")
      .select(`
        id,
        public_token,
        invoice_number,
        customer_name,
        customer_email,
        description,
        line_items,
        total_amount,
        paid_amount,
        status,
        invoice_date,
        due_date,
        payment_link_url,
        sent_at,
        paid_at,
        created_at,
        tenant_id
      `)
      .eq("public_token", token)
      .maybeSingle();

    if (invoiceErr) {
      console.error("[public-invoice] lookup error", invoiceErr.message);
      return json({ error: "Could not load invoice" }, 500);
    }
    if (!invoice) return json({ error: "Invoice not found" }, 404);

    const { data: tenant, error: tenantErr } = await supabase
      .from("tenants")
      .select("name, slug, logo_url, primary_color, secondary_color, custom_domain, invoice_letterhead_url, invoice_footer_note, invoice_default_terms, invoice_accent_color, invoice_theme")
      .eq("id", invoice.tenant_id)
      .maybeSingle();

    if (tenantErr) {
      console.error("[public-invoice] tenant lookup error", tenantErr.message);
      return json({ error: "Could not load organization" }, 500);
    }
    if (!tenant) return json({ error: "Organization not found" }, 404);

    return json({
      invoice: {
        id: invoice.id,
        public_token: invoice.public_token,
        invoice_number: invoice.invoice_number,
        customer_name: invoice.customer_name,
        customer_email: invoice.customer_email,
        description: invoice.description,
        line_items: Array.isArray(invoice.line_items) ? invoice.line_items : [],
        total_amount: Number(invoice.total_amount ?? 0),
        paid_amount: Number(invoice.paid_amount ?? 0),
        status: invoice.status,
        invoice_date: invoice.invoice_date,
        due_date: invoice.due_date,
        payment_link_url: invoice.payment_link_url,
        sent_at: invoice.sent_at,
        paid_at: invoice.paid_at,
        created_at: invoice.created_at,
      },
      tenant: {
        name: tenant.name,
        slug: tenant.slug,
        logo_url: tenant.logo_url,
        primary_color: tenant.primary_color,
        secondary_color: tenant.secondary_color,
        custom_domain: tenant.custom_domain,
        invoice_letterhead_url: tenant.invoice_letterhead_url,
        invoice_footer_note: tenant.invoice_footer_note,
        invoice_default_terms: tenant.invoice_default_terms,
        invoice_accent_color: tenant.invoice_accent_color,
        invoice_theme: tenant.invoice_theme,
      },
    });
  } catch (e) {
    const err = e as any;
    console.error("[public-invoice] error", err?.message);
    return json({ error: err?.message ?? "Invoice request failed" }, 500);
  }
});
