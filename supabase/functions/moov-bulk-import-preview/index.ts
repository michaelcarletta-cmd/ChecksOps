import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { previewImport, type ImportRow } from "../_shared/moovImportRules.ts";
import { corsHeaders, json, serviceClient, moovGloballyEnabled } from "../_shared/moovGuard.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Admin-only DRY RUN for migrating an existing book of merchants.
 *
 * It validates and de-duplicates rows, flags organizations that already have a
 * payment account, and returns a preview. It deliberately creates NOTHING at
 * the provider — real onboarding stays a per-merchant, consent-driven flow.
 */

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!moovGloballyEnabled()) {
      return json({ error: "This payment provider is not enabled." }, 403);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData } = await authClient.auth.getUser();
    if (!userData?.user) return json({ error: "Unauthorized" }, 401);

    const supabase = serviceClient();
    const { data: adminRole } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userData.user.id)
      .eq("role", "admin")
      .maybeSingle();
    if (!adminRole) return json({ error: "Administrator access required" }, 403);

    const body = await req.json().catch(() => ({}));
    const rows = (body?.rows ?? []) as ImportRow[];
    const preview = previewImport(rows);

    // Cross-check against what already exists — never re-onboard a merchant.
    const tenantIds = preview.rows
      .map((r) => r.normalized.tenantId)
      .filter((id): id is string => !!id);

    if (tenantIds.length > 0) {
      const { data: tenants } = await supabase
        .from("tenants")
        .select("id, name")
        .in("id", tenantIds);
      const known = new Set((tenants ?? []).map((t: any) => t.id));

      const { data: existing } = await supabase
        .from("payment_provider_accounts")
        .select("tenant_id")
        .eq("provider", "moov")
        .in("tenant_id", tenantIds);
      const onboarded = new Set((existing ?? []).map((a: any) => a.tenant_id));

      for (const row of preview.rows) {
        const id = row.normalized.tenantId;
        if (!id) continue;
        if (!known.has(id)) {
          row.issues.push({
            field: "tenant_id",
            message: "No matching organization in ChecksOps.",
            severity: "error",
          });
          row.valid = false;
        }
        if (onboarded.has(id)) {
          row.issues.push({
            field: "tenant_id",
            message: "This organization already has a payment account — it will be skipped.",
            severity: "warning",
          });
        }
      }
      preview.validRows = preview.rows.filter((r) => r.valid).length;
      preview.invalidRows = preview.rows.filter((r) => !r.valid).length;
    }

    return json({
      success: true,
      dry_run: true,
      executed: false,
      note: "Preview only. No payment accounts were created.",
      preview,
    });
  } catch (e) {
    console.error("[moov-bulk-import-preview]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
