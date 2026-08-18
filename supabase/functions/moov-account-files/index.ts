import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, json, isResponse, requireMoovCaller, sanitize } from "../_shared/moovGuard.ts";
import { listAccountFiles, listRepresentatives, reviewStatusOf } from "../_shared/moovFiles.ts";

// Reads verification-document METADATA for the caller's own organization and
// syncs provider review status. Document contents are never fetched, proxied,
// or returned — only status, filename, purpose, size and timestamps.

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { tenant_id, sync = true } = await req.json();
    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);

    const caller = await requireMoovCaller(req, tenant_id);
    if (isResponse(caller)) return caller;
    const { supabase, environment } = caller;

    const { data: account } = await supabase
      .from("payment_provider_accounts")
      .select("provider_account_id, requirements")
      .eq("tenant_id", tenant_id)
      .eq("provider", "moov")
      .eq("environment", environment)
      .maybeSingle();

    const accountId = (account as any)?.provider_account_id as string | undefined;

    let representatives: Array<{ id: string; name: string }> = [];
    let syncError: string | null = null;

    if (accountId && sync) {
      try {
        const remote = await listAccountFiles(accountId);
        for (const f of remote) {
          if (!f.fileID) continue;
          await supabase
            .from("payment_provider_files")
            .upsert(
              {
                tenant_id,
                provider: "moov",
                environment,
                provider_account_id: accountId,
                provider_file_id: f.fileID,
                file_purpose: f.filePurpose ?? "business_verification",
                file_name: f.fileName ?? "document",
                file_size_bytes: f.fileSizeBytes ?? null,
                review_status: reviewStatusOf(f),
                review_reason: f.decisionReason ?? null,
                provider_status_code: f.fileStatusCode ?? null,
                provider_representative_id: (f.metadata as any)?.representativeID ?? null,
                requirement_id: (f.metadata as any)?.requirementID ?? null,
                provider_metadata: sanitize({ ...f, metadata: undefined }),
                last_synced_at: new Date().toISOString(),
              },
              { onConflict: "provider,environment,provider_account_id,provider_file_id" },
            );
        }
      } catch (e) {
        syncError = (e as Error).message;
        console.error("[moov-account-files] sync", syncError);
      }

      try {
        representatives = (await listRepresentatives(accountId))
          .filter((r) => !r.disabledOn)
          .map((r) => ({
            id: r.representativeID,
            name: [r.name?.firstName, r.name?.lastName].filter(Boolean).join(" ") || "Representative",
          }));
      } catch (e) {
        console.error("[moov-account-files] representatives", (e as Error).message);
      }
    }

    const { data: files, error } = await supabase
      .from("payment_provider_files")
      .select(
        "id, file_name, file_purpose, mime_type, file_size_bytes, requirement_id, provider_file_id, provider_representative_id, review_status, review_reason, created_at, last_synced_at",
      )
      .eq("tenant_id", tenant_id)
      .eq("environment", environment)
      .order("created_at", { ascending: false });
    if (error) return json({ error: error.message }, 500);

    return json({
      success: true,
      account_connected: !!accountId,
      requirements: (account as any)?.requirements ?? [],
      representatives,
      files: files ?? [],
      sync_error: syncError ? "Could not refresh review status from the payment provider." : null,
    });
  } catch (e) {
    console.error("[moov-account-files]", (e as Error).message);
    return json({ error: "Could not load verification documents." }, 500);
  }
});
