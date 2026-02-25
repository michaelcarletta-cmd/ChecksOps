import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const token = authHeader.replace("Bearer ", "");
    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { claimId } = await req.json();

    if (!claimId) {
      return new Response(
        JSON.stringify({ error: "claimId is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch the claim to get the address
    const { data: claim, error: claimError } = await supabase
      .from("claims")
      .select("id, policyholder_address, latitude, longitude")
      .eq("id", claimId)
      .single();

    if (claimError || !claim) {
      return new Response(
        JSON.stringify({ error: "Claim not found", details: claimError?.message }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Use the full address field directly, clean it up for geocoding
    let fullAddress = claim.policyholder_address?.trim();

    if (!fullAddress) {
      return new Response(
        JSON.stringify({ success: false, message: "No address available for geocoding" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Clean up address format - add comma before state if missing
    // Pattern: "City ST" -> "City, ST" (e.g., "Manahawkin NJ" -> "Manahawkin, NJ")
    fullAddress = fullAddress.replace(/(\w)\s+([A-Z]{2})\s*,?\s*(\d{5})/g, '$1, $2 $3');
    
    // Also handle "City ST, ZIP" format
    fullAddress = fullAddress.replace(/(\w)\s+([A-Z]{2}),/g, '$1, $2,');

    // Append USA for better geocoding accuracy
    const searchAddress = fullAddress.includes('USA') || fullAddress.includes('United States') 
      ? fullAddress 
      : `${fullAddress}, USA`;

    console.log("Geocoding address:", searchAddress);

    // Use OpenStreetMap Nominatim for geocoding (free, no API key required)
    const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchAddress)}&limit=1&countrycodes=us`;

    const geoResponse = await fetch(nominatimUrl, {
      headers: {
        "User-Agent": "FreedomClaimsCRM/1.0 (contact@freedomadj.com)",
        "Accept": "application/json",
      },
    });

    if (!geoResponse.ok) {
      console.error("Nominatim error:", geoResponse.status, await geoResponse.text());
      return new Response(
        JSON.stringify({ success: false, message: "Geocoding service unavailable" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const geoData = await geoResponse.json();
    console.log("Geocode result:", JSON.stringify(geoData));

    if (!geoData || geoData.length === 0) {
      // Try a simplified search with just street number, street name, and zip
      const zipMatch = fullAddress.match(/\d{5}/);
      const streetMatch = fullAddress.match(/^\d+\s+[^,]+/);
      
      if (zipMatch && streetMatch) {
        const simpleAddress = `${streetMatch[0]}, ${zipMatch[0]}, USA`;
        console.log("Retrying with simplified address:", simpleAddress);
        
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
            const latitude = parseFloat(lat);
            const longitude = parseFloat(lon);
            
            const { error: updateError } = await supabase
              .from("claims")
              .update({ latitude, longitude, geocoded_at: new Date().toISOString() })
              .eq("id", claimId);

            if (updateError) {
              return new Response(
                JSON.stringify({ success: false, message: "Failed to update claim coordinates" }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
              );
            }

            return new Response(
              JSON.stringify({ success: true, latitude, longitude, address: fullAddress }),
              { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
        }
      }
      
      return new Response(
        JSON.stringify({ success: false, message: `Address could not be geocoded: ${fullAddress}` }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { lat, lon } = geoData[0];
    const latitude = parseFloat(lat);
    const longitude = parseFloat(lon);

    // Update the claim with coordinates
    const { error: updateError } = await supabase
      .from("claims")
      .update({
        latitude,
        longitude,
        geocoded_at: new Date().toISOString(),
      })
      .eq("id", claimId);

    if (updateError) {
      return new Response(
        JSON.stringify({ success: false, message: "Failed to update claim coordinates", details: updateError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        latitude,
        longitude,
        address: fullAddress,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Geocode error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: "Internal server error", details: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
