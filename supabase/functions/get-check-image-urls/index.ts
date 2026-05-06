import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CLAIM_FILES_BUCKET = "claim-files";

function toStorageObjectPath(value: string | null | undefined, bucket = CLAIM_FILES_BUCKET): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;

  if (!/^https?:\/\//i.test(v)) {
    return v.replace(new RegExp(`^${bucket}/`), "");
  }

  try {
    const url = new URL(v);
    const match = url.pathname.match(/\/storage\/v1\/object\/(?:sign\/|public\/)?([^/]+)\/(.+)$/);
    if (match && match[1] === bucket) {
      return decodeURIComponent(match[2]);
    }
    return null;
  } catch {
    return null;
  }
}

function getFileExtensionFromPath(value: string | null | undefined, fallback = "jpg") {
  if (!value) return fallback;
  const clean = value.split("?")[0];
  const lastSegment = clean.split("/").pop() ?? "";
  const ext = lastSegment.includes(".") ? lastSegment.split(".").pop() : "";
  return (ext || fallback).toLowerCase();
}

async function objectExists(admin: ReturnType<typeof createClient>, path: string) {
  const parts = path.split("/");
  const fileName = parts.pop();
  const folder = parts.join("/");
  if (!fileName) return false;

  const { data, error } = await admin.storage.from(CLAIM_FILES_BUCKET).list(folder, {
    search: fileName,
    limit: 100,
  });
  if (error) return false;
  return (data ?? []).some((item) => item.name === fileName);
}

async function repairLegacyUrlIfNeeded(
  admin: ReturnType<typeof createClient>,
  checkId: string,
  side: "front" | "back",
  originalValue: string | null,
) {
  if (!originalValue || !/^https?:\/\//i.test(originalValue)) return null;

  const ext = getFileExtensionFromPath(originalValue);
  const targetPath = `checks/${checkId}/${side}-legacy-${Date.now()}.${ext}`;
  const response = await fetch(originalValue);
  if (!response.ok) {
    throw new Error(`Legacy ${side} image could not be fetched`);
  }

  const contentType = response.headers.get("content-type") ?? `image/${ext === "jpg" ? "jpeg" : ext}`;
  const bytes = new Uint8Array(await response.arrayBuffer());

  const { error: uploadError } = await admin.storage.from(CLAIM_FILES_BUCKET).upload(targetPath, bytes, {
    upsert: true,
    contentType,
    cacheControl: "31536000",
  });
  if (uploadError) {
    throw new Error(uploadError.message || `Legacy ${side} image upload failed`);
  }

  const column = side === "front" ? "front_image_path" : "back_image_path";
  const { error: updateError } = await admin
    .from("check_intake_items")
    .update({ [column]: targetPath })
    .eq("id", checkId);
  if (updateError) {
    throw new Error(updateError.message || `Legacy ${side} image path update failed`);
  }

  await admin.from("check_audit_log").insert({
    check_id: checkId,
    event_type: `legacy_${side}_image_repaired`,
    event_description: `Legacy ${side} check image was copied into the current storage backend`,
    event_data: {
      old_path: originalValue,
      new_path: targetPath,
    },
  });

  return targetPath;
}

async function getUserAccessContext(admin: ReturnType<typeof createClient>, userId: string) {
  const [{ data: memberships, error: membershipError }, { data: roles, error: roleError }] = await Promise.all([
    admin
      .from("tenant_users")
      .select("tenant_id")
      .eq("user_id", userId),
    admin
      .from("user_roles")
      .select("role")
      .eq("user_id", userId),
  ]);

  if (membershipError) throw membershipError;
  if (roleError) throw roleError;

  return {
    tenantIds: Array.from(new Set((memberships ?? []).map((row) => row.tenant_id).filter(Boolean))),
    isPrivileged: (roles ?? []).some((row) => row.role === "admin" || row.role === "staff"),
  };
}

async function userCanAccessCheck(
  admin: ReturnType<typeof createClient>,
  userId: string,
  checkId: string,
  checkTenantId: string | null,
) {
  const { tenantIds, isPrivileged } = await getUserAccessContext(admin, userId);

  if (isPrivileged) return true;
  if (checkTenantId && tenantIds.includes(checkTenantId)) return true;
  if (tenantIds.length === 0) return false;

  const { data: sharedCheck, error: shareError } = await admin
    .from("shared_checks")
    .select("id")
    .eq("check_id", checkId)
    .in("target_tenant_id", tenantIds)
    .is("revoked_at", null)
    .limit(1)
    .maybeSingle();

  if (shareError) throw shareError;
  return !!sharedCheck;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const checkId = body?.checkId as string | undefined;
    if (!checkId) {
      return new Response(JSON.stringify({ error: "Missing checkId" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: check, error: checkError } = await admin
      .from("check_intake_items")
      .select("id, tenant_id, check_number, front_image_path, back_image_path")
      .eq("id", checkId)
      .maybeSingle();
    if (checkError) throw checkError;
    if (!check) {
      return new Response(JSON.stringify({ error: "Check not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const canAccess = await userCanAccessCheck(admin, authData.user.id, checkId, check.tenant_id ?? null);
    if (!canAccess) {
      return new Response(JSON.stringify({ error: "Check not accessible" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let frontPath = toStorageObjectPath(check.front_image_path);
    let backPath = toStorageObjectPath(check.back_image_path);

    if (frontPath && !(await objectExists(admin, frontPath))) {
      frontPath = await repairLegacyUrlIfNeeded(admin, check.id, "front", check.front_image_path);
    }
    if (backPath && !(await objectExists(admin, backPath))) {
      backPath = await repairLegacyUrlIfNeeded(admin, check.id, "back", check.back_image_path);
    }

    const sign = async (path: string | null) => {
      if (!path) return null;
      const { data, error } = await admin.storage.from(CLAIM_FILES_BUCKET).createSignedUrl(path, 3600);
      if (error) throw new Error(error.message || "Failed to sign image URL");
      return data?.signedUrl ?? null;
    };

    const [frontUrl, backUrl] = await Promise.all([sign(frontPath), sign(backPath)]);

    return new Response(
      JSON.stringify({
        checkId: check.id,
        checkNumber: check.check_number,
        frontUrl,
        backUrl,
        frontPath,
        backPath,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("get-check-image-urls error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message || "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});