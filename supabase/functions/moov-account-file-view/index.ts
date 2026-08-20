import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, json, isResponse, requireMoovCaller } from "../_shared/moovGuard.ts";

// Returns a short-lived signed URL for the retained copy of a verification
// document. Access is scoped to the tenant that owns the document (platform
// admins included) — the client never receives a storage credential.
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const tenantId = String(body?.tenant_id ?? "");
    const fileId = String(body?.file_id ?? "");
    if (!tenantId || !fileId) return json({ error: "tenant_id and file_id are required" }, 400);

    const caller = await requireMoovCaller(req, tenantId);
    if (isResponse(caller)) return caller;
    const { supabase } = caller;

    const { data: row, error } = await supabase
      .from("payment_provider_files")
      .select("storage_path, file_name")
      .eq("id", fileId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) return json({ error: error.message }, 500);

    const path = (row as any)?.storage_path as string | undefined;
    if (!path) {
      return json({ error: "No viewable copy is stored for this document." }, 404);
    }

    const { data: signed, error: signErr } = await supabase.storage
      .from("tenant-documents")
      .createSignedUrl(path, 300);
    if (signErr || !signed?.signedUrl) {
      return json({ error: signErr?.message ?? "Could not open that document." }, 500);
    }

    return json({ success: true, url: signed.signedUrl, file_name: (row as any)?.file_name ?? "document" });
  } catch (e) {
    console.error("[moov-account-file-view]", (e as Error).message);
    return json({ error: "Could not open that document." }, 500);
  }
});
