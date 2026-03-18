import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { bucket, path } = await req.json();

    if (!bucket || !path) {
      return new Response(
        JSON.stringify({ error: "bucket and path are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log(`Backing up file: ${bucket}/${path}`);

    // Download the file from the source bucket
    const { data: fileData, error: downloadError } = await supabase.storage
      .from(bucket)
      .download(path);

    if (downloadError || !fileData) {
      console.error("Download error:", downloadError);

      // Update backup log with error
      await supabase
        .from("storage_backup_log")
        .update({
          status: "failed",
          error_message: downloadError?.message || "File not found",
          completed_at: new Date().toISOString(),
        })
        .eq("source_path", path)
        .eq("status", "pending");

      return new Response(
        JSON.stringify({ error: "Failed to download source file", details: downloadError?.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Upload to the backup bucket with the same path
    const backupBucket = `${bucket}-backup`;
    const { error: uploadError } = await supabase.storage
      .from(backupBucket)
      .upload(path, fileData, {
        contentType: fileData.type || "application/octet-stream",
        upsert: true, // overwrite if already backed up
      });

    if (uploadError) {
      console.error("Upload error:", uploadError);

      await supabase
        .from("storage_backup_log")
        .update({
          status: "failed",
          error_message: uploadError.message,
          completed_at: new Date().toISOString(),
        })
        .eq("source_path", path)
        .eq("status", "pending");

      return new Response(
        JSON.stringify({ error: "Failed to upload backup", details: uploadError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Update backup log with success
    await supabase
      .from("storage_backup_log")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
      })
      .eq("source_path", path)
      .eq("status", "pending");

    console.log(`Successfully backed up: ${bucket}/${path} → ${backupBucket}/${path}`);

    return new Response(
      JSON.stringify({ success: true, backed_up: `${backupBucket}/${path}` }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Backup error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
