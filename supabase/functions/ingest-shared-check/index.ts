// Accepts a check shared from another Lovable Cloud app (e.g. Freedom CRM).
// Authenticates via shared bridge secret. Mirrors the check into check_intake_items
// (tagged with external_origin) and creates a shared_checks row.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bridge-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CLAIM_FILES_BUCKET = "claim-files";

/**
 * Download a remote check image (typically a cross-project signed URL from
 * the source app) and persist the bytes into THIS project's claim-files
 * bucket. Returns a local object path suitable for storage.from(...).createSignedUrl.
 *
 * Storing bytes locally is essential because:
 *  - Source-app signed URLs expire (tokens are typically valid for ~24h).
 *  - The URL points at a different Supabase project, so we can't re-sign it.
 * Without copying, every shared check loses its images as soon as the source
 * token expires.
 *
 * Falls back to returning the original URL string if the download fails — that
 * way ingest never breaks, and the UI's repair path can still try later.
 */
async function copyRemoteImageLocally(
  supabase: ReturnType<typeof createClient>,
  remoteUrl: string | null | undefined,
  checkLocalId: string,
  side: "front" | "back",
): Promise<string | null> {
  if (!remoteUrl) return null;
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;
  // If it's already a relative object path, keep as-is.
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;

  try {
    const resp = await fetch(trimmed);
    if (!resp.ok) {
      console.warn(`[ingest-shared-check] ${side} image fetch failed (${resp.status}) for ${trimmed.slice(0, 120)}…`);
      return trimmed; // keep URL; repair logic may retry
    }
    const contentType = resp.headers.get("content-type") ?? "image/jpeg";
    const extFromUrl = (() => {
      const clean = trimmed.split("?")[0];
      const last = clean.split("/").pop() ?? "";
      const ext = last.includes(".") ? last.split(".").pop() : "";
      return (ext || "jpg").toLowerCase();
    })();
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const objectPath = `checks/shared/${checkLocalId}/${side}-${Date.now()}.${extFromUrl}`;
    const { error: upErr } = await supabase.storage
      .from(CLAIM_FILES_BUCKET)
      .upload(objectPath, bytes, {
        upsert: true,
        contentType,
        cacheControl: "31536000",
      });
    if (upErr) {
      console.warn(`[ingest-shared-check] ${side} image upload failed: ${upErr.message}`);
      return trimmed;
    }
    return objectPath;
  } catch (e) {
    console.warn(`[ingest-shared-check] ${side} image copy error: ${(e as Error).message}`);
    return trimmed;
  }
}

interface IngestPayload {
  source_app: string;            // e.g. "freedom_crm"
  source_project_ref: string;    // e.g. "yvagrvfkeuvzjezfsbun"
  source_tenant_id: string;      // tenant uuid in the source app
  source_tenant_name: string;    // display name of the source tenant
  source_check_id: string;       // original check uuid in the source app
  source_partner_code?: string;  // partner code of the SOURCE app's tenant (for native-pairing)
  target_partner_code: string;   // ChecksOps tenant partner code receiving the share
  shared_by_email?: string;      // for audit
  freedom_claim_id?: string | null;     // Freedom CRM claim uuid (join key)
  freedom_claim_number?: string | null; // Freedom CRM claim number (display)
  check: {
    carrier_name?: string;
    check_number?: string;
    amount?: number;
    issue_date?: string;
    payee_line?: string;
    front_image_url?: string;    // public/signed URL we can store as a reference
    back_image_url?: string;
    detected_claim_number?: string;
    funds_type?: string | null;
    property_address?: string | null;
    payment_classification?: string | null;
    payee_address?: string | null;
    status?: string | null;
    check_stage?: string | null;
    deposit_recommendation?: string | null;
    ocr_status?: string | null;
    partner_status?: string | null;
    partner_status_label?: string | null;
    partner_status_updated_at?: string | null;
  };
  payees?: Array<{
    payee_name: string;
    payee_type?: string | null;
    endorsement_status?: string | null;
    endorsed_at?: string | null;
    signed_at?: string | null;
    contact_email?: string | null;
    contact_phone?: string | null;
  }>;
}

type IngestPayee = NonNullable<IngestPayload["payees"]>[number];

