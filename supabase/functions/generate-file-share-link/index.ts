import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const MIN_EXPIRES = 60;        // 1 minute
const MAX_EXPIRES = 604800;    // 7 days
const DEFAULT_EXPIRES = 86400; // 24 hours

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Verify user via getClaims (required for signing-keys auth)
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await userClient.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Safe JSON parse
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const fileId = typeof body.file_id === "string" ? body.file_id.trim() : "";
    if (!fileId) {
      return new Response(
        JSON.stringify({ error: "file_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Clamp expires_in
    const rawExpires = typeof body.expires_in === "number" ? body.expires_in : DEFAULT_EXPIRES;
    const expiresIn = Math.min(MAX_EXPIRES, Math.max(MIN_EXPIRES, Math.floor(rawExpires)));

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Look up the file
    const { data: file, error: fileError } = await adminClient
      .from("claim_files")
      .select("id, file_name, file_path, claim_id")
      .eq("id", fileId)
      .single();

    if (fileError || !file) {
      return new Response(
        JSON.stringify({ error: "File not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Sanitise file_path: strip any leading slash or accidental bucket prefix
    let storagePath = file.file_path || "";
    if (storagePath.startsWith("/")) storagePath = storagePath.slice(1);
    const bucketPrefix = "claim-files/";
    if (storagePath.startsWith(bucketPrefix)) storagePath = storagePath.slice(bucketPrefix.length);
    // Reject unsafe or empty paths
    if (!storagePath || storagePath.includes("..") || /^https?:\/\//i.test(storagePath)) {
      return new Response(
        JSON.stringify({ error: "Invalid storage path" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // RLS claim-access check — user must be able to see the claim
    const { data: claim, error: claimError } = await userClient
      .from("claims")
      .select("id")
      .eq("id", file.claim_id)
      .maybeSingle();

    if (claimError || !claim) {
      return new Response(
        JSON.stringify({ error: "You do not have access to this file" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Generate signed URL using service-role client (bypasses storage RLS)
    const { data: signedUrlData, error: signedUrlError } = await adminClient.storage
      .from("claim-files")
      .createSignedUrl(storagePath, expiresIn);

    if (signedUrlError || !signedUrlData?.signedUrl) {
      console.error("Signed URL error:", signedUrlError);
      return new Response(
        JSON.stringify({ error: "Failed to generate share link" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        signed_url: signedUrlData.signedUrl,
        file_name: file.file_name,
        expires_in: expiresIn,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Error in generate-file-share-link:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
