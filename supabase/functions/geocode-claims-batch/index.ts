import { createClient } from "npm:@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Get claims that need geocoding (have address but no coordinates)
    const { data: claims, error: fetchError } = await supabase
      .from("claims")
      .select("id, policyholder_address")
      .is("latitude", null)
      .not("policyholder_address", "is", null)
      .neq("policyholder_address", "")
      .order("created_at", { ascending: false })
      .limit(25); // Process 25 at a time to stay within rate limits

    if (fetchError) {
      console.error("Error fetching claims:", fetchError);
      return new Response(
        JSON.stringify({ error: fetchError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!claims || claims.length === 0) {
      return new Response(
        JSON.stringify({ message: "No claims need geocoding", processed: 0 }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Processing ${claims.length} claims for geocoding`);

    let successCount = 0;
    let failCount = 0;

    for (const claim of claims) {
      try {
        let fullAddress = claim.policyholder_address?.trim();
        if (!fullAddress) continue;

        // Clean up address format
        fullAddress = fullAddress.replace(/(\w)\s+([A-Z]{2})\s*,?\s*(\d{5})/g, '$1, $2 $3');
        fullAddress = fullAddress.replace(/(\w)\s+([A-Z]{2}),/g, '$1, $2,');

        const searchAddress = fullAddress.includes('USA') || fullAddress.includes('United States') 
          ? fullAddress 
          : `${fullAddress}, USA`;

        // Use OpenStreetMap Nominatim for geocoding
        const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchAddress)}&limit=1&countrycodes=us`;

        const geoResponse = await fetch(nominatimUrl, {
          headers: {
            "User-Agent": "FreedomClaimsCRM/1.0 (contact@freedomadj.com)",
            "Accept": "application/json",
          },
        });

        if (!geoResponse.ok) {
          console.warn(`Geocoding failed for claim ${claim.id}: ${geoResponse.status}`);
          failCount++;
          continue;
        }

        const geoData = await geoResponse.json();

        if (!geoData || geoData.length === 0) {
          // Try simplified search with just street and zip
          const zipMatch = fullAddress.match(/\d{5}/);
          const streetMatch = fullAddress.match(/^\d+\s+[^,]+/);
          
          if (zipMatch && streetMatch) {
            const simpleAddress = `${streetMatch[0]}, ${zipMatch[0]}, USA`;
            const retryUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(simpleAddress)}&limit=1&countrycodes=us`;
            
            const retryResponse = await fetch(retryUrl, {
              headers: {
                "User-Agent": "FreedomClaimsCRM/1.0 (contact@freedomadj.com)",
                "Accept": "application/json",
              },
            });
            
            if (retryResponse.ok) {
              const retryData = await retryResponse.json();
              if (retryData && retryData.length > 0) {
                const { lat, lon } = retryData[0];
                await supabase
                  .from("claims")
                  .update({ 
                    latitude: parseFloat(lat), 
                    longitude: parseFloat(lon), 
                    geocoded_at: new Date().toISOString() 
                  })
                  .eq("id", claim.id);
                successCount++;
                continue;
              }
            }
          }
          
          console.warn(`No geocode results for claim ${claim.id}: ${fullAddress}`);
          failCount++;
          continue;
        }

        const { lat, lon } = geoData[0];
        const latitude = parseFloat(lat);
        const longitude = parseFloat(lon);

        const { error: updateError } = await supabase
          .from("claims")
          .update({
            latitude,
            longitude,
            geocoded_at: new Date().toISOString(),
          })
          .eq("id", claim.id);

        if (updateError) {
          console.error(`Failed to update claim ${claim.id}:`, updateError);
          failCount++;
        } else {
          console.log(`Geocoded claim ${claim.id}: ${latitude}, ${longitude}`);
          successCount++;
        }

        // Rate limit: 1 request per second for Nominatim
        await new Promise(r => setTimeout(r, 1100));
      } catch (error) {
        console.error(`Error processing claim ${claim.id}:`, error);
        failCount++;
      }
    }

    return new Response(
      JSON.stringify({
        message: "Batch geocoding complete",
        processed: claims.length,
        success: successCount,
        failed: failCount,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Batch geocode error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
