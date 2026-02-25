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
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { claim_id, linked_workspace_id, partner_assignment } = await req.json();

    console.log(`Syncing claim ${claim_id} to partner workspace ${linked_workspace_id}`);

    // Get the linked workspace details
    const { data: linkedWorkspace, error: wsError } = await supabase
      .from("linked_workspaces")
      .select("*")
      .eq("id", linked_workspace_id)
      .single();

    if (wsError || !linkedWorkspace) {
      console.error("Linked workspace not found:", wsError);
      throw new Error("Linked workspace not found");
    }

    // Get the claim data
    const { data: claim, error: claimError } = await supabase
      .from("claims")
      .select("*")
      .eq("id", claim_id)
      .single();

    if (claimError || !claim) {
      console.error("Claim not found:", claimError);
      throw new Error("Claim not found");
    }

    // Fetch all related data
    const [
      { data: tasks },
      { data: updates },
      { data: inspections },
      { data: adjusters },
      { data: settlements },
      { data: checks },
      { data: expenses },
      { data: fees },
      { data: payments },
      { data: files },
      { data: photos },
      { data: emails },
    ] = await Promise.all([
      supabase.from("tasks").select("*").eq("claim_id", claim_id),
      supabase.from("claim_updates").select("*").eq("claim_id", claim_id),
      supabase.from("inspections").select("*").eq("claim_id", claim_id),
      supabase.from("claim_adjusters").select("*").eq("claim_id", claim_id),
      supabase.from("claim_settlements").select("*").eq("claim_id", claim_id),
      supabase.from("claim_checks").select("*").eq("claim_id", claim_id),
      supabase.from("claim_expenses").select("*").eq("claim_id", claim_id),
      supabase.from("claim_fees").select("*").eq("claim_id", claim_id),
      supabase.from("claim_payments").select("*").eq("claim_id", claim_id).eq("direction", "released"),
      supabase.from("claim_files").select("*").eq("claim_id", claim_id),
      supabase.from("claim_photos").select("*").eq("claim_id", claim_id),
      supabase.from("emails").select("*").eq("claim_id", claim_id),
    ]);

    console.log(`Fetched claim data: ${tasks?.length || 0} tasks, ${updates?.length || 0} updates, ${inspections?.length || 0} inspections`);

    // Generate signed URLs for files
    const filesWithUrls = [];
    if (files && files.length > 0) {
      for (const file of files) {
        try {
          const { data: signedUrlData } = await supabase.storage
            .from('claim-files')
            .createSignedUrl(file.file_path, 3600);
          
          filesWithUrls.push({
            ...file,
            signed_url: signedUrlData?.signedUrl,
          });
        } catch {
          filesWithUrls.push(file);
        }
      }
    }

    // Generate signed URLs for photos
    const photosWithUrls = [];
    if (photos && photos.length > 0) {
      for (const photo of photos) {
        try {
          const { data: signedUrlData } = await supabase.storage
            .from('claim-files')
            .createSignedUrl(photo.file_path, 3600);
          
          photosWithUrls.push({
            ...photo,
            signed_url: signedUrlData?.signedUrl,
          });
        } catch {
          photosWithUrls.push(photo);
        }
      }
    }

    // Send to partner instance
    console.log(`Sending claim to ${linkedWorkspace.external_instance_url}`);
    
    const response = await fetch(`${linkedWorkspace.external_instance_url}/functions/v1/claim-sync-webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-claim-sync-secret": linkedWorkspace.sync_secret,
      },
      body: JSON.stringify({
        action: "create_or_update",
        claim_data: claim,
        external_claim_id: claim.id,
        source_instance_url: supabaseUrl,
        target_workspace_id: linkedWorkspace.target_workspace_id,
        tasks_data: tasks || [],
        updates_data: updates || [],
        inspections_data: inspections || [],
        adjusters_data: adjusters || [],
        accounting_data: {
          settlements: settlements || [],
          checks: checks || [],
          expenses: expenses || [],
          fees: fees || [],
          payments: payments || [],
        },
        files_data: filesWithUrls,
        photos_data: photosWithUrls,
        emails_data: emails || [],
        partner_assignment: partner_assignment || null,
      }),
    });

    const responseText = await response.text();
    console.log(`Partner response: status=${response.status}, body=${responseText}`);

    if (!response.ok) {
      console.error(`Sync failed: ${responseText}`);
      throw new Error(`Sync failed: ${responseText}`);
    }

    // Update last synced timestamp
    await supabase
      .from("linked_workspaces")
      .update({ last_synced_at: new Date().toISOString() })
      .eq("id", linked_workspace_id);

    // Log the sync
    await supabase.from("claim_updates").insert({
      claim_id: claim_id,
      content: `Claim synced to partner: ${linkedWorkspace.instance_name}`,
      update_type: "partner_sync",
    });

    return new Response(
      JSON.stringify({ success: true, message: "Claim synced to partner" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("Error syncing claim to partner:", error);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