function humanizeStatus(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

// Standard Caps (Title Case) normalizer — preserves common business acronyms.
const STANDARD_CAPS_ACRONYMS = new Set([
  "LLC", "INC", "LP", "LLP", "PA", "PC", "CO", "CORP", "NA", "USA",
  "II", "III", "IV", "DBA", "LTD", "PO", "JR", "SR", "US", "ATM",
  "AC", "HVAC", "TV", "PLLC", "PLC", "FSB",
]);

function toStandardCaps<T extends string | null | undefined>(input: T): T {
  if (input == null) return input;
  const s = String(input);
  if (!s.trim()) return input;
  const out = s.replace(/[A-Za-z][A-Za-z'’]*/g, (word) => {
    const upper = word.toUpperCase();
    if (STANDARD_CAPS_ACRONYMS.has(upper)) return upper;
    if (word.length === 1) return upper;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
  return out as T;
}

function resolveSignedAt(payee: { endorsed_at?: string | null; signed_at?: string | null }): string | null {
  return payee.endorsed_at ?? payee.signed_at ?? null;
}

function normalizePayeeStatus(status?: string | null, signedAt?: string | null): string {
  if (signedAt) return "signed";

  const value = (status ?? "").toLowerCase().trim();
  if (!value) return "pending";
  if (["signed", "endorsed", "complete", "completed", "waived", "manual_required"].includes(value)) return "signed";
  if (["viewed", "opened"].includes(value)) return "viewed";
  if (["declined", "rejected"].includes(value)) return "rejected";
  if (value === "expired") return "expired";
  return "pending";
}

// check_payees.payee_type is constrained to: insured, mortgage_company,
// contractor, public_adjuster, unknown. Upstream apps may send legacy values
// like "other", "homeowner", "vendor", etc. — coerce them to a valid value
// so the payee mirror doesn't fail outright (which would force users to
// re-enter every payee manually).
function normalizePayeeType(raw?: string | null): string {
  const value = (raw ?? "").toLowerCase().trim();
  if (!value) return "unknown";
  if (value === "insured" || value === "homeowner" || value === "policyholder") return "insured";
  if (value === "mortgage_company" || value === "mortgagee" || value === "mortgage" || value === "lender") return "mortgage_company";
  if (value === "contractor" || value === "vendor" || value === "subcontractor") return "contractor";
  if (value === "public_adjuster" || value === "pa" || value === "adjuster") return "public_adjuster";
  return "unknown";
}

function normalizeEndorsementStatus(status?: string | null, signedAt?: string | null): string {
  if (signedAt) return "signed";

  const value = (status ?? "").toLowerCase().trim();
  if (!value) return "pending";
  if (["signed", "endorsed", "complete", "completed"].includes(value)) return "signed";
  if (value === "waived") return "waived";
  if (value === "manual_required") return "manual_required";
  if (["declined", "rejected"].includes(value)) return "rejected";
  if (["sent", "requested", "awaiting", "in_progress", "viewed", "opened"].includes(value)) return "sent";
  if (value === "expired") return "expired";
  return "pending";
}

function derivePartnerStatusFromPayees(payees: IngestPayee[]): {
  partner_status: string;
  partner_status_label: string;
  partner_status_updated_at: string;
} | null {
  if (payees.length === 0) return null;

  const normalized = payees.map((payee) =>
    normalizeEndorsementStatus(payee.endorsement_status, resolveSignedAt(payee))
  );
  const allComplete = normalized.every((status) =>
    ["signed", "waived", "manual_required"].includes(status)
  );
  const partnerStatus = allComplete ? "endorsements_complete" : "endorsements_in_progress";

  return {
    partner_status: partnerStatus,
    partner_status_label: humanizeStatus(partnerStatus),
    partner_status_updated_at: new Date().toISOString(),
  };
}

function derivePartnerStatus(check: IngestPayload["check"]): {
  partner_status: string;
  partner_status_label: string;
  partner_status_updated_at: string;
} | null {
  const explicitStatus = check.partner_status?.trim();
  if (explicitStatus) {
    return {
      partner_status: explicitStatus,
      partner_status_label: check.partner_status_label?.trim() || humanizeStatus(explicitStatus),
      partner_status_updated_at: check.partner_status_updated_at ?? new Date().toISOString(),
    };
  }

  const stage = (check.check_stage ?? "").trim().toLowerCase();
  const status = (check.status ?? "").trim().toLowerCase();
  const recommendation = (check.deposit_recommendation ?? "").trim().toLowerCase();

  if (stage === "endorsing") {
    return {
      partner_status: "endorsements_in_progress",
      partner_status_label: "Endorsements In Progress",
      partner_status_updated_at: new Date().toISOString(),
    };
  }

  if (stage === "ready_for_deposit") {
    const normalized = status === "branch_deposit_required" || recommendation === "branch_deposit_recommended"
      ? "branch_deposit_required"
      : "approved_for_deposit";
    return {
      partner_status: normalized,
      partner_status_label: humanizeStatus(normalized),
      partner_status_updated_at: new Date().toISOString(),
    };
  }

  if (stage === "loss_draft") {
    return {
      partner_status: "loss_draft_required",
      partner_status_label: "Loss Draft Required",
      partner_status_updated_at: new Date().toISOString(),
    };
  }

  if (stage === "deposited") {
    return {
      partner_status: "deposited",
      partner_status_label: "Deposited",
      partner_status_updated_at: new Date().toISOString(),
    };
  }

  const normalizedStatus = [
    "endorsements_in_progress",
    "approved_for_deposit",
    "branch_deposit_required",
    "loss_draft_required",
    "deposited",
    "manual_review_required",
    "endorsements_complete",
    "needs_review",
    "reissue_requested",
  ].includes(status)
    ? status
    : recommendation === "endorsements_pending"
      ? "endorsements_in_progress"
      : recommendation === "ready_for_deposit"
        ? "approved_for_deposit"
        : recommendation === "branch_deposit_recommended"
          ? "branch_deposit_required"
          : null;

  if (!normalizedStatus) return null;

  return {
    partner_status: normalizedStatus,
    partner_status_label: humanizeStatus(normalizedStatus),
    partner_status_updated_at: new Date().toISOString(),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: corsHeaders });
  }

  // Authenticate via shared bridge secret
  const expected = Deno.env.get("CROSS_APP_BRIDGE_SECRET");
  const provided = req.headers.get("x-bridge-secret");
  if (!expected || provided !== expected) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = (await req.json()) as IngestPayload;
    if (!body?.source_check_id || !body?.target_partner_code || !body?.source_tenant_id) {
      return new Response(JSON.stringify({ error: "missing required fields" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Resolve target tenant (the ChecksOps tenant receiving the share)
    const code = body.target_partner_code.trim().toUpperCase();
    const { data: lookup, error: lookupErr } = await supabase.rpc("lookup_tenant_by_partner_code", { _code: code });
    if (lookupErr) throw lookupErr;
    const targetTenant = Array.isArray(lookup) ? lookup[0] : lookup;
    if (!targetTenant) {
      return new Response(JSON.stringify({ error: "target_partner_code not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const targetTenantId = targetTenant.id ?? targetTenant.tenant_id;

    // Native-tenant pairing: certain source partner codes map to a native
    // ChecksOps tenant. When matched, the check is routed directly into that
    // tenant (not a read-only mirror), unlocking endorsements and editing.
    const NATIVE_TENANT_MAP: Record<string, string> = {
      // Freedom Adjustment (Freedom CRM embeds ChecksOps in an iframe)
      DF9CC985: "2eff5f1a-929d-4ce3-9a8b-cd96b98df42a",
    };
    const sourcePartnerCode = body.source_partner_code?.trim().toUpperCase() ?? "";
    const nativeTenantId = NATIVE_TENANT_MAP[sourcePartnerCode] ?? null;
    const isNativePaired = !!nativeTenantId;

    let sourceTenantId: string;
    if (isNativePaired) {
      sourceTenantId = nativeTenantId!;
    } else {
      // Resolve OR auto-create a placeholder source tenant locally so FK works.
      const externalSlug = `ext-${body.source_app}-${body.source_tenant_id.slice(0, 8)}`;
      let { data: extTenant } = await supabase
        .from("tenants")
        .select("id")
        .eq("slug", externalSlug)
        .maybeSingle();

      if (!extTenant) {
        const { data: created, error: createErr } = await supabase
          .from("tenants")
          .insert({
            name: `${body.source_tenant_name} (${body.source_app})`,
            slug: externalSlug,
            plan_tier: "starter",
          })
          .select("id")
          .single();
        if (createErr) throw createErr;
        extTenant = created;
      }
      sourceTenantId = extTenant!.id;
    }

    // Idempotent check mirror: lookup by external_origin->>source_check_id
    const { data: existingCheck } = await supabase
      .from("check_intake_items")
      .select("id")
      .eq("external_origin->>source_check_id", body.source_check_id)
      .maybeSingle();

    const cleanedPayees = Array.isArray(body.payees)
      ? body.payees.filter(
        (p) => p && typeof p.payee_name === "string" && p.payee_name.trim().length > 0,
      )
      : [];
    const initialPartnerStatus = derivePartnerStatus(body.check) ?? derivePartnerStatusFromPayees(cleanedPayees);

    // Copy remote images into LOCAL claim-files storage so they survive
    // source-app token expiry and remain re-signable from this project.
    // Uses source_check_id as the storage discriminator (stable + idempotent).
    const localFrontPath = await copyRemoteImageLocally(
      supabase,
      body.check.front_image_url,
      body.source_check_id,
      "front",
    );
    const localBackPath = await copyRemoteImageLocally(
      supabase,
      body.check.back_image_url,
      body.source_check_id,
      "back",
    );

    let checkId: string;
    if (existingCheck) {
      checkId = existingCheck.id;
      // Re-sync mutable fields from source so partner sees latest values
      const updatePayload: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (body.check.carrier_name !== undefined) updatePayload.carrier_name = toStandardCaps(body.check.carrier_name ?? null);
      if (body.check.check_number !== undefined) updatePayload.check_number = body.check.check_number ?? null;
      if (body.check.amount !== undefined) updatePayload.amount = body.check.amount ?? null;
      if (body.check.issue_date !== undefined) updatePayload.issue_date = body.check.issue_date ?? null;
      if (body.check.payee_line !== undefined) updatePayload.payee_line = toStandardCaps(body.check.payee_line ?? null);
      if (body.check.detected_claim_number !== undefined) updatePayload.detected_claim_number = body.check.detected_claim_number ?? null;
      if (body.check.funds_type !== undefined) updatePayload.funds_type = body.check.funds_type ?? null;
      if (body.check.property_address !== undefined) updatePayload.property_address = toStandardCaps(body.check.property_address ?? null);
      if (body.check.payment_classification !== undefined) updatePayload.payment_classification = body.check.payment_classification ?? null;
      if (body.check.payee_address !== undefined) updatePayload.payee_address = toStandardCaps(body.check.payee_address ?? null);
      if (body.check.status !== undefined) updatePayload.status = body.check.status ?? null;
      if (body.check.check_stage !== undefined) updatePayload.check_stage = body.check.check_stage ?? "review";
      if (body.check.deposit_recommendation !== undefined) updatePayload.deposit_recommendation = body.check.deposit_recommendation ?? null;
      if (body.check.ocr_status !== undefined) updatePayload.ocr_status = body.check.ocr_status ?? null;
      if (body.freedom_claim_id !== undefined) updatePayload.freedom_claim_id = body.freedom_claim_id ?? null;
      if (body.freedom_claim_number !== undefined) updatePayload.freedom_claim_number = body.freedom_claim_number ?? null;
      // Refresh image paths if we successfully copied bytes locally (don't
      // overwrite with an unchanged remote URL).
      if (localFrontPath && !/^https?:\/\//i.test(localFrontPath)) {
        updatePayload.front_image_path = localFrontPath;
      }
      if (localBackPath && !/^https?:\/\//i.test(localBackPath)) {
        updatePayload.back_image_path = localBackPath;
      }
      if (initialPartnerStatus) Object.assign(updatePayload, initialPartnerStatus);
      const { error: updErr } = await supabase
        .from("check_intake_items")
        .update(updatePayload)
        .eq("id", checkId);
      if (updErr) throw updErr;
    } else {
      const { data: newCheck, error: insertErr } = await supabase
        .from("check_intake_items")
        .insert({
          tenant_id: sourceTenantId,
          front_image_path: localFrontPath ?? `external://${body.source_check_id}`,
          back_image_path: localBackPath,
          carrier_name: toStandardCaps(body.check.carrier_name ?? null),
          check_number: body.check.check_number ?? null,
          amount: body.check.amount ?? null,
          issue_date: body.check.issue_date ?? null,
          payee_line: toStandardCaps(body.check.payee_line ?? null),
          detected_claim_number: body.check.detected_claim_number ?? null,
          funds_type: body.check.funds_type ?? null,
          property_address: toStandardCaps(body.check.property_address ?? null),
          payment_classification: body.check.payment_classification ?? null,
          payee_address: toStandardCaps(body.check.payee_address ?? null),
          status: isNativePaired ? (body.check.status ?? "needs_review") : (body.check.status ?? "uploaded"),
          check_stage: isNativePaired ? "review" : (body.check.check_stage ?? "review"),
          check_source: "insurance",
          deposit_recommendation: body.check.deposit_recommendation ?? null,
          ocr_status: body.check.ocr_status ?? "completed",
          freedom_claim_id: body.freedom_claim_id ?? null,
          freedom_claim_number: body.freedom_claim_number ?? null,
          ...(isNativePaired ? {} : (initialPartnerStatus ?? {})),
          external_origin: {
            source_app: body.source_app,
            source_project_ref: body.source_project_ref,
            source_tenant_id: body.source_tenant_id,
            source_tenant_name: body.source_tenant_name,
            source_check_id: body.source_check_id,
            source_partner_code: sourcePartnerCode || null,
            native_paired: isNativePaired,
            ingested_at: new Date().toISOString(),
            shared_by_email: body.shared_by_email ?? null,
          },
        })
        .select("id")
        .single();
      if (insertErr) throw insertErr;
      checkId = newCheck.id;
    }


    // Mirror payee endorsement state so partners can see who has signed
    // and who still needs to. Source-of-truth is the upstream app.
    if (Array.isArray(body.payees)) {
      // Replace existing payees + endorsements for this check with the latest snapshot.
      await supabase.from("check_payees").delete().eq("check_id", checkId);
      await supabase.from("check_endorsements").delete().eq("check_id", checkId);
      if (cleanedPayees.length > 0) {
        const payeeRows = cleanedPayees.map((p) => {
          const signedAt = resolveSignedAt(p);
          return {
          check_id: checkId,
          tenant_id: sourceTenantId,
          payee_name: toStandardCaps(p.payee_name.trim()),
          payee_type: normalizePayeeType(p.payee_type),
          endorsement_status: normalizePayeeStatus(p.endorsement_status, signedAt),
          endorsed_at: signedAt,
          contact_email: p.contact_email ?? null,
          contact_phone: p.contact_phone ?? null,
          };
        });
        const { error: payeeErr } = await supabase.from("check_payees").insert(payeeRows);
        if (payeeErr) console.warn("ingest-shared-check payee mirror failed", payeeErr);

        const endorsementRows = cleanedPayees.map((p) => {
          const signedAt = resolveSignedAt(p);
          return {
          check_id: checkId,
          tenant_id: sourceTenantId,
          payee_name: p.payee_name.trim(),
          payee_type: normalizePayeeType(p.payee_type),
          status: normalizeEndorsementStatus(p.endorsement_status, signedAt),
          signed_at: signedAt,
          contact_email: p.contact_email ?? null,
          contact_phone: p.contact_phone ?? null,
          };
        });
        const { error: endErr } = await supabase
          .from("check_endorsements")
          .insert(endorsementRows);
        if (endErr) console.warn("ingest-shared-check endorsement mirror failed", endErr);
      }
    }


    // Create the share (idempotent via unique constraint).
    // Skip for native-paired partners — they own the check directly, no mirror share needed.
    if (!isNativePaired) {
      const { error: shareErr } = await supabase
        .from("shared_checks")
        .upsert({
          check_id: checkId,
          source_tenant_id: sourceTenantId,
          target_tenant_id: targetTenantId,
          shared_by: "00000000-0000-0000-0000-000000000000",
          access_level: "read_only",
          revoked_at: null,
        }, { onConflict: "check_id,source_tenant_id,target_tenant_id" });
      if (shareErr) throw shareErr;
    }

    if (!initialPartnerStatus && body.source_app === "freedom_crm" && body.source_project_ref) {
      try {
        const statusPullUrl = `https://${body.source_project_ref}.supabase.co/functions/v1/push-check-status`;
        const pullResp = await fetch(statusPullUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer bridge-status-backfill",
            "x-bridge-secret": expected,
          },
          body: JSON.stringify({ check_id: body.source_check_id }),
        });

        if (!pullResp.ok) {
          const detail = await pullResp.text();
          console.warn("ingest-shared-check status backfill request failed", {
            status: pullResp.status,
            source_check_id: body.source_check_id,
            detail,
          });
        }
      } catch (statusPullError) {
        console.warn("ingest-shared-check status backfill request errored", {
          source_check_id: body.source_check_id,
          error: statusPullError instanceof Error ? statusPullError.message : String(statusPullError),
        });
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      check_id: checkId,
      target_tenant_id: targetTenantId,
      source_tenant_id: sourceTenantId,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error("ingest-shared-check error", e);
    return new Response(JSON.stringify({ error: e.message ?? String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
