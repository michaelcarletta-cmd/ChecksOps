const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { minLng, minLat, maxLng, maxLat, width, height } = await req.json();

    if (
      typeof minLng !== "number" ||
      typeof minLat !== "number" ||
      typeof maxLng !== "number" ||
      typeof maxLat !== "number"
    ) {
      throw new Error("Invalid bounds");
    }

    const imgW = typeof width === "number" ? width : 1000;
    const imgH = typeof height === "number" ? height : 700;

    const bbox = `${minLng},${minLat},${maxLng},${maxLat}`;
    const size = `${imgW},${imgH}`;

    const esriUrl =
      `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export` +
      `?bbox=${encodeURIComponent(bbox)}` +
      `&bboxSR=4326` +
      `&imageSR=4326` +
      `&size=${encodeURIComponent(size)}` +
      `&format=png32` +
      `&transparent=false` +
      `&f=image`;

    const res = await fetch(esriUrl, {
      headers: {
        "User-Agent": "DarwinRoofEditor/1.0",
      },
    });

    if (!res.ok) {
      throw new Error(`Aerial image fetch failed: ${res.status}`);
    }

    const contentType = res.headers.get("content-type") || "image/png";
    const bytes = new Uint8Array(await res.arrayBuffer());

    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    const dataUrl = `data:${contentType};base64,${base64}`;

    return new Response(
      JSON.stringify({
        success: true,
        data_url: dataUrl,
        source_url: esriUrl,
      }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      }),
      {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});
