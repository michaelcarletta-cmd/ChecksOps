import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, json, isResponse, logPaymentEvent, requireMoovCaller, sanitize } from "../_shared/moovGuard.ts";
import {
  MAX_FILE_BYTES,
  rateLimitExceeded,
  moovPurposeFor,
  requiresRepresentative,
  UPLOAD_RATE_LIMIT,
  validateUpload,
} from "../_shared/moovFileRules.ts";
import { representativeBelongsToAccount, reviewStatusOf, uploadAccountFile } from "../_shared/moovFiles.ts";

// Secure tenant verification-document submission (KYB/KYC).
//
// The browser never sees provider credentials: it posts multipart/form-data
// here, this function authenticates the caller, proves the tenant owns the
// mapped provider account (and representative, when applicable), validates the
// file, forwards the bytes to the provider, and stores metadata only. The raw
// document is never written to ChecksOps storage or the database.

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      return json({ error: "Expected a multipart file upload." }, 400);
    }

    // Cheap pre-parse guard so oversized bodies never get buffered.
    const declaredLength = Number(req.headers.get("content-length") ?? 0);
    if (declaredLength && declaredLength > MAX_FILE_BYTES + 1024 * 512) {
      return json({ error: "Documents must be 20 MB or smaller." }, 413);
    }

    const form = await req.formData();
    const tenantId = String(form.get("tenant_id") ?? "");
    if (!tenantId) return json({ error: "tenant_id is required" }, 400);

    const caller = await requireMoovCaller(req, tenantId);
    if (isResponse(caller)) return caller;
    const { supabase, environment, userId, isAdmin } = caller;

    // Only organization admins/owners (or platform admins) may submit
    // compliance documents on behalf of the organization.
    if (!isAdmin) {
      const { data: membership } = await supabase
        .from("tenant_users")
        .select("role")
        .eq("tenant_id", tenantId)
        .eq("user_id", userId)
        .maybeSingle();
      const role = String((membership as any)?.role ?? "");
      if (!["owner", "admin"].includes(role)) {
        return json({ error: "Administrator access required" }, 403);
      }
    }

    // Abuse control: rolling per-tenant upload window.
    const since = new Date(Date.now() - UPLOAD_RATE_LIMIT.windowMinutes * 60_000).toISOString();
    const { count: recentCount } = await supabase
      .from("payment_provider_files")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .gte("created_at", since);
    if (rateLimitExceeded(recentCount ?? 0)) {
      return json({ error: "Too many uploads. Try again in an hour." }, 429);
    }

    const file = form.get("file");
    if (!(file instanceof File)) return json({ error: "A document file is required." }, 400);

    const purpose = form.get("file_purpose");
    const representativeInput = form.get("representative_id");
    const requirementId = form.get("requirement_id");

    const validated = validateUpload({
      purpose,
      fileName: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      representativeId: representativeInput,
    });
    if (!validated.ok || !validated.value) {
      return json({ error: validated.error, code: validated.code }, 400);
    }
    const { fileName, mimeType, sizeBytes, representativeId } = validated.value;
    const filePurpose = validated.value.purpose;

    // Provider account mapping — scoped to this tenant, so a spoofed account
    // id from the client cannot be used.
    const { data: account } = await supabase
      .from("payment_provider_accounts")
      .select("provider_account_id")
      .eq("tenant_id", tenantId)
      .eq("provider", "moov")
      .eq("environment", environment)
      .maybeSingle();

    const accountId = (account as any)?.provider_account_id as string | undefined;
    if (!accountId) return json({ error: "Set up the payment account first." }, 409);

    // Representative mapping is verified against the provider, never trusted.
    if (representativeId) {
      const belongs = await representativeBelongsToAccount(accountId, representativeId);
      if (!belongs) {
        return json({ error: "That business representative is not on your payment account." }, 400);
      }
    } else if (requiresRepresentative(filePurpose)) {
      return json({ error: "Select the business representative this document belongs to." }, 400);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > MAX_FILE_BYTES) {
      return json({ error: "Documents must be 20 MB or smaller." }, 413);
    }

    const uploaded = await uploadAccountFile({
      accountId,
      purpose: moovPurposeFor(filePurpose),
      fileName,
      mimeType,
      bytes,
      representativeId,
      requirementId: typeof requirementId === "string" && requirementId.trim() ? requirementId.trim() : null,
      idempotencyKey: `checksops-file-${tenantId}-${filePurpose}-${sizeBytes}-${fileName}`.slice(0, 200),
    });

    if (!uploaded?.fileID) {
      return json({ error: "The payment provider did not accept the document." }, 502);
    }

    const { data: saved, error: saveErr } = await supabase
      .from("payment_provider_files")
      .upsert(
        {
          tenant_id: tenantId,
          provider: "moov",
          environment,
          provider_account_id: accountId,
          provider_file_id: uploaded.fileID,
          provider_representative_id: representativeId,
          file_purpose: filePurpose,
          file_name: uploaded.fileName ?? fileName,
          mime_type: mimeType,
          file_size_bytes: sizeBytes,
          requirement_id: typeof requirementId === "string" && requirementId.trim() ? requirementId.trim() : null,
          review_status: reviewStatusOf(uploaded),
          review_reason: uploaded.decisionReason ?? null,
          provider_status_code: uploaded.fileStatusCode ?? null,
          provider_metadata: sanitize({ ...uploaded, metadata: undefined }),
          uploaded_by: userId,
          last_synced_at: new Date().toISOString(),
        },
        { onConflict: "provider,environment,provider_account_id,provider_file_id" },
      )
      .select()
      .single();
    if (saveErr) return json({ error: saveErr.message }, 500);

    await logPaymentEvent(supabase, {
      tenant_id: tenantId,
      event_type: "verification_document.submitted",
      new_status: (saved as any)?.review_status ?? "pending",
      environment,
      provider_metadata: {
        provider_file_id: uploaded.fileID,
        file_purpose: filePurpose,
        representative_linked: !!representativeId,
        size_bytes: sizeBytes,
        submitted_by: userId,
      },
    });

    return json({ success: true, file: saved });
  } catch (e) {
    const msg = (e as Error).message ?? "Upload failed";
    console.error("[moov-account-file-upload]", msg);
    return json({ error: "We couldn't submit that document. Please try again." }, 502);
  }
});
